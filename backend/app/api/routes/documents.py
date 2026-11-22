import hashlib
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse
from starlette.datastructures import UploadFile

from app.api.routes.dependencies import get_current_user
from app.core.config import get_settings
from app.database.document_storage import get_document_storage
from app.database.store import get_store
from app.documents.processing import (
    DocumentProcessingError,
    OCRAdapter,
    get_ocr_adapter,
    process_document,
)
from app.schemas.document import (
    DocumentApplyRequest,
    DocumentRecordResponse,
)

router = APIRouter(prefix="/documents", tags=["documents"])


@router.post("/upload", response_model=DocumentRecordResponse)
async def upload_document(
    request: Request,
    current_user: dict = Depends(get_current_user),
    ocr_adapter: OCRAdapter | None = Depends(get_ocr_adapter),
):
    settings = get_settings()
    try:
        form = await request.form(
            max_files=1,
            max_fields=1,
        )
    except (AssertionError, RuntimeError) as exc:
        if "python-multipart" in str(exc):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Multipart upload support is not installed on this server.",
            ) from exc
        raise

    try:
        uploads = form.getlist("file")
        if len(uploads) != 1 or not isinstance(uploads[0], UploadFile):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Upload exactly one file using the 'file' field.",
            )
        file = uploads[0]
        filename = file.filename or ""
        claimed_content_type = file.content_type
        document_type_value = form.get("document_type")
        data = await file.read(settings.document_max_bytes + 1)
    finally:
        await form.close()

    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file is empty.")
    if len(data) > settings.document_max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"File exceeds the {settings.document_max_bytes}-byte limit.",
        )
    document_types = {
        "academic_marksheet",
        "school_leaving_certificate",
        "identity_proof",
        "entrance_scorecard",
        "category_certificate",
        "other",
    }
    if document_type_value is not None and (
        not isinstance(document_type_value, str) or document_type_value not in document_types
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Unsupported document_type.",
        )

    allowed_mime_types = {
        item.strip().lower()
        for item in settings.document_allowed_mime_types.split(",")
        if item.strip()
    }
    try:
        processed = process_document(
            filename=filename,
            claimed_content_type=claimed_content_type,
            content=data,
            allowed_mime_types=allowed_mime_types,
            ocr_adapter=ocr_adapter,
        )
    except DocumentProcessingError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    document_id = f"doc-{uuid4().hex}"
    now = datetime.now(timezone.utc).isoformat()
    content_hash = hashlib.sha256(data).hexdigest()
    existing_duplicate = next(
        (
            item
            for item in get_store().list_documents(current_user["id"])
            if item.get("sha256") == content_hash or item.get("file_hash") == content_hash
        ),
        None,
    )
    if existing_duplicate is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "status": "duplicate",
                "document_id": existing_duplicate["document_id"],
                "message": "This document has already been uploaded to your account.",
            },
        )
    record = {
        "document_id": document_id,
        "student_id": current_user["id"],
        "filename": filename,
        "content_type": processed.content_type,
        "file_size_bytes": len(data),
        "file_hash": content_hash,
        "sha256": content_hash,
        "document_type": document_type_value,
        "status": processed.status,
        "processing_status": processed.status,
        "extraction_status": processed.extraction_status,
        "ocr_status": processed.ocr_status,
        "verification_status": "not_verified",
        "verification_note": None,
        "verified_by_institution_id": None,
        "verified_at": None,
        "extracted_fields": processed.extracted_fields,
        "extraction_evidence": processed.extraction_evidence,
        "extraction_methods": processed.extraction_methods,
        "reviewed_fields": None,
        "warnings": processed.warnings,
        "confidence": None,
        "created_at": now,
        "updated_at": now,
        "reviewed_at": None,
        "storage_key": document_id,
    }
    storage = get_document_storage()
    try:
        storage.save(document_id, data)
    except (OSError, RuntimeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Private document storage is unavailable.",
        ) from exc
    try:
        saved_record = get_store().add_document(record)
    except RuntimeError as exc:
        storage.delete(document_id)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Document metadata storage is unavailable.",
        ) from exc
    except Exception:
        storage.delete(document_id)
        raise
    return DocumentRecordResponse.model_validate(saved_record)


@router.get("", response_model=list[DocumentRecordResponse])
def list_documents(current_user: dict = Depends(get_current_user)):
    records = get_store().list_documents(current_user["id"])
    return [DocumentRecordResponse.model_validate(record) for record in records]


