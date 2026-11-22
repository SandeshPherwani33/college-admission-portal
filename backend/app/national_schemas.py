from typing import Literal

from pydantic import BaseModel, Field


class NationalCutoffRequest(BaseModel):
    exam: Literal["JEE Advanced via JoSAA", "NEET UG", "CUET UG"]
    year: int = Field(ge=2024, le=2030)
    rank_or_score: float = Field(gt=0)
    category: str | None = Field(default=None, max_length=80)
    institute_or_university: str | None = Field(default=None, max_length=160)


class NationalCutoffRow(BaseModel):
    exam: str
    year: int
    institute: str
    programme: str
    category: str | None = None
    quota: str | None = None
    round: str | int | None = None
    metric_value: float
    metric_type: Literal["closing_rank", "closing_score"]
    data_status: str
    source_url: str
    comparison: Literal["within_historical_cutoff", "outside_historical_cutoff"] | None = None
    admission_exam: str = ""
    official_application_url: str | None = None
    official_website: str | None = None
    application_status: Literal["not_applied", "application_started", "submitted"] = "not_applied"


class NationalCutoffResponse(BaseModel):
    success: bool = True
    exam: str
    data_status: Literal["partial_historical_data", "insufficient_data"]
    recommendations: list[NationalCutoffRow]
    message: str | None = None
    disclaimer: str

