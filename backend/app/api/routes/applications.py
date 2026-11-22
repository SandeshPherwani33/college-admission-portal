from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse

from app.api.routes.dependencies import require_roles
from app.database.document_storage import get_document_storage
from app.database.store import DuplicateApplicationError, get_store
from app.eligibility.matcher import match_programs
from app.schemas.application import (
    ApplicationCreateRequest,
    ExternalApplicationIntentRequest,
    ApplicationListResponse,
    ApplicationResponse,
    ApplicationSubmitRequest,
    ApplicationUpdateRequest,
    UniversityApplicationUpdateRequest,
    UniversityDocumentReviewRequest,
)
from app.schemas.eligibility import ProgramCriteria

router = APIRouter(tags=["applications"])


def _institution_id(current_user: dict) -> str:
    institution_id = current_user.get("institution_id")
    if not isinstance(institution_id, str) or not institution_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This university account is not assigned to an institution.",
        )
    return institution_id


def _program_criteria(program_id: str) -> ProgramCriteria:
    record = next(
        (item for item in get_store().get_program_criteria() if item["program_id"] == program_id),
        None,
    )
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Program not found.")
    return ProgramCriteria.model_validate(record)


def _eligibility(student_id: str, criteria: ProgramCriteria) -> dict:
    store = get_store()
    profile = store.get_profile(student_id)
    documents = store.list_documents(student_id)
    return match_programs(profile, [criteria], documents)[0]


def _owned_assignments(student_id: str, assignments: dict[str, str]) -> dict[str, str]:
    store = get_store()
    documents = {item["document_id"]: item for item in store.list_documents(student_id)}
    if len(set(assignments.values())) != len(assignments):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A document can only be assigned to one document type.",
        )
    for document_type, document_id in assignments.items():
        document = documents.get(document_id)
        if document is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="One or more assigned documents were not found.",
            )
        if document.get("document_type") != document_type:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Assigned document type does not match the uploaded document type.",
            )
    return assignments


def _application_documents(student_id: str, assignments: dict[str, str]) -> list[dict]:
    store = get_store()
    documents_by_id = {
        item["document_id"]: item for item in store.list_documents(student_id)
    }
    return [
        {
            "document_id": document_id,
            "filename": documents_by_id[document_id]["filename"],
            "document_type": document_type,
            "verification_status": documents_by_id[document_id].get(
                "verification_status", "not_verified"
            ),
            "created_at": documents_by_id[document_id].get("created_at"),
            "reviewed_at": documents_by_id[document_id].get("reviewed_at"),
        }
        for document_type, document_id in assignments.items()
    ]


def _application_requirements(
    criteria: ProgramCriteria,
    assigned_documents: list[dict],
) -> list[dict]:
    by_type = {item["document_type"]: item for item in assigned_documents}
    requirements = []
    for requirement in criteria.required_documents:
        document = by_type.get(requirement.document_type)
        if document is None:
            requirement_status = "missing" if requirement.required else "not_applicable"
            documents = []
        else:
            requirement_status = (
                "completed"
                if document["verification_status"] == "verified"
                else "pending_verification"
            )
            documents = [document]
        requirements.append(
            {
                "document_type": requirement.document_type,
                "label": requirement.label,
                "required": requirement.required,
                "status": requirement_status,
                "documents": documents,
            }
        )
    return requirements


def _refresh_application(application: dict) -> dict:
    if application.get("source") == "external_application":
        application["documents"] = []
        application["requirements"] = []
        application["requirements_complete"] = True
        return application
    criteria = _program_criteria(application["program_id"])
    application["documents"] = _application_documents(
        application["student_id"], application.get("document_assignments", {})
    )
    application["requirements"] = _application_requirements(
        criteria, application["documents"]
    )
    required = [item for item in application["requirements"] if item["required"]]
    application["requirements_complete"] = all(
        item["status"] in {"completed", "pending_verification"} for item in required
    )
    return application


def _student_view(application: dict) -> dict:
    response = dict(application)
    response["status_history"] = [
        {
            **event,
            "note": event.get("note") if event.get("actor") == application["student_id"] else None,
        }
        for event in application.get("status_history", [])
    ]
    return response


def _raise_application_unavailable(eligibility: dict, mode: str = "direct") -> None:
    if eligibility["criteria_status"] != "verified":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Applications are unavailable until the institution provides verified criteria.",
        )
    if eligibility["application_mode"] != mode:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This program does not accept applications through this workflow.",
        )
    if eligibility["eligibility_status"] != "eligible":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The profile does not currently meet the verified eligibility criteria.",
        )


@router.get("/applications", response_model=ApplicationListResponse)
def list_student_applications(current_user: dict = Depends(require_roles("student"))):
    applications = get_store().list_student_applications(current_user["id"])
    applications = [_refresh_application(application) for application in applications]
    return {"applications": [_student_view(item) for item in applications], "total": len(applications)}


