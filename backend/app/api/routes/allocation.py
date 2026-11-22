from copy import deepcopy

from fastapi import APIRouter, Depends, HTTPException, status

from app.allocation.simulator import create_allocation_run
from app.api.routes.dependencies import require_roles
from app.database.store import get_store
from app.schemas.allocation import AllocationRequest, AllocationResponse

router = APIRouter(prefix="/allocation", tags=["allocation"])


def _student_result(run: dict, student_id: str) -> AllocationResponse:
    result = next(
        (item for item in run["results"] if item["student_id"] == student_id),
        None,
    )
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Allocation run not found.",
        )
    return AllocationResponse(
        **result,
        run_id=run["run_id"],
        input_hash=run["input_hash"],
        created_at=run["created_at"],
        algorithm_version=run["algorithm_version"],
        cycle_id=run.get("cycle_id"),
        cycle_revision=run.get("cycle_revision"),
    )


@router.post("/simulate", response_model=AllocationResponse)
def simulate_allocation(
    payload: AllocationRequest,
    current_user: dict = Depends(require_roles("student")),
):
    if payload.student_id != current_user["id"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot simulate an allocation for another student.",
        )

    store = get_store()
    try:
        profile = deepcopy(store.get_profile(current_user["id"]))
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Student profile not found.",
        ) from exc
    if payload.category is not None and payload.category.strip():
        profile["reservation_category"] = payload.category.strip()

    run = create_allocation_run(
        students=[
            {
                "student_id": current_user["id"],
                "preferences": payload.preferences,
            }
        ],
        programs=store.get_program_criteria(),
        profiles={current_user["id"]: profile},
    )
    if payload.budget is not None:
        compatibility_note = (
            "The legacy budget field is accepted for API compatibility but is not an eligibility "
            "or priority rule in this simulation."
        )
        run["notes"].append(compatibility_note)
        run["results"][0]["notes"].append(compatibility_note)
    store.save_allocation_run(run)
    return _student_result(run, current_user["id"])


@router.get("/runs/{run_id}", response_model=AllocationResponse)
def get_student_allocation_run(
    run_id: str,
    current_user: dict = Depends(require_roles("student")),
):
    run = get_store().get_allocation_run(run_id)
    if run is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Allocation run not found.",
        )
    return _student_result(run, current_user["id"])
