from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class StudentProfile(BaseModel):
    student_id: str
    full_name: str
    email: str
    phone: Optional[str] = None
    location: Optional[str] = None
    stream: Optional[str] = None
    board: Optional[str] = None
    academic_score: Optional[float] = None
    exam_scores: Dict[str, float] = Field(default_factory=dict)
    subject_scores: Dict[str, float] = Field(default_factory=dict)
    admission_year: Optional[int] = None
    budget: Optional[float] = None
    career_goal: Optional[str] = None
    interests: List[str] = Field(default_factory=list)
    preferred_fields: List[str] = Field(default_factory=list)
    reservation_category: Optional[str] = None
    domicile: Optional[str] = None
    completion_percent: int = 0
    missing_fields: List[str] = Field(default_factory=list)
    notes: List[str] = Field(default_factory=list)
    academic_documents: List[Dict[str, Any]] = Field(default_factory=list)


class DocumentRecord(BaseModel):
    document_id: str
    student_id: str
    filename: str
    content_type: Optional[str] = None
    file_size_bytes: int = 0
    file_hash: str
    sha256: Optional[str] = None
    storage_key: Optional[str] = None
    status: str = "review_required"
    processing_status: str = "review_required"
    extraction_status: str = "unknown"
    ocr_status: str = "not_configured"
    verification_status: str = "not_verified"
    extracted_fields: Dict[str, Any] = Field(default_factory=dict)
    extraction_evidence: Dict[str, List[str]] = Field(default_factory=dict)
    extraction_methods: Dict[str, str] = Field(default_factory=dict)
    reviewed_fields: Optional[Dict[str, Any]] = None
    warnings: List[str] = Field(default_factory=list)
    confidence: Optional[float] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    reviewed_at: Optional[datetime] = None