@router.get("/{document_id}", response_model=DocumentRecordResponse)
def get_document(document_id: str, current_user: dict = Depends(get_current_user)):
    record = get_store().get_document(document_id, current_user["id"])
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")
    return DocumentRecordResponse.model_validate(record)


@router.post("/{document_id}/reprocess", response_model=DocumentRecordResponse)
def reprocess_document(
    document_id: str,
    current_user: dict = Depends(get_current_user),
    ocr_adapter: OCRAdapter | None = Depends(get_ocr_adapter),
):
    settings = get_settings()
    store = get_store()
    record = store.get_document(document_id, current_user["id"])
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")
    if record.get("status") == "reviewed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Reviewed documents cannot be reprocessed.",
        )

    storage_key = record.get("storage_key")
    if not storage_key:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document content is unavailable.",
        )
    try:
        path = get_document_storage().get_path(storage_key)
        if path is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Document content is unavailable.",
            )
        with path.open("rb") as document_file:
            content = document_file.read(settings.document_max_bytes + 1)
    except HTTPException:
        raise
    except (OSError, RuntimeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Private document storage is unavailable.",
        ) from exc

    if len(content) > settings.document_max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Document exceeds the current processing size limit.",
        )
    allowed_mime_types = {
        item.strip().lower()
        for item in settings.document_allowed_mime_types.split(",")
        if item.strip()
    }
    try:
        processed = process_document(
            filename=record["filename"],
            claimed_content_type=record.get("content_type"),
            content=content,
            allowed_mime_types=allowed_mime_types,
            ocr_adapter=ocr_adapter,
        )
    except DocumentProcessingError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    updated_at = datetime.now(timezone.utc).isoformat()
    processing = {
        "status": processed.status,
        "processing_status": processed.status,
        "extraction_status": processed.extraction_status,
        "ocr_status": processed.ocr_status,
        "verification_status": "not_verified",
        "extracted_fields": processed.extracted_fields,
        "extraction_evidence": processed.extraction_evidence,
        "extraction_methods": processed.extraction_methods,
        "warnings": processed.warnings,
        "confidence": None,
    }
    try:
        updated_record = store.update_document_processing(
            document_id,
            current_user["id"],
            processing,
            updated_at,
        )
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Document metadata storage is unavailable.",
        ) from exc
    if updated_record is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The document was reviewed and can no longer be reprocessed.",
        )
    return DocumentRecordResponse.model_validate(updated_record)


@router.get("/{document_id}/content")
def get_document_content(document_id: str, current_user: dict = Depends(get_current_user)):
    record = get_store().get_document(document_id, current_user["id"])
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")
    storage_key = record.get("storage_key")
    if not storage_key:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document content is unavailable.",
        )
    try:
        path = get_document_storage().get_path(storage_key)
    except (OSError, RuntimeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Private document storage is unavailable.",
        ) from exc
    if path is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document content is unavailable.",
        )
    return FileResponse(
        path,
        media_type=record["content_type"],
        filename=record["filename"],
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
        },
    )


@router.post("/{document_id}/apply", response_model=DocumentRecordResponse)
def apply_document_review(
    document_id: str,
    payload: DocumentApplyRequest,
    current_user: dict = Depends(get_current_user),
):
    store = get_store()
    record = store.get_document(document_id, current_user["id"])
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")

    reviewed_fields = payload.reviewed_fields.model_dump()
    reviewed_at = datetime.now(timezone.utc).isoformat()
    profile = store.get_profile(current_user["id"])
    academic_documents = [
        item
        for item in profile.get("academic_documents", [])
        if item.get("document_id") != document_id
    ]
    academic_documents.append(
        {
            "document_id": document_id,
            "filename": record["filename"],
            **reviewed_fields,
            "reviewed_at": reviewed_at,
            "verification_status": "not_verified",
        }
    )
    updates: dict[str, Any] = {"academic_documents": academic_documents}
    if reviewed_fields["percentage"] is not None:
        updates["academic_score"] = reviewed_fields["percentage"]
    store.update_profile(current_user["id"], updates)

    updated_record = store.mark_document_reviewed(
        document_id,
        current_user["id"],
        reviewed_fields,
        reviewed_at,
    )
    if updated_record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")
    return DocumentRecordResponse.model_validate(updated_record)
