from .auth import LoginRequest, RegisterRequest, TokenResponse
from .profile import ProfileUpdateRequest, ProfileResponse
from .document import AcademicDocumentFields, DocumentApplyRequest, DocumentRecordResponse
from .eligibility import EvaluatedCriterion, ProgramCriteria, ProgramCriteriaCatalog, ProgramEligibilityResponse
from .recommendation import RecommendationResponse
from .interview import (
    InterviewAnswerRequest,
    InterviewCreateRequest,
    InterviewRequest,
    InterviewResponse,
    InterviewSessionResponse,
    InterviewTurn,
    PracticeFeedback,
)
from .allocation import AllocationRequest, AllocationResponse

__all__ = [
    "LoginRequest",
    "RegisterRequest",
    "TokenResponse",
    "ProfileUpdateRequest",
    "ProfileResponse",
    "AcademicDocumentFields",
    "DocumentApplyRequest",
    "DocumentRecordResponse",
    "EvaluatedCriterion",
    "ProgramCriteria",
    "ProgramCriteriaCatalog",
    "ProgramEligibilityResponse",
    "RecommendationResponse",
    "InterviewRequest",
    "InterviewResponse",
    "InterviewAnswerRequest",
    "InterviewCreateRequest",
    "InterviewSessionResponse",
    "InterviewTurn",
    "PracticeFeedback",
    "AllocationRequest",
    "AllocationResponse",
]