@router.post(
    "/applications",
    response_model=ApplicationResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_student_application(
    payload: ApplicationCreateRequest,
    current_user: dict = Depends(require_roles("student")),
):
    store = get_store()
    criteria = _program_criteria(payload.program_id)
    eligibility = _eligibility(current_user["id"], criteria)
    _raise_application_unavailable(eligibility)
    assignments = _owned_assignments(
        current_user["id"], payload.document_assignments
    )
    profile = store.get_profile(current_user["id"])
    now = datetime.now(timezone.utc).isoformat()
    applicant_details = payload.applicant_details
    if applicant_details is None:
        applicant_details = {
            "full_name": profile["full_name"],
            "email": profile["email"],
            "phone": profile.get("phone"),
            "location": profile.get("location"),
        }
    application = {
        "application_id": f"application-{uuid4().hex}",
        "reference_id": None,
        "student_id": current_user["id"],
        "institution_id": criteria.institution_id,
        "institution": criteria.institution,
        "program_id": criteria.program_id,
        "program": criteria.program,
        "admission_cycle": criteria.application_cycle,
        "status": "draft",
        "applicant_details": applicant_details,
        "document_assignments": assignments,
        "documents": [],
        "requirements": [],
        "requirements_complete": False,
        "requested_documents": [],
        "status_history": [
            {"status": "draft", "actor": current_user["id"], "note": None, "created_at": now}
        ],
        "source": "direct_application",
        "application_deadline": criteria.application_deadline,
        "application_fee": criteria.application_fee,
        "consented_at": None,
        "created_at": now,
        "updated_at": now,
        "submitted_at": None,
    }
    application = _refresh_application(application)
    try:
        saved = store.create_application(application)
    except DuplicateApplicationError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return ApplicationResponse.model_validate(_student_view(saved))


@router.post(
    "/applications/external-intent",
    response_model=ApplicationResponse,
    status_code=status.HTTP_201_CREATED,
)
def record_external_application_intent(
    payload: ExternalApplicationIntentRequest,
    current_user: dict = Depends(require_roles("student")),
):
    if payload.official_application_url is not None:
        if payload.official_application_url.scheme != "https":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Official application URLs must use HTTPS.",
            )
    if payload.official_website is not None:
        if payload.official_website.scheme != "https":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Official website URLs must use HTTPS.",
            )

    store = get_store()
    profile = store.get_profile(current_user["id"])
    now = datetime.now(timezone.utc).isoformat()
    slug = f"{payload.exam}-{payload.institution}-{payload.programme}".casefold()
    program_id = "external-" + "".join(
        character.lower() if character.isalnum() else "-"
        for character in slug
    ).strip("-")[:90]
    existing = next(
        (
            item
            for item in store.list_student_applications(current_user["id"])
            if item.get("source") == "external_application"
            and item.get("program_id") == program_id
            and item.get("admission_cycle") == payload.admission_cycle
        ),
        None,
    )
    if existing is not None:
        if existing["status"] == "withdrawn":
            previous_updated_at = existing["updated_at"]
            existing["status"] = "application_started"
            existing["updated_at"] = now
            existing["status_history"].append(
                {
                    "status": "application_started",
                    "actor": current_user["id"],
                    "note": "Student reopened the external official application portal.",
                    "created_at": now,
                }
            )
            updated = store.update_application(existing["application_id"], previous_updated_at, existing)
            if updated is None:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Application changed; reload before updating.")
            return ApplicationResponse.model_validate(_student_view(updated))
        return ApplicationResponse.model_validate(_student_view(existing))

    application = {
        "application_id": f"application-{uuid4().hex}",
        "reference_id": None,
        "student_id": current_user["id"],
        "institution_id": f"external-{payload.exam.casefold().replace(' ', '-')}",
        "institution": payload.institution,
        "program_id": program_id,
        "program": payload.programme,
        "admission_cycle": payload.admission_cycle,
        "status": "application_started",
        "applicant_details": {
            "full_name": profile["full_name"],
            "email": profile["email"],
            "phone": profile.get("phone"),
            "location": profile.get("location"),
        },
        "document_assignments": {},
        "documents": [],
        "requirements": [],
        "requirements_complete": True,
        "requested_documents": [],
        "status_history": [
            {
                "status": "application_started",
                "actor": current_user["id"],
                "note": "Student opened the external official application portal.",
                "created_at": now,
            }
        ],
        "source": "external_application",
        "application_deadline": None,
        "application_fee": None,
        "official_application_url": str(payload.official_application_url) if payload.official_application_url else None,
        "official_website": str(payload.official_website) if payload.official_website else None,
        "admission_exam": payload.exam,
        "consented_at": None,
        "created_at": now,
        "updated_at": now,
        "submitted_at": None,
    }
    try:
        saved = store.create_application(application)
    except DuplicateApplicationError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return ApplicationResponse.model_validate(_student_view(saved))


