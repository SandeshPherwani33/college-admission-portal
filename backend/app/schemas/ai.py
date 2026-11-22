from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


RecommendationTier = Literal["safe", "moderate", "ambitious", "insufficient_data"]


class AIHistoricalCutoff(BaseModel):
    course: str
    exam: str
    year: int | None = None
    cap_round: int | None = None
    category: str | None = None
    seat_level: str | None = None
    student_rank: int
    historical_closing_rank: int
    comparison: Literal["within_historical_cutoff", "outside_historical_cutoff"]
    data_quality: str | None = None
    source_url: str | None = None


class AICollegeRecommendation(BaseModel):
    college_id: str
    college_name: str
    city: str | None = None
    state: str | None = None
    course: str
    tier: RecommendationTier
    exam: str
    student_rank: int | None
    category: str
    historical_cutoffs: list[AIHistoricalCutoff] = Field(default_factory=list)
    matching_criteria: list[str] = Field(default_factory=list)
    missing_criteria: list[str] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list)
    data_verification_status: str
    application_url: str | None = None
    official_website: str | None = None
    criteria_source: str | None = None


class AIRecommendationRun(BaseModel):
    recommendation_id: str
    created_at: str
    status: Literal["ready", "insufficient_data"]
    recommendations: list[AICollegeRecommendation] = Field(default_factory=list)
    missing_information: list[str] = Field(default_factory=list)
    disclaimer: str


class AIChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    message: str = Field(min_length=1, max_length=2000)
    session_id: str | None = Field(default=None, min_length=6, max_length=80)
    context_college_id: str | None = Field(default=None, min_length=1, max_length=160)


class AIChatSource(BaseModel):
    source_id: str
    label: str
    data_status: str
    source_url: str | None = None


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str
    created_at: str
    sources: list[AIChatSource] = Field(default_factory=list)


class ChatSessionSummary(BaseModel):
    session_id: str
    title: str
    created_at: str
    updated_at: str
    message_count: int


class ChatSessionDetail(ChatSessionSummary):
    messages: list[ChatMessage] = Field(default_factory=list)


class AIChatResponse(BaseModel):
    session: ChatSessionSummary
    answer: str
    sources: list[AIChatSource] = Field(default_factory=list)


class SavedCollegeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    college_id: str = Field(min_length=1, max_length=160)


class SavedCollegeRecord(BaseModel):
    college_id: str
    saved_at: str
    college_name: str | None = None
    city: str | None = None
    state: str | None = None
