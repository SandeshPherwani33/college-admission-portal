from typing import Annotated, Any, Dict, List, Literal, Optional

import json

from pydantic import BaseModel, ConfigDict, Field, field_validator

_MISSING_VALUES = {"", "none", "null", "unknown", "not provided", "not specified", "n/a", "na", "nil"}


class ProfileIntakeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    description: str = Field(
        ...,
        min_length=20,
        max_length=5000,
        description="Academic background, interests, preferred courses, and budget. Do not include sensitive identifiers.",
    )


class ProfileIntakeData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    academic_background: Optional[str] = Field(..., max_length=1000)
    stream: Optional[str] = Field(..., max_length=100)
    board: Optional[str] = Field(..., max_length=100)
    academic_score: Optional[float] = Field(..., ge=0, le=100)
    exam_scores: dict[str, float]
    budget: Optional[float] = Field(..., ge=0, le=1_000_000_000)
    career_goal: Optional[str] = Field(..., max_length=500)
    interests: List[str] = Field(..., max_length=20)
    preferred_courses: List[str] = Field(..., max_length=20)
    missing_information: List[str] = Field(..., max_length=20)
    clarification_questions: List[str] = Field(..., max_length=10)

    @field_validator("academic_background", "stream", "board", "career_goal", mode="before")
    @classmethod
    def normalize_missing_text(cls, value):
        if isinstance(value, str) and value.strip().casefold() in _MISSING_VALUES:
            return None
        return value

    @field_validator("academic_score", "budget", mode="before")
    @classmethod
    def normalize_missing_numbers(cls, value):
        if isinstance(value, str) and value.strip().casefold() in _MISSING_VALUES:
            return None
        return value

    @field_validator("exam_scores", mode="before")
    @classmethod
    def normalize_exam_scores(cls, value):
        if value is None or (isinstance(value, str) and value.strip().casefold() in _MISSING_VALUES):
            return {}
        if isinstance(value, str):
            try:
                return json.loads(value)
            except json.JSONDecodeError:
                return value
        return value

    @field_validator(
        "interests",
        "preferred_courses",
        "missing_information",
        "clarification_questions",
        mode="before",
    )
    @classmethod
    def normalize_text_lists(cls, value):
        if value is None:
            return []
        if isinstance(value, str):
            item = value.strip()
            return [] if item.casefold() in _MISSING_VALUES else [item]
        return value


class ProfileIntakeResponse(BaseModel):
    status: Literal["model_generated"]
    provider: str
    model: str
    profile: ProfileIntakeData
    persisted: bool = False
    message: str


class AIStatusResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    configured_provider: str
    active_provider: str
    model: str
    mode: str
    profile_intake_enabled: bool
    fallback_active: bool
    message: str
    connected: bool = False
    service_reachable: bool = False
    model_available: bool = False
    inference_verified: bool = False
    error_code: Optional[str] = None


class ProfileUpdateRequest(BaseModel):
    full_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    location: Optional[str] = None
    stream: Optional[str] = None
    board: Optional[str] = None
    academic_score: Optional[float] = Field(default=None, ge=0, le=100)
    exam_scores: dict[str, Annotated[float, Field(ge=0, le=100)]] = Field(default_factory=dict)
    exam_ranks: dict[str, Annotated[int, Field(gt=0, le=10_000_000)]] = Field(default_factory=dict)
    subject_scores: dict[str, Annotated[float, Field(ge=0, le=100)]] = Field(default_factory=dict)
    admission_year: Optional[int] = Field(default=None, ge=1900, le=2100)
    budget: Optional[float] = None
    career_goal: Optional[str] = None
    interests: List[str] = Field(default_factory=list)
    preferred_fields: List[str] = Field(default_factory=list)
    reservation_category: Optional[str] = None
    domicile: Optional[str] = None
    notes: List[str] = Field(default_factory=list)


class ProfileResponse(BaseModel):
    student_id: str
    full_name: str
    email: str
    phone: Optional[str] = None
    location: Optional[str] = None
    stream: Optional[str] = None
    board: Optional[str] = None
    academic_score: Optional[float] = Field(default=None, ge=0, le=100)
    exam_scores: dict[str, Annotated[float, Field(ge=0, le=100)]] = Field(default_factory=dict)
    exam_ranks: dict[str, Annotated[int, Field(gt=0, le=10_000_000)]] = Field(default_factory=dict)
    subject_scores: dict[str, Annotated[float, Field(ge=0, le=100)]] = Field(default_factory=dict)
    admission_year: Optional[int] = Field(default=None, ge=1900, le=2100)
    budget: Optional[float] = None
    career_goal: Optional[str] = None
    interests: List[str] = Field(default_factory=list)
    preferred_fields: List[str] = Field(default_factory=list)
    reservation_category: Optional[str] = None
    domicile: Optional[str] = None
    completion_percent: int
    missing_fields: List[str] = Field(default_factory=list)
    notes: List[str] = Field(default_factory=list)
    academic_documents: List[Dict[str, Any]] = Field(default_factory=list)
