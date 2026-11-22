from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.eligibility import AdmissionDocumentType


class AcademicDocumentFields(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    student_name: str | None = Field(default=None, max_length=200)
    institution: str | None = Field(default=None, max_length=300)
    qualification: str | None = Field(default=None, max_length=200)
    marks: float | None = Field(default=None, ge=0, le=1_000_000)
    maximum_marks: float | None = Field(default=None, gt=0, le=1_000_000)
    percentage: float | None = Field(default=None, ge=0, le=100)
    examination_year: int | None = Field(default=None, ge=1900, le=2100)
    cgpa: float | None = Field(default=None, ge=0, le=1_000)

    @model_validator(mode="after")
    def marks_must_not_exceed_maximum(self):
        if (
            self.marks is not None
            and self.maximum_marks is not None
            and self.marks > self.maximum_marks
        ):
            raise ValueError("Marks cannot exceed maximum marks.")
        return self


class DocumentApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reviewed_fields: AcademicDocumentFields


class DocumentRecordResponse(BaseModel):
    document_id: str
    student_id: str
    filename: str
    content_type: Literal["application/pdf", "image/jpeg", "image/png"] | None = None
    file_size_bytes: int = 0
    file_hash: str
    sha256: str | None = None
    document_type: AdmissionDocumentType | None = None
    status: str
    processing_status: str = "unknown"
    extraction_status: str = "unknown"
    ocr_status: Literal["not_required", "not_configured", "completed", "failed"] = "not_configured"
    verification_status: Literal["not_verified", "verified", "rejected"] = "not_verified"
    verification_note: str | None = None
    verified_by_institution_id: str | None = None
    verified_at: datetime | None = None
    extracted_fields: AcademicDocumentFields = Field(default_factory=AcademicDocumentFields)
    extraction_evidence: dict[str, list[Annotated[str, Field(max_length=300)]]] = Field(
        default_factory=dict,
        max_length=8,
    )
    extraction_methods: dict[str, str] = Field(default_factory=dict, max_length=8)
    reviewed_fields: AcademicDocumentFields | None = None
    warnings: list[str] = Field(default_factory=list)
    confidence: float | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    reviewed_at: datetime | None = None

    @model_validator(mode="before")
    @classmethod
    def normalize_legacy_record(cls, value):
        if not isinstance(value, dict):
            return value
        record = dict(value)
        record.setdefault("processing_status", record.get("status", "unknown"))
        record.setdefault("extraction_status", record.get("status", "unknown"))
        fields = record.get("extracted_fields")
        if isinstance(fields, dict):
            allowed_fields = AcademicDocumentFields.model_fields
            record["extracted_fields"] = {
                key: field_value
                for key, field_value in fields.items()
                if key in allowed_fields
            }
        return record
