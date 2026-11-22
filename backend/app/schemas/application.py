from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, HttpUrl, model_validator

from app.schemas.eligibility import AdmissionDocumentType, AdmissionRequirementStatus


ApplicationStatus = Literal[
    "draft",
    "application_started",
    "submitted",
    "under_review",
    "documents_requested",
    "shortlisted",
    "accepted",
    "rejected",
    "withdrawn",
]


class ApplicationApplicantDetails(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    full_name: str = Field(min_length=2, max_length=200)
    email: EmailStr
    phone: str | None = Field(default=None, max_length=40)
    location: str | None = Field(default=None, max_length=200)


class ApplicationCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    program_id: str = Field(min_length=1, max_length=100)
    document_assignments: dict[AdmissionDocumentType, str] = Field(default_factory=dict, max_length=20)
    applicant_details: ApplicationApplicantDetails | None = None


class ApplicationUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    document_assignments: dict[AdmissionDocumentType, str] | None = Field(default=None, max_length=20)
    applicant_details: ApplicationApplicantDetails | None = None


class ApplicationSubmitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    consent: Literal[True]


class ExternalApplicationIntentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    exam: str = Field(min_length=1, max_length=100)
    institution: str = Field(min_length=1, max_length=200)
    programme: str = Field(min_length=1, max_length=200)
    admission_cycle: int = Field(ge=1900, le=2100)
    official_application_url: HttpUrl | None = None
    official_website: HttpUrl | None = None


class UniversityApplicationUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    status: Literal[
        "under_review",
        "documents_requested",
        "shortlisted",
        "accepted",
        "rejected",
    ]
    requested_documents: list[AdmissionDocumentType] = Field(default_factory=list, max_length=20)
    note: str | None = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def validate_request_details(self):
        if self.status == "documents_requested" and not self.requested_documents:
            raise ValueError("Select at least one document when requesting documents.")
        if self.status != "documents_requested" and self.requested_documents:
            raise ValueError("Requested documents are only valid for documents_requested status.")
        if len(self.requested_documents) != len(set(self.requested_documents)):
            raise ValueError("Requested documents must be unique.")
        return self


class UniversityDocumentReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    verification_status: Literal["verified", "rejected"]
    note: str = Field(min_length=1, max_length=1000)


class ApplicationDocumentSummary(BaseModel):
    document_id: str
    filename: str
    document_type: AdmissionDocumentType
    verification_status: Literal["not_verified", "verified", "rejected"]
    created_at: datetime | None = None
    reviewed_at: datetime | None = None


class ApplicationStatusEvent(BaseModel):
    status: ApplicationStatus
    actor: str
    note: str | None = None
    created_at: datetime


class ApplicationResponse(BaseModel):
    application_id: str
    reference_id: str | None = None
    student_id: str
    institution_id: str
    institution: str
    program_id: str
    program: str
    admission_cycle: int
    status: ApplicationStatus
    applicant_details: ApplicationApplicantDetails
    document_assignments: dict[AdmissionDocumentType, str] = Field(default_factory=dict)
    documents: list[ApplicationDocumentSummary] = Field(default_factory=list)
    requirements: list[AdmissionRequirementStatus] = Field(default_factory=list)
    requirements_complete: bool = False
    requested_documents: list[AdmissionDocumentType] = Field(default_factory=list)
    status_history: list[ApplicationStatusEvent] = Field(default_factory=list)
    source: str
    application_deadline: str | None = None
    application_fee: float | None = None
    official_application_url: str | None = None
    official_website: str | None = None
    admission_exam: str | None = None
    consented_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    submitted_at: datetime | None = None


class ApplicationListResponse(BaseModel):
    applications: list[ApplicationResponse]
    total: int
