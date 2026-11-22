from typing import Literal

from pydantic import BaseModel, Field


class CollegeCutoffRecord(BaseModel):
    course: str
    year: int | None = None
    cap_round: int | None = None
    seat_level: str | None = None
    category: str | None = None
    historical_closing_rank: int | None = None
    exam: str
    data_quality: str | None = None
    source_url: str | None = None


class VerifiedCollegeProgram(BaseModel):
    program_id: str
    course: str
    admission_exam: str | None = None
    minimum_percentage: float | None = None
    minimum_marks: float | None = None
    marks_out_of: float | None = None
    examination_type: str | None = None
    examination_cutoff: float | None = None
    required_subjects: list[str] = Field(default_factory=list)
    required_qualifications: list[str] = Field(default_factory=list)
    required_category: str | None = None
    required_domicile: str | None = None
    admission_year: int | None = None
    criteria_source: str
    official_website: str | None = None
    official_application_url: str | None = None
    application_cycle: int | None = None


class CollegeApplicationLink(BaseModel):
    program_id: str
    course: str
    url: str


class ExploreCollegeRecord(BaseModel):
    college_id: str
    name: str
    source_record_id: str | None = None
    short_name: str | None = None
    city: str | None = None
    state: str | None = None
    state_source_note: str | None = None
    address: str | None = None
    logo_url: str | None = None
    ug_fee: str | None = None
    pg_fee: str | None = None
    rating: float | None = None
    academic_rating: float | None = None
    accommodation_rating: float | None = None
    faculty_rating: float | None = None
    infrastructure_rating: float | None = None
    placement_rating: float | None = None
    social_life_rating: float | None = None
    courses: list[str] = Field(default_factory=list)
    accepted_exams: list[str] = Field(default_factory=list)
    historical_exams: list[str] = Field(default_factory=list)
    categories: list[str] = Field(default_factory=list)
    historical_cutoffs: list[CollegeCutoffRecord] = Field(default_factory=list)
    verified_programs: list[VerifiedCollegeProgram] = Field(default_factory=list)
    official_website: str | None = None
    application_links: list[CollegeApplicationLink] = Field(default_factory=list)
    data_sources: list[str] = Field(default_factory=list)
    verification_status: Literal["partial_uploaded_dataset"] = "partial_uploaded_dataset"
    source_note: str | None = None


class ExploreCollegeDirectoryResponse(BaseModel):
    colleges: list[ExploreCollegeRecord]
    total: int = Field(ge=0)
    data_status: Literal["partial_reference_dataset"] = "partial_reference_dataset"
    source: str
    disclaimer: str
