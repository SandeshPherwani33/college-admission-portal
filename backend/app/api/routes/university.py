from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from app.allocation.simulator import create_allocation_run, program_catalog_hash
from app.api.routes.dependencies import require_roles
from app.database.store import AllocationConflict, get_store
from app.schemas.allocation import AllocationBatchRequest, AllocationRunResponse
from app.schemas.eligibility import ProgramCriteria, ProgramCriteriaCatalog

router = APIRouter(prefix="/university", tags=["university"])


@router.get("/dashboard")
def get_university_dashboard(current_user: dict = Depends(require_roles("university"))):
    store = get_store()
    institution_id = current_user.get("institution_id")
    if not institution_id:
        raise HTTPException(status_code=403, detail="This account is not assigned to an institution.")
    return store.get_university_dashboard(institution_id)


@router.get("/applicants")
def list_applicants(current_user: dict = Depends(require_roles("university"))):
    institution_id = current_user.get("institution_id")
    if not institution_id:
        raise HTTPException(status_code=403, detail="This account is not assigned to an institution.")
    return get_store().get_university_dashboard(institution_id)["applicants"]


@router.post("/criteria")
def update_university_criteria(payload: Dict[str, Any], current_user: dict = Depends(require_roles("university"))):
    institution_id = current_user.get("institution_id")
    if not institution_id:
        raise HTTPException(status_code=403, detail="This account is not assigned to an institution.")
    return get_store().update_university_criteria(payload, institution_id)


@router.get("/program-criteria", response_model=list[ProgramCriteria])
def list_program_criteria(current_user: dict = Depends(require_roles("university"))):
    institution_id = current_user.get("institution_id")
    if not institution_id:
        raise HTTPException(status_code=403, detail="This account is not assigned to an institution.")
    return get_store().get_program_criteria(institution_id)


@router.put("/program-criteria", response_model=list[ProgramCriteria])
def replace_program_criteria(
    payload: ProgramCriteriaCatalog,
    current_user: dict = Depends(require_roles("university")),
):
    programs = [item.model_dump(mode="json") for item in payload.programs]
    institution_id = current_user.get("institution_id")
    if not institution_id:
        raise HTTPException(status_code=403, detail="This account is not assigned to an institution.")
    if any(item["institution_id"] != institution_id for item in programs):
        raise HTTPException(
            status_code=403,
            detail="Program criteria must belong to the authenticated institution.",
        )
    try:
        return get_store().replace_program_criteria_for_institution(institution_id, programs)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/allocation-runs", response_model=AllocationRunResponse)
def create_university_allocation_run(
    payload: AllocationBatchRequest,
    current_user: dict = Depends(require_roles("university")),
):
    store = get_store()
    institution_id = current_user.get("institution_id")
    if not institution_id:
        raise HTTPException(status_code=403, detail="This account is not assigned to an institution.")
    institution_student_ids = {
        item["student_id"]
        for item in store.list_institution_applications(institution_id)
    }
    if any(item.student_id not in institution_student_ids for item in payload.students):
        raise HTTPException(
            status_code=404,
            detail="One or more students have no application with this institution.",
        )
    profiles = {}
    for student in payload.students:
        try:
            profiles[student.student_id] = store.get_profile(student.student_id)
        except ValueError as exc:
            raise HTTPException(
                status_code=404,
                detail=f"Student profile '{student.student_id}' was not found.",
            ) from exc

    programs = store.get_program_criteria(institution_id)
    config_hash = program_catalog_hash(programs)
    cycle_state = store.get_allocation_cycle_state(payload.cycle_id)
    if (
        cycle_state["program_config_hash"] is not None
        and cycle_state["program_config_hash"] != config_hash
    ):
        raise HTTPException(
            status_code=409,
            detail="Program criteria cannot change during an allocation cycle.",
        )

    run = create_allocation_run(
        students=[item.model_dump() for item in payload.students],
        programs=programs,
        profiles=profiles,
        cycle_id=payload.cycle_id,
        cycle_revision=cycle_state["revision"],
        used_seats=cycle_state["used_seats"],
        previously_allocated=cycle_state["allocated_students"],
        program_config_hash=config_hash,
    )
    existing = store.get_allocation_run_by_submission(
        payload.cycle_id,
        run["submission_hash"],
    )
    if existing is not None:
        return existing
    try:
        return store.save_cycle_allocation_run(
            run,
            expected_revision=cycle_state["revision"],
            program_config_hash=config_hash,
        )
    except AllocationConflict as exc:
        existing = store.get_allocation_run_by_submission(
            payload.cycle_id,
            run["submission_hash"],
        )
        if existing is not None:
            return existing
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/allocation-runs/{run_id}", response_model=AllocationRunResponse)
def get_university_allocation_run(
    run_id: str,
    current_user: dict = Depends(require_roles("university")),
):
    run = get_store().get_allocation_run(run_id)
    institution_id = current_user.get("institution_id")
    run_institutions = {
        item.get("institution_id")
        for item in (run or {}).get("input_snapshot", {}).get("programs", [])
    }
    if (
        run is None
        or not institution_id
        or run_institutions != {institution_id}
    ):
        raise HTTPException(status_code=404, detail="Allocation run not found.")
    return run
