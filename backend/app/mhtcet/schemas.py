from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class MhtcetRecommendationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rank: int = Field(gt=0)
    category: str = Field(min_length=1, max_length=80)
    branch: str | None = Field(default=None, max_length=160)
    city: str | None = Field(default=None, max_length=100)
    cap_round: int | None = Field(default=None, ge=1, le=4)
    seat_level: Literal["State", "All India"] = "State"

    @field_validator("category", "branch", "city")
    @classmethod
    def strip_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = " ".join(value.split())
        if not cleaned and value is not None:
            raise ValueError("This value cannot contain only whitespace.")
        return cleaned


class MhtcetRecommendation(BaseModel):
    institute: str
    branch: str
    city: str | None
    historical_closing_rank: int
    year: int
    cap_round: int
    category: str
    seat_level: str
    comparison: Literal["within_historical_cutoff", "outside_historical_cutoff"]
    data_quality: str
    source_url: str
    city_source_note: str | None


class MhtcetFilterSuggestion(BaseModel):
    filter: Literal["branch", "city", "cap_round", "all"]
    label: str
    matching_rows: int = Field(ge=1)


class MhtcetRecommendationResponse(BaseModel):
    success: bool = True
    data_status: Literal["partial_historical_data", "insufficient_data"]
    recommendations: list[MhtcetRecommendation]
    message: str | None = None
    disclaimer: str
    filter_suggestions: list[MhtcetFilterSuggestion] = Field(default_factory=list)


class MhtcetOption(BaseModel):
    value: str
    label: str
    selectable: bool = True
    reason: str | None = None


class MhtcetInstituteCutoff(BaseModel):
    institute: str
    branch: str
    city: str | None
    historical_closing_rank: int
    year: int
    cap_round: int
    category: str


class MhtcetOptionsResponse(BaseModel):
    categories: list[str]
    branches: list[str]
    cities: list[str]
    institutes: list[str]
    institute_cutoffs: list[MhtcetInstituteCutoff]
    cap_rounds: list[int]
    seat_pools: list[MhtcetOption]
    data_status: Literal["partial_historical_data"]
    disclaimer: str