@router.get("/applications/{application_id}", response_model=ApplicationResponse)
def get_student_application(
    application_id: str,
    current_user: dict = Depends(require_roles("student")),
):
    application = get_store().get_application(
        application_id, student_id=current_user["id"]
    )
    if application is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Application not found.")
    return ApplicationResponse.model_validate(_student_view(_refresh_application(application)))


@router.patch("/applications/{application_id}", response_model=ApplicationResponse)
def update_student_application(
    application_id: str,
    payload: ApplicationUpdateRequest,
    current_user: dict = Depends(require_roles("student")),
):
    store = get_store()
    application = store.get_application(application_id, student_id=current_user["id"])
    if application is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Application not found.")
    if application["status"] not in {"draft", "documents_requested"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only draft applications or applications requesting documents can be edited.",
        )
    previous_updated_at = application["updated_at"]
    updates = {}
    if payload.document_assignments is not None:
        updates["document_assignments"] = _owned_assignments(
            current_user["id"], payload.document_assignments
        )
    if payload.applicant_details is not None:
        updates["applicant_details"] = payload.applicant_details.model_dump()
    application.update(updates)
    application = _refresh_application(application)
    application["updated_at"] = datetime.now(timezone.utc).isoformat()
    updated = store.update_application(application_id, previous_updated_at, application)
    if updated is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Application changed; reload before editing.")
    return ApplicationResponse.model_validate(_student_view(updated))


@router.post(
    "/applications/{application_id}/submit",
    response_model=ApplicationResponse,
)
def submit_student_application(
    application_id: str,
    payload: ApplicationSubmitRequest,
    current_user: dict = Depends(require_roles("student")),
):
    store = get_store()
    application = store.get_application(application_id, student_id=current_user["id"])
    if application is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Application not found.")
    if application["status"] not in {"draft", "documents_requested"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only draft applications or applications requesting documents can be submitted.",
        )
    criteria = _program_criteria(application["program_id"])
    eligibility = _eligibility(current_user["id"], criteria)
    _raise_application_unavailable(eligibility)
    application = _refresh_application(application)
    if not application["requirements_complete"]:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="All required documents must be assigned before submission.",
        )
    assigned = {item["document_type"]: item for item in application["documents"]}
    if any(
        document_type not in assigned
        for document_type in application["requested_documents"]
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="All documents requested by the institution must be assigned before resubmission.",
        )
    previous_updated_at = application["updated_at"]
    now = datetime.now(timezone.utc).isoformat()
    was_resubmission = application["status"] == "documents_requested"
    application.update(
        {
            "status": "submitted",
            "reference_id": application["reference_id"]
            or f"UA-{criteria.application_cycle}-{uuid4().hex[:10].upper()}",
            "consented_at": now,
            "submitted_at": now,
            "updated_at": now,
            "status_history": [
                *application["status_history"],
                {
                    "status": "submitted",
                    "actor": current_user["id"],
                    "note": (
                        "Student supplied the requested documents and confirmed consent."
                        if was_resubmission
                        else "Student confirmed application consent."
                    ),
                    "created_at": now,
                },
            ],
        }
    )
    updated = store.update_application(application_id, previous_updated_at, application)
    if updated is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Application changed; reload before submitting.")
    return ApplicationResponse.model_validate(_student_view(updated))


