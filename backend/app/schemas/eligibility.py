from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator


AdmissionDocumentType = Literal[
    "academic_marksheet",
    "school_leaving_certificate",
    "identity_proof",
    "entrance_scorecard",
    "category_certificate",
    "other",
]


class ProgramDocumentRequirement(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    document_type: AdmissionDocumentType
    label: str = Field(min_length=1, max_length=120)
    required: bool = True


class ProgramCriteria(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    criteria_id: str = Field(min_length=1, max_length=100)
    institution_id: str = Field(min_length=1, max_length=100)
    program_id: str = Field(min_length=1, max_length=100)
    institution: str = Field(min_length=1, max_length=200)
    program: str = Field(min_length=1, max_length=200)
    location: str | None = Field(default=None, max_length=200)
    tuition_budget: float | None = Field(default=None, ge=0, le=1_000_000_000)
    seat_capacity: int | None = Field(default=None, ge=0, le=10_000_000)
    priority_rules: list["ProgramPriorityRule"] = Field(default_factory=list, max_length=10)
    minimum_percentage: float | None = Field(default=None, ge=0, le=100)
    minimum_marks: float | None = Field(default=None, ge=0, le=1_000_000)
    marks_out_of: float | None = Field(default=None, gt=0, le=1_000_000)
    required_subjects: list[str] = Field(default_factory=list, max_length=30)
    required_qualifications: list[str] = Field(default_factory=list, max_length=20)
    examination_type: str | None = Field(default=None, max_length=100)
    examination_cutoff: float | None = Field(default=None, ge=0, le=100)
    examination_comparison: Literal["minimum", "maximum"] = "minimum"
    admission_year: int | None = Field(default=None, ge=1900, le=2100)
    required_category: str | None = Field(default=None, max_length=100)
    required_domicile: str | None = Field(default=None, max_length=100)
    required_documents: list[ProgramDocumentRequirement] = Field(default_factory=list, max_length=20)
    source: str = Field(min_length=1, max_length=500)
    effective_year: int = Field(ge=1900, le=2100)
    criteria_status: Literal["illustrative", "verified"]
    application_mode: Literal["unavailable", "direct", "external"] = "unavailable"
    application_cycle: int | None = Field(default=None, ge=1900, le=2100)
    application_deadline: str | None = Field(default=None, max_length=40)
    application_fee: float | None = Field(default=None, ge=0, le=10_000_000)
    official_application_url: HttpUrl | None = None
    official_website: HttpUrl | None = None
    admission_exam: str | None = Field(default=None, max_length=100)
    application_status: Literal["not_applied", "application_started", "submitted"] = "not_applied"

    @model_validator(mode="after")
    def validate_application_details(self):
        document_types = [item.document_type for item in self.required_documents]
        if len(document_types) != len(set(document_types)):
            raise ValueError("Required document types must be unique.")
        if self.application_mode == "unavailable":
            if self.application_cycle is not None or self.application_deadline is not None or self.application_fee is not None or self.official_application_url is not None or self.official_website is not None:
                raise ValueError("Application details require an enabled application mode.")
        elif self.criteria_status != "verified":
            raise ValueError("Applications can only be enabled for verified criteria.")
        elif self.application_cycle is None:
            raise ValueError("An explicit application cycle is required when applications are enabled.")
        if self.application_mode == "external" and self.official_application_url is None:
            raise ValueError("An HTTPS official application URL is required for external applications.")
        if self.application_mode != "external" and self.official_application_url is not None:
            raise ValueError("An official application URL is only valid for external applications.")
        if self.official_application_url is not None and urlparse(str(self.official_application_url)).scheme != "https":
            raise ValueError("Official application URLs must use HTTPS.")
        return self


class ProgramPriorityRule(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    field: Literal["academic_score", "exam_score"]
    exam_type: str | None = Field(default=None, max_length=100)
    direction: Literal["highest", "lowest"] = "highest"

    @model_validator(mode="after")
    def exam_type_matches_field(self):
        if self.field == "exam_score" and not self.exam_type:
            raise ValueError("exam_type is required for exam_score priority rules.")
        if self.field == "academic_score" and self.exam_type is not None:
            raise ValueError("exam_type is only valid for exam_score priority rules.")
        return self


class ProgramCriteriaCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid")

    programs: list[ProgramCriteria] = Field(max_length=500)

    @model_validator(mode="after")
    def identifiers_are_unique(self):
        for field_name in ("criteria_id", "program_id"):
            identifiers = [getattr(item, field_name) for item in self.programs]
            if len(identifiers) != len(set(identifiers)):
                raise ValueError(f"{field_name} values must be unique.")
        for item in self.programs:
            rule_ids = [(rule.field, (rule.exam_type or "").casefold()) for rule in item.priority_rules]
            if len(rule_ids) != len(set(rule_ids)):
                raise ValueError("Priority rules must not repeat the same field.")
        return self


class EvaluatedCriterion(BaseModel):
    criterion: str
    requirement: str
    student_value: str | float | int | list[str] | None = None
    status: Literal["met", "not_met", "unknown"]
    explanation: str


class AdmissionRequirementStatus(BaseModel):
    document_type: AdmissionDocumentType
    label: str
    required: bool
    status: Literal["completed", "missing", "pending_verification", "not_applicable"]
    documents: list[dict] = Field(default_factory=list)


class ProgramEligibilityResponse(BaseModel):
    program_id: str
    criteria_id: str
    institution_id: str
    institution: str
    program: str
    course: str
    location: str | None = None
    tuition_budget: float | None = None
    eligibility_status: Literal["eligible", "ineligible", "insufficient_data", "criteria_unavailable"]
    reasons: list[str] = Field(default_factory=list)
    missing_info: list[str] = Field(default_factory=list)
    evaluated_criteria: list[EvaluatedCriterion] = Field(default_factory=list)
    criteria: ProgramCriteria
    criteria_status: Literal["illustrative", "verified"]
    effective_year: int
    admission_year: int | None = None
    source: str
    match_score: int | None = None
    competitiveness: str = "not_assessed"
    required_documents: list[ProgramDocumentRequirement] = Field(default_factory=list)
    application_mode: Literal["unavailable", "direct", "external"] = "unavailable"
    application_cycle: int | None = None
    application_deadline: str | None = None
    application_fee: float | None = None
    official_application_url: HttpUrl | None = None
    official_website: HttpUrl | None = None
    admission_exam: str | None = None
    application_status: Literal["not_applied", "application_started", "submitted"] = "not_applied"
    requirements: list["AdmissionRequirementStatus"] = Field(default_factory=list)
    requirements_complete: bool = False
    requirements_completion_percent: int = 0
    can_apply: bool = False
