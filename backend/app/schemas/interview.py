from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


InterviewType = Literal["general", "technical", "behavioral", "admissions"]
GenerationSource = Literal["ollama", "openai", "deterministic_fallback"]
InterviewStatus = Literal["created", "in_progress", "completed"]


class InterviewCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    student_id: str | None = Field(default=None, min_length=1, max_length=100)
    program: str = Field(min_length=1, max_length=200)
    interview_type: InterviewType = "general"
    question_count: int = Field(default=5, ge=1, le=10)
    mode: Literal["text", "video"] = "text"
    stream: str | None = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode="before")
    @classmethod
    def support_legacy_stream(cls, value):
        if isinstance(value, dict) and not value.get("program") and value.get("stream"):
            value = {**value, "program": value["stream"]}
        return value


class InterviewAnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    answer: str = Field(min_length=1, max_length=5000)


class InterviewTurn(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    answer: str | None = Field(default=None, max_length=5000)
    asked_at: datetime
    answered_at: datetime | None = None
    generation_mode: Literal["ollama", "openai", "deterministic_fallback"]


class InterviewQuestionOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    question: str = Field(min_length=8, max_length=1000)


class RubricDimensionOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    dimension: Literal["relevance", "clarity", "reasoning", "completeness"]
    score: int = Field(ge=1, le=5)
    explanation: str = Field(min_length=1, max_length=500)
    evidence: str = Field(min_length=1, max_length=250)


class InterviewFeedbackOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    summary: str = Field(min_length=1, max_length=1000)
    dimensions: list[RubricDimensionOutput] = Field(min_length=4, max_length=4)

    @model_validator(mode="after")
    def require_each_rubric_dimension_once(self):
        expected = {"relevance", "clarity", "reasoning", "completeness"}
        actual = {item.dimension for item in self.dimensions}
        if actual != expected:
            raise ValueError("Feedback must include each practice rubric dimension exactly once.")
        return self


class PracticeFeedback(BaseModel):
    summary: str
    dimensions: list[RubricDimensionOutput]
    generation_mode: Literal["ollama", "openai", "deterministic_fallback"]
    disclaimer: str = (
        "Practice feedback only. These scores are not a validated measurement, admissions decision, "
        "or verification of ability."
    )


class InterviewSessionResponse(BaseModel):
    interview_id: str
    student_id: str
    program: str
    stream: str
    interview_type: InterviewType
    question_count: int
    mode: Literal["text", "video"] = "text"
    status: InterviewStatus
    turns: list[InterviewTurn] = Field(default_factory=list)
    questions: list[str] = Field(default_factory=list)
    generation_mode: Literal[
        "pending",
        "ollama",
        "openai",
        "deterministic_fallback",
        "mixed",
    ] = "pending"
    generation_notice: str
    feedback: PracticeFeedback | None = None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None


InterviewRequest = InterviewCreateRequest
InterviewResponse = InterviewSessionResponse