@router.post(
    "/applications/{application_id}/confirm-external-submission",
    response_model=ApplicationResponse,
)
def confirm_external_application_submission(
    application_id: str,
    current_user: dict = Depends(require_roles("student")),
):
    store = get_store()
    application = store.get_application(application_id, student_id=current_user["id"])
    if application is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Application not found.")
    if application.get("source") != "external_application":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only external application intents can be marked as submitted here.",
        )
    if application["status"] in {"submitted", "withdrawn"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This external application status cannot be changed.")

    previous_updated_at = application["updated_at"]
    now = datetime.now(timezone.utc).isoformat()
    application["status"] = "submitted"
    application["submitted_at"] = now
    application["consented_at"] = now
    application["updated_at"] = now
    application["status_history"].append(
        {
            "status": "submitted",
            "actor": current_user["id"],
            "note": "Student explicitly confirmed that the external application was submitted.",
            "created_at": now,
        }
    )
    updated = store.update_application(application_id, previous_updated_at, application)
    if updated is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Application changed; reload before confirming.")
    return ApplicationResponse.model_validate(_student_view(updated))


@router.post("/applications/{application_id}/withdraw", response_model=ApplicationResponse)
def withdraw_student_application(
    application_id: str,
    current_user: dict = Depends(require_roles("student")),
):
    store = get_store()
    application = store.get_application(application_id, student_id=current_user["id"])
    if application is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Application not found.")
    if application["status"] in {"accepted", "rejected", "withdrawn"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This application can no longer be withdrawn.")
    previous_updated_at = application["updated_at"]
    now = datetime.now(timezone.utc).isoformat()
    application["status"] = "withdrawn"
    application["updated_at"] = now
    application["status_history"].append(
        {"status": "withdrawn", "actor": current_user["id"], "note": None, "created_at": now}
    )
    updated = store.update_application(application_id, previous_updated_at, application)
    if updated is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Application changed; reload before withdrawing.")
    return ApplicationResponse.model_validate(_student_view(_refresh_application(updated)))


@router.get("/university/applications", response_model=ApplicationListResponse)
def list_institution_applications(
    current_user: dict = Depends(require_roles("university")),
):
    institution_id = _institution_id(current_user)
    applications = get_store().list_institution_applications(institution_id)
    applications = [_refresh_application(application) for application in applications]
    return {"applications": applications, "total": len(applications)}


@router.get(
    "/university/applications/{application_id}",
    response_model=ApplicationResponse,
)
def get_institution_application(
    application_id: str,
    current_user: dict = Depends(require_roles("university")),
):
    application = get_store().get_application(
        application_id, institution_id=_institution_id(current_user)
    )
    if application is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Application not found.")
    return ApplicationResponse.model_validate(_refresh_application(application))


@router.patch(
    "/university/applications/{application_id}",
    response_model=ApplicationResponse,
)
def review_institution_application(
    application_id: str,
    payload: UniversityApplicationUpdateRequest,
    current_user: dict = Depends(require_roles("university")),
):
    store = get_store()
    institution_id = _institution_id(current_user)
    application = store.get_application(application_id, institution_id=institution_id)
    if application is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Application not found.")
    allowed_transitions = {
        "submitted": {"under_review", "documents_requested", "shortlisted", "rejected"},
        "under_review": {"documents_requested", "shortlisted", "accepted", "rejected"},
        "documents_requested": {"under_review", "shortlisted", "rejected"},
        "shortlisted": {"accepted", "rejected"},
    }
    if payload.status not in allowed_transitions.get(application["status"], set()):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot change application status from {application['status']} to {payload.status}.",
        )
    if payload.status == "documents_requested":
        criteria = _program_criteria(application["program_id"])
        required_types = {item.document_type for item in criteria.required_documents}
        if not set(payload.requested_documents).issubset(required_types):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Requested documents must be listed in the program's requirements.",
            )
    previous_updated_at = application["updated_at"]
    now = datetime.now(timezone.utc).isoformat()
    application["status"] = payload.status
    application["requested_documents"] = payload.requested_documents
    application["updated_at"] = now
    application["status_history"].append(
        {
            "status": payload.status,
            "actor": institution_id,
            "note": payload.note,
            "created_at": now,
        }
    )
    updated = store.update_application(application_id, previous_updated_at, application)
    if updated is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Application changed; reload before reviewing.")
    return ApplicationResponse.model_validate(_refresh_application(updated))


@router.get(
    "/university/applications/{application_id}/documents/{document_id}/content"
)
def get_institution_application_document(
    application_id: str,
    document_id: str,
    current_user: dict = Depends(require_roles("university")),
):
    store = get_store()
    application = store.get_application(
        application_id, institution_id=_institution_id(current_user)
    )
    if application is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Application not found.")
    if document_id not in application.get("document_assignments", {}).values():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")
    document = store.get_document(document_id, application["student_id"])
    if document is None or not document.get("storage_key"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document content is unavailable.")
    try:
        path: Path | None = get_document_storage().get_path(document["storage_key"])
    except (OSError, RuntimeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Private document storage is unavailable.",
        ) from exc
    if path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document content is unavailable.")
    return FileResponse(
        path,
        media_type=document["content_type"],
        filename=document["filename"],
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
        },
    )


@router.patch(
    "/university/applications/{application_id}/documents/{document_id}/verification",
)
def review_institution_application_document(
    application_id: str,
    document_id: str,
    payload: UniversityDocumentReviewRequest,
    current_user: dict = Depends(require_roles("university")),
):
    store = get_store()
    institution_id = _institution_id(current_user)
    application = store.get_application(application_id, institution_id=institution_id)
    if application is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Application not found.")
    if document_id not in application.get("document_assignments", {}).values():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")
    now = datetime.now(timezone.utc).isoformat()
    updated_document = store.update_document_verification(
        document_id,
        application["student_id"],
        payload.verification_status,
        payload.note,
        institution_id,
        now,
    )
    if updated_document is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")
    return {
        "document_id": document_id,
        "verification_status": updated_document["verification_status"],
        "verification_note": updated_document["verification_note"],
        "verified_at": updated_document["verified_at"],
    }
