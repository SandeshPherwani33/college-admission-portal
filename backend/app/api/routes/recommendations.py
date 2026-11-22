from fastapi import APIRouter, Depends

from app.api.routes.dependencies import require_roles
from app.database.store import get_store
from app.eligibility.matcher import match_programs
from app.schemas.eligibility import ProgramEligibilityResponse
from app.mhtcet.recommendations import get_mhtcet_options, recommend_mhtcet
from app.mhtcet.schemas import (
    MhtcetOptionsResponse,
    MhtcetRecommendationRequest,
    MhtcetRecommendationResponse,
)
from app.national_cutoffs import national_cutoff_options, search_national_cutoffs
from app.national_schemas import NationalCutoffRequest, NationalCutoffResponse

router = APIRouter(prefix="/recommendations", tags=["recommendations"])
eligibility_router = APIRouter(prefix="/eligibility", tags=["eligibility"])


def _student_program_matches(current_user: dict) -> list[ProgramEligibilityResponse]:
    store = get_store()
    profile = store.get_profile(current_user["id"])
    documents = store.list_documents(current_user["id"])
    matches = match_programs(profile, store.get_program_criteria(), documents)
    return [ProgramEligibilityResponse.model_validate(item) for item in matches]


@router.get("", response_model=list[ProgramEligibilityResponse])
def get_recommendations(current_user: dict = Depends(require_roles("student"))):
    return _student_program_matches(current_user)


@eligibility_router.get("", response_model=list[ProgramEligibilityResponse])
def get_program_eligibility(current_user: dict = Depends(require_roles("student"))):
    return _student_program_matches(current_user)


@router.get("/mhtcet/options", response_model=MhtcetOptionsResponse)
def get_mhtcet_filter_options(current_user: dict = Depends(require_roles("student"))):
    return get_mhtcet_options()


@router.post("/mhtcet", response_model=MhtcetRecommendationResponse)
def get_mhtcet_recommendations(
    payload: MhtcetRecommendationRequest,
    current_user: dict = Depends(require_roles("student")),
):
    return recommend_mhtcet(payload)


@router.get("/national/options")
def get_national_cutoff_options(current_user: dict = Depends(require_roles("student"))):
    return national_cutoff_options()


@router.post("/national", response_model=NationalCutoffResponse)
def get_national_cutoffs(
    payload: NationalCutoffRequest,
    current_user: dict = Depends(require_roles("student")),
):
    return search_national_cutoffs(payload)
