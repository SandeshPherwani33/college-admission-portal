import hashlib
from io import BytesIO
import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
from unittest.mock import patch

import httpx
import pytest
from PIL import Image
from pypdf import PdfWriter
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.agents.interview_agent import InterviewAgent
from app.ai_admissions import generate_recommendations
from app.core.config import DEFAULT_JWT_SECRET_KEY, Settings, get_settings
from app.database.document_storage import LocalDocumentStorage, get_document_storage
from app.database.store import MongoStore, StoreManager, get_store
from app.eligibility.demo_criteria import SYNTHETIC_PROGRAM_CRITERIA
from app.documents.processing import get_ocr_adapter
from app.llm.provider import DemoLLMProvider, LLMResponseError, OllamaLLMProvider, OpenAILLMProvider, get_llm_provider
from app.main import app, validate_production_settings
from app.api.routes.explore import build_college_directory
from app.mhtcet.recommendations import load_mhtcet_dataset
from app.schemas.profile import ProfileIntakeData
from app.workflows.orchestrator import orchestrator

client = TestClient(app)

INTAKE_PROFILE = {
    "academic_background": "Completed Class 12 with science subjects.",
    "stream": "Science",
    "board": "CBSE",
    "academic_score": 92.0,
    "exam_scores": {"CUET": 90.0},
    "budget": 400000.0,
    "career_goal": "Biotechnology",
    "interests": ["biology", "chemistry"],
    "preferred_courses": ["BSc Biotechnology"],
    "missing_information": ["preferred study location"],
    "clarification_questions": ["Which city or state do you prefer?"],
}


def synthetic_program_criteria(**overrides):
    criteria = {
        "criteria_id": "test-criteria",
        "institution_id": "synthetic-institute",
        "program_id": "synthetic-program",
        "institution": "Synthetic Test Institute",
        "program": "Synthetic Test Program",
        "location": "Synthetic City",
        "tuition_budget": None,
        "minimum_percentage": 70,
        "minimum_marks": None,
        "marks_out_of": None,
        "required_subjects": [],
        "required_qualifications": [],
        "examination_type": None,
        "examination_cutoff": None,
        "admission_year": None,
        "required_category": None,
        "required_domicile": None,
        "source": "Synthetic test criteria; not official",
        "effective_year": 2026,
        "criteria_status": "verified",
    }
    criteria.update(overrides)
    return criteria


def synthetic_pdf(lines=None):
    text_lines = lines if lines is not None else [
        "Student Name: Synthetic Test Student",
        "Institution: Example Secondary School",
        "Qualification: Class XII",
        "Marks: 450/500",
        "Percentage: 90%",
        "Examination Year: 2025",
    ]
    escaped_lines = [
        line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        for line in text_lines
    ]
    text_stream = (
        "BT /F1 12 Tf 72 720 Td ("
        + r"\n".join(escaped_lines)
        + ") Tj ET"
    ).encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        (
            f"<< /Length {len(text_stream)} >>\nstream\n".encode("ascii")
            + text_stream
            + b"\nendstream"
        ),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, body in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf.extend(f"{index} 0 obj\n".encode("ascii"))
        pdf.extend(body)
        pdf.extend(b"\nendobj\n")
    xref_offset = len(pdf)
    pdf.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    pdf.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    pdf.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n".encode("ascii")
    )
    return bytes(pdf)


def synthetic_image(image_format):
    output = BytesIO()
    Image.new("RGB", (2, 2), color=(20, 40, 60)).save(output, format=image_format)
    return output.getvalue()


def synthetic_encrypted_pdf():
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.encrypt("synthetic-test-password")
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


@pytest.fixture
def demo_storage(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "demo")
    get_settings.cache_clear()
    monkeypatch.setattr(MongoStore, "_connect", lambda self: None)
    if hasattr(get_store, "instance"):
        del get_store.instance
    yield
    if hasattr(get_store, "instance"):
        get_store.instance.close()
        del get_store.instance
    get_settings.cache_clear()


@pytest.fixture
def document_storage(tmp_path, monkeypatch):
    storage = LocalDocumentStorage(tmp_path / "private-documents")
    monkeypatch.setattr(
        "app.api.routes.documents.get_document_storage",
        lambda: storage,
    )
    monkeypatch.setattr(
        "app.api.routes.applications.get_document_storage",
        lambda: storage,
    )
    monkeypatch.setattr(
        "app.database.document_storage.get_document_storage",
        lambda: storage,
    )
    return storage


class StubOllamaProvider(OllamaLLMProvider):
    def __init__(self, *, available=True, result=None, error=None, base_url="http://localhost:11434"):
        super().__init__(
            base_url=base_url,
            model="test-model",
            timeout=1.0,
            max_retries=0,
        )
        self._available = available
        self.result = result
        self.error = error
        self.calls = 0

    @property
    def is_available(self):
        return self._available

    def generate_json_strict(self, prompt, *, schema=None, system_prompt=None):
        self.calls += 1
        if self.error:
            raise self.error
        return self.result


class SequencedInterviewProvider(OllamaLLMProvider):
    def __init__(self, results=None, *, available=True):
        super().__init__(
            base_url="http://localhost:11434",
            model="synthetic-interview-model",
            timeout=1.0,
            max_retries=0,
        )
        self.results = list(results or [])
        self._available = available
        self.prompts = []

    @property
    def is_available(self):
        return self._available

    def generate_json_strict(self, prompt, *, schema=None, system_prompt=None):
        self.prompts.append(prompt)
        if not self.results:
            raise LLMResponseError("Synthetic provider has no queued response.")
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def register_student():
    response = client.post(
        "/api/auth/register",
        json={
            "full_name": "Intake Test Student",
            "email": f"intake-{uuid4().hex[:8]}@example.com",
            "password": "StrongPassword123!",
        },
    )
    assert response.status_code == 200
    return response.json()


def test_health_check(demo_storage):
    response = client.get("/api/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["storage_backend"] == "demo"
    assert set(payload) == {"status", "service", "version", "storage_backend"}


def test_health_check_marks_unavailable_mongodb_unhealthy(monkeypatch):
    unavailable_store = SimpleNamespace(backend_name="mongodb", is_healthy=False)
    monkeypatch.setattr("app.main.get_store", lambda: unavailable_store)

    response = client.get("/api/health")

    assert response.status_code == 503
    assert response.json()["storage_backend"] == "mongodb"
    assert response.json()["status"] == "unavailable"


def test_production_configuration_requires_database_secret_and_specific_cors():
    settings = SimpleNamespace(
        app_env="production",
        mongodb_uri="",
        jwt_secret_key="test-secret-" + "x" * 32,
        cors_origins="https://uniapply.example",
    )
    with pytest.raises(RuntimeError, match="MONGODB_URI is required"):
        validate_production_settings(settings)

    settings.mongodb_uri = "mongodb+srv://configured-uri"
    settings.jwt_secret_key = "change-me-in-production"
    with pytest.raises(RuntimeError, match="JWT_SECRET_KEY"):
        validate_production_settings(settings)

    settings.jwt_secret_key = DEFAULT_JWT_SECRET_KEY
    with pytest.raises(RuntimeError, match="JWT_SECRET_KEY"):
        validate_production_settings(settings)

    settings.jwt_secret_key = "test-secret-" + "x" * 32
    settings.cors_origins = "*"
    with pytest.raises(RuntimeError, match="CORS_ORIGINS"):
        validate_production_settings(settings)

    settings.cors_origins = "http://uniapply.example"
    with pytest.raises(RuntimeError, match="HTTPS"):
        validate_production_settings(settings)

    settings.cors_origins = "https://uniapply.example"
    settings.document_storage_dir = None
    with pytest.raises(RuntimeError, match="DOCUMENT_STORAGE_DIR"):
        validate_production_settings(settings)
    settings.document_storage_dir = Path("/var/data/uniapply-documents")
    settings.storage_backend = "demo"
    with pytest.raises(RuntimeError, match="Demo storage"):
        validate_production_settings(settings)


def test_store_manager_refuses_demo_fallback_in_production(monkeypatch):
    monkeypatch.setattr(
        "app.core.config.get_settings",
        lambda: SimpleNamespace(
            app_env="production",
            mongodb_uri="",
            mongodb_database="uniapply_ai",
        ),
    )
    monkeypatch.setattr(MongoStore, "_connect", lambda self: None)

    with pytest.raises(RuntimeError, match="MongoDB is required in production"):
        StoreManager()


def test_settings_reject_unrecognized_environment_names():
    with pytest.raises(ValidationError):
        Settings(app_env="prod", _env_file=None)


def test_document_settings_only_accept_supported_mimes_and_bounded_sizes():
    settings = Settings(
        document_allowed_mime_types="image/png, application/pdf",
        document_max_bytes=1024,
        _env_file=None,
    )
    assert settings.document_allowed_mime_types == "application/pdf,image/png"
    with pytest.raises(ValidationError):
        Settings(document_allowed_mime_types="text/html", _env_file=None)
    with pytest.raises(ValidationError):
        Settings(document_max_bytes=0, _env_file=None)


def test_document_storage_uses_configured_path(monkeypatch, tmp_path):
    settings = Settings(
        app_env="development",
        document_storage_dir=tmp_path / "configured-private-documents",
        _env_file=None,
    )
    monkeypatch.setattr("app.core.config.get_settings", lambda: settings)

    storage = get_document_storage()

    assert storage.root == tmp_path / "configured-private-documents"
    assert storage.create_root


def test_production_document_storage_requires_an_explicit_absolute_path(monkeypatch):
    settings = Settings(app_env="production", document_storage_dir=None, _env_file=None)
    monkeypatch.setattr("app.core.config.get_settings", lambda: settings)

    with pytest.raises(RuntimeError, match="DOCUMENT_STORAGE_DIR"):
        get_document_storage()

    settings.document_storage_dir = Path("private_documents")
    with pytest.raises(RuntimeError, match="absolute path"):
        get_document_storage()


def test_document_storage_restart_persistence_with_shared_directory(tmp_path):
    storage_before_restart = LocalDocumentStorage(tmp_path / "persistent-documents")
    document_id = f"doc-{uuid4().hex}"
    content = b"synthetic document bytes"
    storage_before_restart.save(document_id, content)

    storage_after_restart = LocalDocumentStorage(
        tmp_path / "persistent-documents",
        create_root=False,
    )

    storage_after_restart.ensure_available()
    stored_path = storage_after_restart.get_path(document_id)
    assert stored_path is not None
    assert stored_path.read_bytes() == content


def test_production_storage_does_not_create_a_missing_mount(tmp_path):
    missing_mount = tmp_path / "not-mounted"
    storage = LocalDocumentStorage(missing_mount, create_root=False)

    with pytest.raises(RuntimeError, match="directory is unavailable"):
        storage.ensure_available()

    assert not missing_mount.exists()


def test_document_storage_write_probe_reports_unwritable_path(monkeypatch, tmp_path):
    storage = LocalDocumentStorage(tmp_path / "private-documents")
    storage.root.mkdir()

    def deny_write(*args, **kwargs):
        raise PermissionError("synthetic write denial")

    monkeypatch.setattr("app.database.document_storage.tempfile.NamedTemporaryFile", deny_write)

    with pytest.raises(RuntimeError, match="not writable"):
        storage.ensure_available()


def test_registration_cannot_assign_university_role(demo_storage):
    response = client.post(
        "/api/auth/register",
        json={
            "full_name": "Self Assigned Admin",
            "email": f"admin-{uuid4().hex[:8]}@example.com",
            "password": "StrongPassword123!",
            "role": "university",
        },
    )

    assert response.status_code == 422


def test_registration_and_profile_flow(demo_storage, document_storage):
    email = f"student-{uuid4().hex[:8]}@example.com"
    response = client.post(
        "/api/auth/register",
        json={
            "full_name": "Test Student",
            "email": email,
            "password": "StrongPassword123!",
            "role": "student",
        },
    )
    assert response.status_code == 200
    token = response.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    profile_response = client.get("/api/profile", headers=headers)
    assert profile_response.status_code == 200
    body = profile_response.json()
    assert body["email"] == email

    updated = client.post(
        "/api/profile",
        json={
            "location": "Mumbai",
            "stream": "Science",
            "board": "CBSE",
            "academic_score": 94.5,
            "budget": 500000,
            "career_goal": "AI engineer",
            "interests": ["AI", "Robotics"],
        },
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json()["location"] == "Mumbai"

    uploaded = client.post(
        "/api/documents/upload",
        files={"file": ("marksheet.pdf", synthetic_pdf(), "application/pdf")},
        headers=headers,
    )
    assert uploaded.status_code == 200
    uploaded_record = uploaded.json()
    assert uploaded_record["student_id"] == body["student_id"]
    assert uploaded_record["sha256"] == hashlib.sha256(synthetic_pdf()).hexdigest()
    assert uploaded_record["extracted_fields"]["institution"] == "Example Secondary School"
    assert uploaded_record["extracted_fields"]["percentage"] == 90
    assert uploaded_record["extraction_status"] == "fields_extracted"
    assert uploaded_record["extraction_evidence"]["percentage"] == ["Percentage: 90%"]
    assert uploaded_record["extraction_methods"]["percentage"] == "labeled_pdf_text"
    assert uploaded_record["verification_status"] == "not_verified"
    assert uploaded_record["confidence"] is None
    assert document_storage.get_path(uploaded_record["document_id"]).read_bytes() == synthetic_pdf()
    reopened_storage = LocalDocumentStorage(document_storage.root, create_root=False)
    persisted_upload = reopened_storage.get_path(uploaded_record["document_id"])
    assert persisted_upload is not None
    assert persisted_upload.read_bytes() == synthetic_pdf()
    listed = client.get("/api/documents", headers=headers)
    assert listed.status_code == 200
    assert listed.json()[0]["document_id"] == uploaded_record["document_id"]


@pytest.mark.parametrize(
    ("filename", "content_type", "image_format"),
    [
        ("synthetic.png", "image/png", "PNG"),
        ("synthetic.jpg", "image/jpeg", "JPEG"),
    ],
)
def test_valid_image_upload_is_saved_without_claiming_ocr(
    demo_storage,
    document_storage,
    monkeypatch,
    filename,
    content_type,
    image_format,
):
    monkeypatch.setitem(app.dependency_overrides, get_ocr_adapter, lambda: None)
    data = synthetic_image(image_format)
    registration = register_student()
    response = client.post(
        "/api/documents/upload",
        files={"file": (filename, data, content_type)},
        headers={"Authorization": f"Bearer {registration['token']}"},
    )

    assert response.status_code == 200
    record = response.json()
    assert record["content_type"] == content_type
    assert record["status"] == "ocr_not_configured"
    assert record["ocr_status"] == "not_configured"
    assert record["extracted_fields"]["percentage"] is None
    assert "OCR is not configured" in record["warnings"][0]
    assert document_storage.get_path(record["document_id"]).read_bytes() == data


def test_scanned_pdf_reports_ocr_as_not_configured(
    demo_storage,
    document_storage,
    monkeypatch,
):
    monkeypatch.setitem(app.dependency_overrides, get_ocr_adapter, lambda: None)
    registration = register_student()
    response = client.post(
        "/api/documents/upload",
        files={"file": ("scanned.pdf", synthetic_pdf([]), "application/pdf")},
        headers={"Authorization": f"Bearer {registration['token']}"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "ocr_not_configured"
    assert response.json()["ocr_status"] == "not_configured"
    assert all(value is None for value in response.json()["extracted_fields"].values())


def test_scanned_document_can_be_reprocessed_with_local_ocr(
    demo_storage,
    document_storage,
    monkeypatch,
):
    class SyntheticOCRAdapter:
        def extract_text(self, *, content, content_type):
            assert content == synthetic_pdf([])
            assert content_type == "application/pdf"
            return "Student Name: Reprocessed Student\nPercentage: 88"

    monkeypatch.setitem(app.dependency_overrides, get_ocr_adapter, lambda: None)
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    uploaded = client.post(
        "/api/documents/upload",
        files={"file": ("scanned.pdf", synthetic_pdf([]), "application/pdf")},
        headers=headers,
    )
    assert uploaded.status_code == 200
    document_id = uploaded.json()["document_id"]

    monkeypatch.setitem(
        app.dependency_overrides,
        get_ocr_adapter,
        lambda: SyntheticOCRAdapter(),
    )
    response = client.post(f"/api/documents/{document_id}/reprocess", headers=headers)

    assert response.status_code == 200
    record = response.json()
    assert record["ocr_status"] == "completed"
    assert record["extraction_status"] == "fields_extracted"
    assert record["extracted_fields"]["student_name"] == "Reprocessed Student"
    assert record["extracted_fields"]["percentage"] == 88
    assert record["verification_status"] == "not_verified"


def test_encrypted_pdf_is_reported_without_claiming_extraction(
    demo_storage,
    document_storage,
):
    registration = register_student()
    response = client.post(
        "/api/documents/upload",
        files={"file": ("encrypted.pdf", synthetic_encrypted_pdf(), "application/pdf")},
        headers={"Authorization": f"Bearer {registration['token']}"},
    )

    assert response.status_code == 200
    record = response.json()
    assert record["status"] == "extraction_failed"
    assert record["extraction_status"] == "encrypted_pdf"
    assert record["ocr_status"] == "not_configured"
    assert all(value is None for value in record["extracted_fields"].values())
    assert "encrypted" in record["warnings"][0].lower()
    assert record["verification_status"] == "not_verified"


def test_missing_pdf_fields_remain_unknown_with_supported_evidence_only(
    demo_storage,
    document_storage,
):
    registration = register_student()
    response = client.post(
        "/api/documents/upload",
        files={
            "file": (
                "partial.pdf",
                synthetic_pdf(["Institution: Synthetic Academy"]),
                "application/pdf",
            )
        },
        headers={"Authorization": f"Bearer {registration['token']}"},
    )

    assert response.status_code == 200
    record = response.json()
    assert record["extracted_fields"]["institution"] == "Synthetic Academy"
    assert record["extracted_fields"]["student_name"] is None
    assert record["extracted_fields"]["percentage"] is None
    assert record["extracted_fields"]["cgpa"] is None
    assert record["extraction_evidence"] == {
        "institution": ["Institution: Synthetic Academy"]
    }


def test_percentage_is_calculated_only_from_explicit_marks_and_maximum(
    demo_storage,
    document_storage,
):
    registration = register_student()
    response = client.post(
        "/api/documents/upload",
        files={
            "file": (
                "marks.pdf",
                synthetic_pdf(["Marks obtained: 450", "Maximum marks: 500"]),
                "application/pdf",
            )
        },
        headers={"Authorization": f"Bearer {registration['token']}"},
    )

    assert response.status_code == 200
    record = response.json()
    assert record["extracted_fields"]["marks"] == 450
    assert record["extracted_fields"]["maximum_marks"] == 500
    assert record["extracted_fields"]["percentage"] == 90
    assert record["extraction_methods"]["percentage"] == "calculated_from_marks"
    assert record["extraction_evidence"]["percentage"] == [
        "Marks obtained: 450",
        "Maximum marks: 500",
    ]


def test_cgpa_is_extracted_only_when_explicit_and_not_converted_to_percentage(
    demo_storage,
    document_storage,
):
    registration = register_student()
    response = client.post(
        "/api/documents/upload",
        files={
            "file": (
                "cgpa.pdf",
                synthetic_pdf(["CGPA: 8.5/10"]),
                "application/pdf",
            )
        },
        headers={"Authorization": f"Bearer {registration['token']}"},
    )

    assert response.status_code == 200
    record = response.json()
    assert record["extracted_fields"]["cgpa"] == 8.5
    assert record["extracted_fields"]["percentage"] is None
    assert record["extraction_evidence"]["cgpa"] == ["CGPA: 8.5/10"]


def test_configured_ocr_adapter_returns_a_reviewable_draft(
    demo_storage,
    document_storage,
    monkeypatch,
):
    class SyntheticOCRAdapter:
        def extract_text(self, *, content, content_type):
            assert content == synthetic_image("PNG")
            assert content_type == "image/png"
            return "Student Name: Synthetic OCR Student\nCGPA: 8.5/10"

    monkeypatch.setitem(
        app.dependency_overrides,
        get_ocr_adapter,
        lambda: SyntheticOCRAdapter(),
    )
    registration = register_student()
    response = client.post(
        "/api/documents/upload",
        files={"file": ("synthetic.png", synthetic_image("PNG"), "image/png")},
        headers={"Authorization": f"Bearer {registration['token']}"},
    )

    assert response.status_code == 200
    record = response.json()
    assert record["status"] == "review_required"
    assert record["extraction_status"] == "fields_extracted"
    assert record["ocr_status"] == "completed"
    assert record["extracted_fields"]["student_name"] == "Synthetic OCR Student"
    assert record["extracted_fields"]["cgpa"] == 8.5
    assert record["extraction_methods"]["cgpa"] == "labeled_ocr_text"
    assert record["verification_status"] == "not_verified"


@pytest.mark.parametrize(
    ("filename", "content", "content_type", "expected_status", "message"),
    [
        ("empty.pdf", b"", "application/pdf", 400, "empty"),
        ("unsupported.txt", b"sample", "text/plain", 415, "signature"),
        ("fake.pdf", b"not a PDF file", "application/pdf", 415, "signature"),
        ("malformed.pdf", b"%PDF-1.4\nnot a valid PDF body", "application/pdf", 400, "malformed"),
        ("../unsafe.pdf", synthetic_pdf(), "application/pdf", 400, "unsafe"),
    ],
)
def test_invalid_document_uploads_are_rejected(
    demo_storage,
    document_storage,
    filename,
    content,
    content_type,
    expected_status,
    message,
):
    registration = register_student()
    response = client.post(
        "/api/documents/upload",
        files={"file": (filename, content, content_type)},
        headers={"Authorization": f"Bearer {registration['token']}"},
    )

    assert response.status_code == expected_status
    assert message in response.json()["detail"].lower()
    assert not list(document_storage.root.glob("*.bin")) if document_storage.root.exists() else True


def test_document_upload_enforces_configured_size_limit(
    demo_storage,
    document_storage,
    monkeypatch,
):
    monkeypatch.setattr(
        "app.api.routes.documents.get_settings",
        lambda: SimpleNamespace(
            document_max_bytes=32,
            document_allowed_mime_types="application/pdf,image/jpeg,image/png",
        ),
    )
    registration = register_student()
    response = client.post(
        "/api/documents/upload",
        files={"file": ("large.pdf", synthetic_pdf(), "application/pdf")},
        headers={"Authorization": f"Bearer {registration['token']}"},
    )

    assert response.status_code == 413
    assert "32-byte limit" in response.json()["detail"]
    assert not list(document_storage.root.glob("*.bin")) if document_storage.root.exists() else True


def test_document_upload_enforces_configured_mime_types(
    demo_storage,
    document_storage,
    monkeypatch,
):
    monkeypatch.setattr(
        "app.api.routes.documents.get_settings",
        lambda: SimpleNamespace(
            document_max_bytes=1024 * 1024,
            document_allowed_mime_types="image/png",
        ),
    )
    registration = register_student()
    response = client.post(
        "/api/documents/upload",
        files={"file": ("excluded.pdf", synthetic_pdf(), "application/pdf")},
        headers={"Authorization": f"Bearer {registration['token']}"},
    )

    assert response.status_code == 415
    assert "not allowed" in response.json()["detail"].lower()


def test_document_upload_rejects_mime_and_signature_mismatch(
    demo_storage,
    document_storage,
):
    registration = register_student()
    response = client.post(
        "/api/documents/upload",
        files={"file": ("mismatched.jpg", synthetic_image("PNG"), "image/jpeg")},
        headers={"Authorization": f"Bearer {registration['token']}"},
    )

    assert response.status_code == 400
    assert "does not match" in response.json()["detail"].lower()


def test_upload_requires_authentication_and_documents_are_owner_scoped(
    demo_storage,
    document_storage,
):
    first_student = register_student()
    second_student = register_student()
    uploaded = client.post(
        "/api/documents/upload",
        files={"file": ("private.pdf", synthetic_pdf(), "application/pdf")},
        headers={"Authorization": f"Bearer {first_student['token']}"},
    )
    document_id = uploaded.json()["document_id"]

    assert client.post(
        "/api/documents/upload",
        files={"file": ("private.pdf", synthetic_pdf(), "application/pdf")},
    ).status_code == 401
    assert client.get("/api/documents").status_code == 401
    assert client.get(f"/api/documents/{document_id}").status_code == 401
    second_headers = {"Authorization": f"Bearer {second_student['token']}"}
    assert client.get(f"/api/documents/{document_id}", headers=second_headers).status_code == 404
    assert client.get(f"/api/documents/{document_id}/content", headers=second_headers).status_code == 404
    assert client.get(f"/private_documents/{document_id}.bin").status_code == 404
    assert client.get(f"/documents/{document_id}.bin").status_code == 404
    assert client.post(
        f"/api/documents/{document_id}/apply",
        json={"reviewed_fields": {}},
        headers=second_headers,
    ).status_code == 404


def test_duplicate_document_upload_is_rejected_for_the_same_student(
    demo_storage,
    document_storage,
):
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    first = client.post(
        "/api/documents/upload",
        files={"file": ("private.pdf", synthetic_pdf(), "application/pdf")},
        headers=headers,
    )
    assert first.status_code == 200

    duplicate = client.post(
        "/api/documents/upload",
        files={"file": ("private-copy.pdf", synthetic_pdf(), "application/pdf")},
        headers=headers,
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["status"] == "duplicate"
    assert duplicate.json()["detail"]["document_id"] == first.json()["document_id"]


def test_student_account_delete_removes_owned_profile_and_documents(
    demo_storage,
    document_storage,
):
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    uploaded = client.post(
        "/api/documents/upload",
        files={"file": ("private.pdf", synthetic_pdf(), "application/pdf")},
        headers=headers,
    )
    assert uploaded.status_code == 200
    document_id = uploaded.json()["document_id"]
    student_id = registration["user"]["id"]
    store = get_store()
    store.save_ai_recommendation({
        "student_id": student_id,
        "recommendation_id": "recommendation-delete-test",
        "created_at": "2026-01-01T00:00:00+00:00",
    })
    chat_session = store.create_chat_session(student_id)
    store.save_college(student_id, "synthetic-college-delete-test")

    deleted = client.delete("/api/profile", headers=headers)
    assert deleted.status_code == 200
    assert deleted.json()["status"] == "deleted"
    with pytest.raises(ValueError, match="Profile not found"):
        store.get_profile(student_id)
    assert document_storage.get_path(document_id) is None
    assert client.get("/api/profile", headers=headers).status_code == 401
    assert store.get_latest_ai_recommendation(student_id) is None
    assert store.get_chat_session(chat_session["session_id"], student_id) is None
    assert store.list_saved_colleges(student_id) == []


def test_student_account_delete_reports_document_storage_failure_and_can_be_retried(
    demo_storage,
    document_storage,
    monkeypatch,
):
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    uploaded = client.post(
        "/api/documents/upload",
        files={"file": ("private.pdf", synthetic_pdf(), "application/pdf")},
        headers=headers,
    )
    assert uploaded.status_code == 200
    student_id = registration["user"]["id"]
    document_id = uploaded.json()["document_id"]
    store = get_store()
    delete_document = document_storage.delete

    def fail_delete(_document_id):
        raise PermissionError("synthetic storage denial")

    monkeypatch.setattr(document_storage, "delete", fail_delete)
    failed_delete = client.delete("/api/profile", headers=headers)
    assert failed_delete.status_code == 503
    assert "account remains active" in failed_delete.json()["detail"]
    assert store.get_profile(student_id)["student_id"] == student_id
    assert store.get_document(document_id, student_id) is not None

    monkeypatch.setattr(document_storage, "delete", delete_document)
    deleted = client.delete("/api/profile", headers=headers)
    assert deleted.status_code == 200
    assert document_storage.get_path(document_id) is None
    with pytest.raises(ValueError, match="Profile not found"):
        store.get_profile(student_id)


def test_api_responses_include_basic_security_headers(demo_storage):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["referrer-policy"] == "no-referrer"


def test_document_storage_failures_are_reported_without_silent_fallback(
    demo_storage,
    document_storage,
    monkeypatch,
):
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    save_document = document_storage.save

    def fail_save(*_args, **_kwargs):
        raise PermissionError("synthetic storage denial")

    monkeypatch.setattr(document_storage, "save", fail_save)
    failed_upload = client.post(
        "/api/documents/upload",
        files={"file": ("private.pdf", synthetic_pdf(), "application/pdf")},
        headers=headers,
    )
    assert failed_upload.status_code == 503
    assert get_store().list_documents(registration["user"]["id"]) == []

    monkeypatch.setattr(document_storage, "save", save_document)
    uploaded = client.post(
        "/api/documents/upload",
        files={"file": ("private.pdf", synthetic_pdf(), "application/pdf")},
        headers=headers,
    )
    assert uploaded.status_code == 200
    document_id = uploaded.json()["document_id"]

    def fail_read(*_args, **_kwargs):
        raise PermissionError("synthetic storage denial")

    monkeypatch.setattr(document_storage, "get_path", fail_read)
    failed_download = client.get(
        f"/api/documents/{document_id}/content",
        headers=headers,
    )
    assert failed_download.status_code == 503


def test_student_can_review_document_fields_and_apply_them_to_profile(
    demo_storage,
    document_storage,
):
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    uploaded = client.post(
        "/api/documents/upload",
        files={"file": ("review.pdf", synthetic_pdf(), "application/pdf")},
        headers=headers,
    )
    document_id = uploaded.json()["document_id"]
    reviewed_fields = {
        "student_name": "Corrected Synthetic Name",
        "institution": "Reviewed Synthetic Institute",
        "qualification": "Class XII",
        "marks": 455,
        "maximum_marks": 500,
        "percentage": 91,
        "examination_year": 2025,
        "cgpa": 8.5,
    }

    response = client.post(
        f"/api/documents/{document_id}/apply",
        json={"reviewed_fields": reviewed_fields},
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json()["status"] == "reviewed"
    assert response.json()["reviewed_fields"] == reviewed_fields
    assert response.json()["verification_status"] == "not_verified"
    profile = client.get("/api/profile", headers=headers).json()
    assert profile["academic_score"] == 91
    assert profile["academic_documents"][0]["student_name"] == "Corrected Synthetic Name"
    assert profile["academic_documents"][0]["cgpa"] == 8.5


def test_pdf_text_extraction_failure_is_reported_without_fabricated_fields(
    demo_storage,
    document_storage,
    monkeypatch,
):
    def fail_extraction(_text, *_args, **_kwargs):
        raise ValueError("synthetic extraction failure")

    monkeypatch.setattr("app.documents.processing.extract_academic_fields", fail_extraction)
    registration = register_student()
    response = client.post(
        "/api/documents/upload",
        files={"file": ("extraction-error.pdf", synthetic_pdf(), "application/pdf")},
        headers={"Authorization": f"Bearer {registration['token']}"},
    )

    assert response.status_code == 200
    record = response.json()
    assert record["status"] == "extraction_failed"
    assert record["verification_status"] == "not_verified"
    assert all(value is None for value in record["extracted_fields"].values())
    assert "text extraction failed" in record["warnings"][0].lower()


def test_document_storage_rejects_frontend_public_directories(tmp_path):
    public_path = (
        Path(__file__).resolve().parents[2]
        / "frontend"
        / "public"
        / "documents"
    )
    storage = LocalDocumentStorage(public_path)

    with pytest.raises(RuntimeError, match="outside the frontend"):
        storage.save(f"doc-{uuid4().hex}", b"synthetic content")

    assert not public_path.exists()


def test_external_application_intent_and_explicit_submission(demo_storage):
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}

    started = client.post(
        "/api/applications/external-intent",
        json={
            "exam": "CUET UG",
            "institution": "Hindu College",
            "programme": "B.A. (Hons.) Political Science",
            "admission_cycle": 2026,
            "official_application_url": "https://admission.uod.ac.in/",
            "official_website": "https://www.hindu.du.ac.in/",
        },
        headers=headers,
    )
    assert started.status_code == 201
    application = started.json()
    assert application["status"] == "application_started"
    assert application["source"] == "external_application"
    assert application["submitted_at"] is None

    repeated = client.post(
        "/api/applications/external-intent",
        json={
            "exam": "CUET UG",
            "institution": "Hindu College",
            "programme": "B.A. (Hons.) Political Science",
            "admission_cycle": 2026,
            "official_application_url": "https://admission.uod.ac.in/",
            "official_website": "https://www.hindu.du.ac.in/",
        },
        headers=headers,
    )
    assert repeated.status_code == 201
    assert repeated.json()["application_id"] == application["application_id"]

    confirmed = client.post(
        f"/api/applications/{application['application_id']}/confirm-external-submission",
        headers=headers,
    )
    assert confirmed.status_code == 200
    assert confirmed.json()["status"] == "submitted"
    assert confirmed.json()["submitted_at"] is not None


def test_external_application_intent_rejects_http_urls(demo_storage):
    registration = register_student()
    response = client.post(
        "/api/applications/external-intent",
        json={
            "exam": "CUET UG",
            "institution": "Example College",
            "programme": "Example Programme",
            "admission_cycle": 2026,
            "official_application_url": "http://example.com/apply",
        },
        headers={"Authorization": f"Bearer {registration['token']}"},
    )
    assert response.status_code == 422


def test_student_registration_and_login_contract(demo_storage):
    registration = register_student()
    login = client.post(
        "/api/auth/login",
        json={
            "email": registration["user"]["email"],
            "password": "StrongPassword123!",
        },
    )

    assert login.status_code == 200
    assert login.json()["user"]["role"] == "student"
    assert login.json()["token"]


def test_profile_intake_requires_authentication(demo_storage):
    response = client.post(
        "/api/profile/intake",
        json={"description": "I studied science and enjoy biology and chemistry."},
    )

    assert response.status_code == 401


def test_profile_intake_schema_normalizes_common_model_placeholders():
    model_output = {
        **INTAKE_PROFILE,
        "academic_score": "not provided",
        "exam_scores": "{}",
        "budget": "unknown",
        "interests": "biology",
        "preferred_courses": "none",
        "missing_information": None,
        "clarification_questions": "Which state do you prefer?",
    }

    parsed = ProfileIntakeData.model_validate(model_output)

    assert parsed.academic_score is None
    assert parsed.exam_scores == {}
    assert parsed.budget is None
    assert parsed.interests == ["biology"]
    assert parsed.preferred_courses == []
    assert parsed.missing_information == []
    assert parsed.clarification_questions == ["Which state do you prefer?"]


def test_profile_intake_returns_validated_output_without_saving_it(demo_storage, monkeypatch):
    provider = StubOllamaProvider(result=INTAKE_PROFILE)
    monkeypatch.setattr("app.api.routes.profile.get_llm_provider", lambda: provider)
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    profile_before = client.get("/api/profile", headers=headers).json()

    response = client.post(
        "/api/profile/intake",
        json={"description": "I studied science, enjoy biology and chemistry, and prefer biotechnology."},
        headers=headers,
    )

    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "model_generated"
    assert result["provider"] == "ollama"
    assert result["profile"]["preferred_courses"] == ["BSc Biotechnology"]
    assert result["persisted"] is False
    assert client.get("/api/profile", headers=headers).json() == profile_before
    assert provider.calls == 1


def test_profile_intake_rejects_malformed_output(demo_storage, monkeypatch):
    provider = StubOllamaProvider(result="not valid JSON")
    monkeypatch.setattr("app.api.routes.profile.get_llm_provider", lambda: provider)
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}

    response = client.post(
        "/api/profile/intake",
        json={"description": "I studied science and enjoy biology and chemistry."},
        headers=headers,
    )

    assert response.status_code == 502
    assert response.json()["detail"]["status"] == "invalid_output"
    assert "not valid JSON" not in response.text


def test_profile_intake_reports_unavailable_ollama(demo_storage, monkeypatch):
    provider = StubOllamaProvider(available=False)
    monkeypatch.setattr("app.api.routes.profile.get_llm_provider", lambda: provider)
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}

    response = client.post(
        "/api/profile/intake",
        json={"description": "I studied science and enjoy biology and chemistry."},
        headers=headers,
    )

    assert response.status_code == 503
    assert response.json()["detail"]["status"] == "unavailable"
    assert provider.calls == 0


def test_profile_intake_rejects_nonlocal_ollama_endpoint(demo_storage, monkeypatch):
    provider = StubOllamaProvider(result=INTAKE_PROFILE, base_url="http://example.invalid:11434")
    monkeypatch.setattr("app.api.routes.profile.get_llm_provider", lambda: provider)
    registration = register_student()

    response = client.post(
        "/api/profile/intake",
        json={"description": "I studied science and enjoy biology and chemistry."},
        headers={"Authorization": f"Bearer {registration['token']}"},
    )

    assert response.status_code == 503
    assert response.json()["detail"]["status"] == "local_provider_required"
    assert provider.calls == 0


def test_profile_intake_reports_timeout(demo_storage, monkeypatch):
    provider = StubOllamaProvider(error=httpx.TimeoutException("private timeout detail"))
    monkeypatch.setattr("app.api.routes.profile.get_llm_provider", lambda: provider)
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}

    response = client.post(
        "/api/profile/intake",
        json={"description": "I studied science and enjoy biology and chemistry."},
        headers=headers,
    )

    assert response.status_code == 504
    assert response.json()["detail"]["status"] == "timeout"
    assert "private timeout detail" not in response.text


def test_profile_intake_reports_model_error_without_leaking_provider_detail(demo_storage, monkeypatch):
    provider = StubOllamaProvider(error=LLMResponseError("private model response"))
    monkeypatch.setattr("app.api.routes.profile.get_llm_provider", lambda: provider)
    registration = register_student()

    response = client.post(
        "/api/profile/intake",
        json={"description": "I studied science and enjoy biology and chemistry."},
        headers={"Authorization": f"Bearer {registration['token']}"},
    )

    assert response.status_code == 502
    assert response.json()["detail"]["status"] == "model_error"
    assert "private model response" not in response.text


def test_profile_intake_rejects_attempt_to_target_another_student(demo_storage, monkeypatch):
    provider = StubOllamaProvider(result=INTAKE_PROFILE)
    monkeypatch.setattr("app.api.routes.profile.get_llm_provider", lambda: provider)
    first_student = register_student()
    second_student = register_student()
    headers = {"Authorization": f"Bearer {first_student['token']}"}
    second_headers = {"Authorization": f"Bearer {second_student['token']}"}
    second_profile_before = client.get("/api/profile", headers=second_headers).json()

    response = client.post(
        "/api/profile/intake",
        json={
            "description": "I studied science and enjoy biology and chemistry.",
            "student_id": second_student["user"]["id"],
        },
        headers=headers,
    )

    assert response.status_code == 422
    assert client.get("/api/profile", headers=second_headers).json() == second_profile_before
    assert provider.calls == 0


def test_demo_mode_is_disclosed_and_never_used_for_profile_intake(demo_storage, monkeypatch):
    demo_provider = DemoLLMProvider()
    monkeypatch.setattr("app.api.routes.ai.get_llm_provider", lambda: demo_provider)
    monkeypatch.setattr("app.api.routes.profile.get_llm_provider", lambda: demo_provider)
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}

    status_response = client.get("/api/ai/status", headers=headers)
    intake_response = client.post(
        "/api/profile/intake",
        json={"description": "I studied science and enjoy biology and chemistry."},
        headers=headers,
    )

    assert status_response.status_code == 200
    assert status_response.json()["fallback_active"] is True
    assert status_response.json()["mode"] == "demo"
    assert status_response.json()["connected"] is False
    assert status_response.json()["inference_verified"] is False
    assert intake_response.status_code == 503
    assert intake_response.json()["detail"]["status"] == "local_provider_required"
    assert "profile" not in intake_response.json()


@pytest.mark.parametrize(
    ("status_details", "expected_mode", "expected_message"),
    [
        (
            {
                "mode": "ollama_unavailable",
                "service_reachable": False,
                "model_available": False,
                "inference_verified": False,
                "connected": False,
                "error_code": "ollama_unavailable",
            },
            "ollama_unavailable",
            "ollama serve",
        ),
        (
            {
                "mode": "model_missing",
                "service_reachable": True,
                "model_available": False,
                "inference_verified": False,
                "connected": False,
                "error_code": "model_missing",
            },
            "model_missing",
            "ollama pull test-model",
        ),
        (
            {
                "mode": "inference_failed",
                "service_reachable": True,
                "model_available": True,
                "inference_verified": False,
                "connected": False,
                "error_code": "inference_failed",
            },
            "inference_failed",
            "inference check failed",
        ),
    ],
)
def test_ai_status_discloses_ollama_failure_state(
    demo_storage,
    monkeypatch,
    status_details,
    expected_mode,
    expected_message,
):
    provider = OllamaLLMProvider(
        base_url="http://localhost:11434",
        model="test-model",
        timeout=1.0,
        max_retries=0,
    )
    monkeypatch.setattr(provider, "inference_status", lambda: status_details)
    monkeypatch.setattr("app.api.routes.ai.get_llm_provider", lambda: provider)
    registration = register_student()

    response = client.get(
        "/api/ai/status",
        headers={"Authorization": f"Bearer {registration['token']}"},
    )

    assert response.status_code == 200
    result = response.json()
    assert result["mode"] == expected_mode
    assert result["connected"] is False
    assert result["inference_verified"] is False
    assert expected_message in result["message"]


def test_ai_recommendations_are_authenticated_and_persist_latest_run(demo_storage):
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}

    assert client.post("/api/ai/recommendations/generate").status_code == 401
    response = client.post("/api/ai/recommendations/generate", headers=headers)

    assert response.status_code == 200
    assert response.json()["status"] == "insufficient_data"
    assert response.json()["recommendations"] == []
    assert client.get("/api/ai/recommendations", headers=headers).json() == response.json()
    history = client.get("/api/ai/recommendations/history", headers=headers)
    assert history.status_code == 200
    assert len(history.json()) == 1


def test_ai_recommendations_compare_exact_historical_rows_without_claiming_eligibility():
    dataset = load_mhtcet_dataset()
    directory = build_college_directory(dataset, [])
    college = next(
        item for item in directory.colleges
        if any(
            cutoff.exam in {"MHT-CET", "JEE Main"}
            and cutoff.category
            and cutoff.historical_closing_rank is not None
            for cutoff in item.historical_cutoffs
        )
    )
    cutoff = next(
        item for item in college.historical_cutoffs
        if item.exam in {"MHT-CET", "JEE Main"}
        and item.category
        and item.historical_closing_rank is not None
    )
    exam_key = "MHT-CET" if cutoff.exam == "MHT-CET" else "JEE Main"
    profile = {
        "exam_ranks": {exam_key: 1},
        "reservation_category": cutoff.category,
        "preferred_fields": [cutoff.course],
        "location": college.city or college.state,
    }

    result = generate_recommendations("synthetic-student", profile, dataset, [])
    recommendation = next(
        item for item in result["recommendations"]
        if item["college_id"] == college.college_id and item["course"] == cutoff.course
    )

    assert recommendation["tier"] == "safe"
    assert recommendation["historical_cutoffs"]
    assert recommendation["missing_criteria"] == [
        "No matching current verified institution eligibility criteria are available."
    ]
    assert "guarantee" in result["disclaimer"].lower()


def test_ai_recommendations_do_not_return_unmatched_preferred_courses():
    dataset = load_mhtcet_dataset()
    directory = build_college_directory(dataset, [])
    cutoff = next(
        item
        for college in directory.colleges
        for item in college.historical_cutoffs
        if item.exam in {"MHT-CET", "JEE Main"}
        and item.category
        and item.historical_closing_rank is not None
    )
    exam_key = "MHT-CET" if cutoff.exam == "MHT-CET" else "JEE Main"

    result = generate_recommendations(
        "synthetic-student",
        {
            "exam_ranks": {exam_key: 1},
            "reservation_category": cutoff.category,
            "preferred_fields": ["No matching branch in this test dataset"],
        },
        dataset,
        [],
    )

    assert result["recommendations"] == []


def test_ai_chat_uses_local_ollama_and_keeps_sessions_student_scoped(
    demo_storage,
    monkeypatch,
):
    provider = StubOllamaProvider(result={})
    provider.chat = lambda messages: "The application portal is https://unverified.example/apply"
    monkeypatch.setattr("app.api.routes.ai.get_llm_provider", lambda: provider)
    student = register_student()
    other_student = register_student()
    headers = {"Authorization": f"Bearer {student['token']}"}
    other_headers = {"Authorization": f"Bearer {other_student['token']}"}
    directory = build_college_directory(load_mhtcet_dataset(), [])
    college_id = directory.colleges[0].college_id

    response = client.post(
        "/api/ai/chat",
        headers=headers,
        json={
            "message": "Which details are listed about this college?",
            "context_college_id": college_id,
        },
    )

    assert response.status_code == 200
    result = response.json()
    assert result["answer"] == "The application portal is [unverified link omitted]"
    assert any(item["source_id"] == f"college:{college_id}" for item in result["sources"])
    session_id = result["session"]["session_id"]
    follow_up = client.post(
        "/api/ai/chat",
        headers=headers,
        json={"message": "And what about its website?", "session_id": session_id},
    )
    assert follow_up.status_code == 200
    assert any(item["source_id"] == f"college:{college_id}" for item in follow_up.json()["sources"])
    assert client.get(f"/api/ai/chat/sessions/{session_id}", headers=headers).status_code == 200
    assert client.get(
        f"/api/ai/chat/sessions/{session_id}",
        headers=other_headers,
    ).status_code == 404
    assert client.delete(
        f"/api/ai/chat/sessions/{session_id}",
        headers=headers,
    ).status_code == 204
    provider.close()


def test_ai_chat_returns_explicit_unknown_without_retrieved_facts(demo_storage, monkeypatch):
    monkeypatch.setattr(
        "app.api.routes.ai.get_llm_provider",
        lambda: pytest.fail("No Ollama call should be made without relevant records."),
    )
    registration = register_student()

    response = client.post(
        "/api/ai/chat",
        headers={"Authorization": f"Bearer {registration['token']}"},
        json={"message": "What is the application deadline?"},
    )

    assert response.status_code == 200
    assert response.json()["answer"] == "I don't have verified information about this yet."
    assert response.json()["sources"] == []


def test_ai_chat_refuses_remote_ollama_before_sending_profile_data(
    demo_storage,
    monkeypatch,
):
    provider = StubOllamaProvider(base_url="https://ollama.example")
    provider.chat = lambda messages: pytest.fail("Remote Ollama must not receive student data.")
    monkeypatch.setattr("app.api.routes.ai.get_llm_provider", lambda: provider)
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    college_id = build_college_directory(load_mhtcet_dataset(), []).colleges[0].college_id

    response = client.post(
        "/api/ai/chat",
        headers=headers,
        json={
            "message": "What is the verified information about this college?",
            "context_college_id": college_id,
        },
    )

    assert response.status_code == 503
    assert response.json()["detail"]["status"] == "local_provider_required"
    provider.close()


def test_ai_saved_college_rejects_ids_not_in_uploaded_dataset(demo_storage):
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    directory = build_college_directory(load_mhtcet_dataset(), [])

    response = client.post(
        "/api/ai/saved-colleges",
        headers=headers,
        json={"college_id": directory.colleges[0].college_id},
    )
    rejected = client.post(
        "/api/ai/saved-colleges",
        headers=headers,
        json={"college_id": "invented-college-id"},
    )

    assert response.status_code == 200
    assert response.json()["college_id"] == directory.colleges[0].college_id
    assert rejected.status_code == 404
    assert client.get("/api/ai/saved-colleges", headers=headers).json() == [response.json()]


@pytest.mark.ollama
def test_local_ollama_profile_intake_smoke(demo_storage, monkeypatch):
    if os.getenv("RUN_OLLAMA_SMOKE") != "1":
        pytest.skip("Set RUN_OLLAMA_SMOKE=1 to run the optional local Ollama smoke test.")

    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    monkeypatch.setenv("OLLAMA_MODEL", "llama3.2:3b")
    get_settings.cache_clear()
    provider = get_llm_provider()
    if not isinstance(provider, OllamaLLMProvider):
        pytest.skip("Configured provider is not Ollama.")
    if not provider.is_local:
        provider.close()
        pytest.skip("Configured Ollama endpoint is not loopback.")
    available = provider.is_available
    provider.close()
    if not available:
        pytest.skip("Local Ollama is unavailable.")

    registration = register_student()
    status_response = client.get(
        "/api/ai/status",
        headers={"Authorization": f"Bearer {registration['token']}"},
    )
    assert status_response.status_code == 200
    assert status_response.json()["connected"] is True
    assert status_response.json()["inference_verified"] is True
    assert status_response.json()["model"] == "llama3.2:3b"
    response = client.post(
        "/api/profile/intake",
        json={
            "description": "I completed science studies, enjoy biology, prefer biotechnology, and have a moderate budget."
        },
        headers={"Authorization": f"Bearer {registration['token']}"},
    )

    assert response.status_code == 200
    assert response.json()["provider"] == "ollama"
    assert response.json()["persisted"] is False


def test_recommendations_interview_and_allocation_flow(demo_storage):
    email = f"student-{uuid4().hex[:8]}@example.com"
    register_response = client.post(
        "/api/auth/register",
        json={
            "full_name": "Practice Student",
            "email": email,
            "password": "StrongPassword123!",
            "role": "student",
        },
    )
    token = register_response.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    recommendations = client.get("/api/recommendations", headers=headers)
    assert recommendations.status_code == 200
    assert len(recommendations.json()) >= 1
    assert all(
        item["eligibility_status"] == "criteria_unavailable"
        for item in recommendations.json()
    )
    assert all(item["match_score"] is None for item in recommendations.json())
    assert client.get("/api/eligibility", headers=headers).json() == recommendations.json()

    interview = client.post(
        "/api/interviews",
        json={"student_id": register_response.json()["user"]["id"], "stream": "B.Tech", "question_count": 3, "mode": "text"},
        headers=headers,
    )
    assert interview.status_code == 200
    assert interview.json()["stream"] == "B.Tech"
    other_student_interview = client.post(
        "/api/interviews",
        json={"student_id": "another-student", "stream": "B.Tech", "question_count": 3, "mode": "text"},
        headers=headers,
    )
    assert other_student_interview.status_code == 403

    allocation = client.post(
        "/api/allocation/simulate",
        json={
            "student_id": register_response.json()["user"]["id"],
            "preferences": ["VIT Vellore", "Manipal Institute of Technology"],
            "budget": 2500000,
            "category": "General",
        },
        headers=headers,
    )
    assert allocation.status_code == 200
    assert allocation.json()["waitlist_status"] == "unallocated"
    assert any("not found in the configured program catalog" in item for item in allocation.json()["explanation"])


def interview_feedback_output(evidence):
    return {
        "summary": "The answer gave a concrete example for practice discussion.",
        "dimensions": [
            {
                "dimension": "relevance",
                "score": 4,
                "explanation": "The answer connects an example to the selected program.",
                "evidence": evidence,
            },
            {
                "dimension": "clarity",
                "score": 3,
                "explanation": "The example is understandable; consider a more concise structure.",
                "evidence": evidence,
            },
            {
                "dimension": "reasoning",
                "score": 3,
                "explanation": "The answer includes a stated reason.",
                "evidence": evidence,
            },
            {
                "dimension": "completeness",
                "score": 3,
                "explanation": "The answer includes an example but could include its outcome.",
                "evidence": evidence,
            },
        ],
    }


def create_interview(headers, *, program="Synthetic Data Science Program", question_count=2, mode="text"):
    return client.post(
        "/api/interviews",
        json={
            "program": program,
            "interview_type": "technical",
            "question_count": question_count,
            "mode": mode,
        },
        headers=headers,
    )


def test_video_interview_mode_is_persisted(demo_storage):
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}

    created = create_interview(headers, mode="video")

    assert created.status_code == 200
    assert created.json()["mode"] == "video"


def test_interview_session_lifecycle_fallback_feedback_and_invalid_transitions(demo_storage):
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    created = create_interview(headers, question_count=1)

    assert created.status_code == 200
    session = created.json()
    assert session["status"] == "created"
    assert session["program"] == "Synthetic Data Science Program"
    assert session["turns"] == []
    assert client.post(
        f"/api/interviews/{session['interview_id']}/answers",
        json={"answer": "A synthetic answer."},
        headers=headers,
    ).status_code == 409

    started = client.post(
        f"/api/interviews/{session['interview_id']}/start",
        headers=headers,
    )
    assert started.status_code == 200
    session = started.json()
    assert session["status"] == "in_progress"
    assert session["generation_mode"] == "deterministic_fallback"
    assert "not AI-generated" in session["generation_notice"]
    assert len(session["turns"]) == 1
    assert session["turns"][0]["answer"] is None
    assert session["turns"][0]["generation_mode"] == "deterministic_fallback"
    assert client.post(
        f"/api/interviews/{session['interview_id']}/start",
        headers=headers,
    ).status_code == 409

    completed = client.post(
        f"/api/interviews/{session['interview_id']}/answers",
        json={"answer": "I built a small synthetic project because it relates to this program."},
        headers=headers,
    )
    assert completed.status_code == 200
    result = completed.json()
    assert result["status"] == "completed"
    assert result["turns"][0]["answered_at"] is not None
    assert result["completed_at"] is not None
    assert result["feedback"]["generation_mode"] == "deterministic_fallback"
    assert "not a validated measurement" in result["feedback"]["disclaimer"]
    assert {item["dimension"] for item in result["feedback"]["dimensions"]} == {
        "relevance",
        "clarity",
        "reasoning",
        "completeness",
    }
    assert all(item["evidence"] for item in result["feedback"]["dimensions"])
    assert client.post(
        f"/api/interviews/{session['interview_id']}/answers",
        json={"answer": "A second answer is not allowed."},
        headers=headers,
    ).status_code == 409
    assert client.get(
        f"/api/interviews/{session['interview_id']}",
        headers=headers,
    ).json() == result


def test_interview_sessions_are_persisted_and_owner_scoped(demo_storage):
    first = register_student()
    second = register_student()
    first_headers = {"Authorization": f"Bearer {first['token']}"}
    second_headers = {"Authorization": f"Bearer {second['token']}"}
    created = create_interview(first_headers)
    interview_id = created.json()["interview_id"]

    first_history = client.get("/api/interviews", headers=first_headers)
    assert first_history.status_code == 200
    assert [item["interview_id"] for item in first_history.json()] == [interview_id]
    assert client.get(
        f"/api/interviews/{interview_id}",
        headers=second_headers,
    ).status_code == 404
    assert client.get("/api/interviews", headers=second_headers).json() == []
    assert client.get("/api/interviews").status_code == 401
    assert client.post(
        "/api/interviews",
        json={
            "student_id": first["user"]["id"],
            "program": "Synthetic Program",
        },
        headers=second_headers,
    ).status_code == 403

    university_login = client.post(
        "/api/auth/login",
        json={"email": "admin@uniapply.ai", "password": "AdminPass123!"},
    )
    university_headers = {"Authorization": f"Bearer {university_login.json()['token']}"}
    assert client.get("/api/interviews", headers=university_headers).status_code == 403


def test_interview_progression_uses_local_ollama_and_validated_rubric(demo_storage, monkeypatch):
    evidence = "I built a small synthetic project."
    provider = SequencedInterviewProvider(
        [
            {"question": "What data problem would you explore in this program?"},
            {"question": "What did you learn from that project and why?"},
            interview_feedback_output(evidence),
        ]
    )
    monkeypatch.setattr("app.agents.interview_agent.get_llm_provider", lambda: provider)
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    profile = get_store().get_profile(registration["user"]["id"])
    profile["phone"] = "synthetic-private-phone"
    get_store().update_profile(registration["user"]["id"], profile)
    created = create_interview(headers, question_count=2)
    interview_id = created.json()["interview_id"]

    started = client.post(
        f"/api/interviews/{interview_id}/start",
        headers=headers,
    )
    assert started.status_code == 200
    assert started.json()["turns"][0]["generation_mode"] == "ollama"

    answer_text = "I built a small synthetic project. I chose it because it connects data and design."
    progressed = client.post(
        f"/api/interviews/{interview_id}/answers",
        json={"answer": answer_text},
        headers=headers,
    )
    assert progressed.status_code == 200
    assert progressed.json()["status"] == "in_progress"
    assert progressed.json()["turns"][1]["question"] == "What did you learn from that project and why?"
    assert answer_text in provider.prompts[1]
    assert registration["user"]["email"] not in provider.prompts[0]
    assert "synthetic-private-phone" not in provider.prompts[0]

    completed = client.post(
        f"/api/interviews/{interview_id}/answers",
        json={"answer": answer_text},
        headers=headers,
    )
    assert completed.status_code == 200
    result = completed.json()
    assert result["status"] == "completed"
    assert result["generation_mode"] == "ollama"
    assert result["feedback"]["generation_mode"] == "ollama"
    assert result["feedback"]["dimensions"][0]["evidence"] == evidence
    assert result["feedback"]["disclaimer"].startswith("Practice feedback only.")
    assert len(provider.prompts) == 3


def test_interview_ollama_outage_is_reported_without_fallback(demo_storage, monkeypatch):
    provider = SequencedInterviewProvider(available=False)
    monkeypatch.setattr("app.agents.interview_agent.get_llm_provider", lambda: provider)
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    created = create_interview(headers, question_count=1)

    started = client.post(
        f"/api/interviews/{created.json()['interview_id']}/start",
        headers=headers,
    )

    assert started.status_code == 503
    assert started.json()["detail"]["status"] == "ollama_unavailable"
    assert provider.prompts == []


def test_malformed_interview_output_is_reported_without_fallback(demo_storage, monkeypatch):
    provider = SequencedInterviewProvider(
        [
            {"question": "short"},
            {"summary": "Missing required rubric dimensions"},
        ]
    )
    monkeypatch.setattr("app.agents.interview_agent.get_llm_provider", lambda: provider)
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    created = create_interview(headers, question_count=1)

    started = client.post(
        f"/api/interviews/{created.json()['interview_id']}/start",
        headers=headers,
    )
    assert started.status_code == 502
    assert started.json()["detail"]["status"] == "inference_failed"
    assert provider.prompts
    assert client.post(
        f"/api/interviews/{created.json()['interview_id']}/answers",
        json={"answer": "I completed a synthetic project because it was relevant."},
        headers=headers,
    ).status_code == 409


def test_interview_answer_length_and_session_creation_are_validated(demo_storage):
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    assert client.post("/api/interviews", json={}, headers=headers).status_code == 422
    assert client.post(
        "/api/interviews",
        json={"program": "Synthetic Program", "question_count": 0},
        headers=headers,
    ).status_code == 422
    assert client.post(
        "/api/interviews",
        json={"program": "Synthetic Program", "question_count": 11},
        headers=headers,
    ).status_code == 422

    created = create_interview(headers, question_count=1)
    interview_id = created.json()["interview_id"]
    client.post(f"/api/interviews/{interview_id}/start", headers=headers)
    for answer in ("   ", "a" * 5001):
        response = client.post(
            f"/api/interviews/{interview_id}/answers",
            json={"answer": answer},
            headers=headers,
        )
        assert response.status_code == 422
    other_student_allocation = client.post(
        "/api/allocation/simulate",
        json={
            "student_id": "another-student",
            "preferences": ["VIT Vellore"],
            "budget": 2500000,
            "category": "General",
        },
        headers=headers,
    )
    assert other_student_allocation.status_code == 403


def test_eligibility_passes_when_all_configured_rules_are_met(demo_storage):
    criteria = synthetic_program_criteria(
        minimum_percentage=75,
        required_subjects=["Synthetic Mathematics"],
        examination_type="Synthetic Exam",
        examination_cutoff=60,
        admission_year=2026,
        required_category="Synthetic Category",
        required_domicile="Synthetic Region",
    )
    get_store().replace_program_criteria([criteria])
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    update = client.post(
        "/api/profile",
        json={
            "academic_score": 82,
            "subject_scores": {"Synthetic Mathematics": 88},
            "exam_scores": {"Synthetic Exam": 72},
            "admission_year": 2026,
            "reservation_category": "Synthetic Category",
            "domicile": "Synthetic Region",
        },
        headers=headers,
    )
    assert update.status_code == 200

    response = client.get("/api/eligibility", headers=headers)

    assert response.status_code == 200
    result = response.json()[0]
    assert result["eligibility_status"] == "eligible"
    assert {item["status"] for item in result["evaluated_criteria"]} == {"met"}
    assert result["match_score"] is None
    assert result["competitiveness"] == "not_assessed"


def test_eligibility_fails_when_a_configured_threshold_is_not_met(demo_storage):
    criteria = synthetic_program_criteria(minimum_percentage=75)
    get_store().replace_program_criteria([criteria])
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    client.post("/api/profile", json={"academic_score": 69}, headers=headers)

    response = client.get("/api/eligibility", headers=headers)

    assert response.status_code == 200
    result = response.json()[0]
    assert result["eligibility_status"] == "ineligible"
    assert result["evaluated_criteria"][0]["status"] == "not_met"
    assert "below" in result["reasons"][0].lower()


def test_missing_student_data_yields_insufficient_data(demo_storage):
    get_store().replace_program_criteria(
        [
            synthetic_program_criteria(
                minimum_percentage=70,
                examination_type="Synthetic Exam",
                examination_cutoff=60,
            )
        ]
    )
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    client.post("/api/profile", json={"academic_score": 82}, headers=headers)
    cleared = client.post("/api/profile", json={"academic_score": None}, headers=headers)
    assert cleared.status_code == 200
    assert cleared.json()["academic_score"] is None

    result = client.get("/api/eligibility", headers=headers).json()[0]

    assert result["eligibility_status"] == "insufficient_data"
    assert "Academic percentage is missing." in result["missing_info"]
    assert "Synthetic Exam score is missing." in result["missing_info"]
    assert all(item["status"] == "unknown" for item in result["evaluated_criteria"])


def test_missing_eligibility_criteria_is_not_treated_as_eligible(demo_storage):
    get_store().replace_program_criteria([synthetic_program_criteria(minimum_percentage=None)])
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}

    result = client.get("/api/eligibility", headers=headers).json()[0]

    assert result["eligibility_status"] == "criteria_unavailable"
    assert result["evaluated_criteria"][0]["status"] == "unknown"
    assert "Eligibility criteria are missing." in result["missing_info"]

    get_store().replace_program_criteria([])
    assert client.get("/api/eligibility", headers=headers).json() == []


def test_required_subject_is_unknown_until_a_score_is_explicitly_supplied(demo_storage):
    get_store().replace_program_criteria(
        [synthetic_program_criteria(required_subjects=["Synthetic Mathematics"])]
    )
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    client.post("/api/profile", json={"academic_score": 90}, headers=headers)

    missing = client.get("/api/eligibility", headers=headers).json()[0]
    assert missing["eligibility_status"] == "insufficient_data"
    assert "Subject score for Synthetic Mathematics is missing." in missing["missing_info"]

    updated = client.post(
        "/api/profile",
        json={"subject_scores": {"Synthetic Mathematics": 80}},
        headers=headers,
    )
    assert updated.status_code == 200
    matched = client.get("/api/eligibility", headers=headers).json()[0]
    assert matched["eligibility_status"] == "eligible"


def test_reviewed_marks_and_qualification_are_evaluated_against_configured_criteria(
    demo_storage,
    document_storage,
):
    get_store().replace_program_criteria(
        [
            synthetic_program_criteria(
                minimum_percentage=None,
                minimum_marks=70,
                marks_out_of=100,
                required_qualifications=["Synthetic Class XII"],
            )
        ]
    )
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    uploaded = client.post(
        "/api/documents/upload",
        files={"file": ("marks.pdf", synthetic_pdf(), "application/pdf")},
        headers=headers,
    )
    document_id = uploaded.json()["document_id"]

    before_review = client.get("/api/eligibility", headers=headers).json()[0]
    assert before_review["eligibility_status"] == "insufficient_data"

    reviewed = client.post(
        f"/api/documents/{document_id}/apply",
        json={
            "reviewed_fields": {
                "qualification": "Synthetic Class XII",
                "marks": 400,
                "maximum_marks": 500,
            }
        },
        headers=headers,
    )
    assert reviewed.status_code == 200

    result = client.get("/api/eligibility", headers=headers).json()[0]
    assert result["eligibility_status"] == "eligible"
    assert {item["status"] for item in result["evaluated_criteria"]} == {"met"}
    assert any("80 out of the configured 100 scale" in item["explanation"] for item in result["evaluated_criteria"])


def test_examination_cutoff_supports_explicit_minimum_or_maximum_comparison(demo_storage):
    criteria = synthetic_program_criteria(
        minimum_percentage=None,
        examination_type="Synthetic Rank Score",
        examination_cutoff=80,
        examination_comparison="maximum",
    )
    get_store().replace_program_criteria([criteria])
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}
    client.post(
        "/api/profile",
        json={"exam_scores": {"Synthetic Rank Score": 75}},
        headers=headers,
    )

    result = client.get("/api/eligibility", headers=headers).json()[0]
    assert result["eligibility_status"] == "eligible"
    assert result["evaluated_criteria"][0]["status"] == "met"

    client.post(
        "/api/profile",
        json={"exam_scores": {"Synthetic Rank Score": 85}},
        headers=headers,
    )
    result = client.get("/api/eligibility", headers=headers).json()[0]
    assert result["eligibility_status"] == "ineligible"
    assert "above the configured cutoff" in result["reasons"][0]


def test_category_and_domicile_rules_use_only_explicit_student_values(demo_storage):
    get_store().replace_program_criteria(
        [
            synthetic_program_criteria(
                minimum_percentage=None,
                required_category="Synthetic Category",
                required_domicile="Synthetic Region",
            )
        ]
    )
    registration = register_student()
    headers = {"Authorization": f"Bearer {registration['token']}"}

    missing = client.get("/api/eligibility", headers=headers).json()[0]
    assert missing["eligibility_status"] == "insufficient_data"
    assert "Category is missing; it is not inferred." in missing["missing_info"]
    assert "Domicile is missing; it is not inferred." in missing["missing_info"]

    client.post(
        "/api/profile",
        json={
            "reservation_category": "Synthetic Category",
            "domicile": "Synthetic Region",
        },
        headers=headers,
    )
    assert client.get("/api/eligibility", headers=headers).json()[0]["eligibility_status"] == "eligible"

    client.post("/api/profile", json={"domicile": "Other Region"}, headers=headers)
    assert client.get("/api/eligibility", headers=headers).json()[0]["eligibility_status"] == "ineligible"


def test_eligibility_is_authenticated_and_uses_only_the_current_students_profile(demo_storage):
    get_store().replace_program_criteria([synthetic_program_criteria(minimum_percentage=70)])
    first = register_student()
    second = register_student()
    first_headers = {"Authorization": f"Bearer {first['token']}"}
    second_headers = {"Authorization": f"Bearer {second['token']}"}
    client.post("/api/profile", json={"academic_score": 90}, headers=first_headers)
    client.post("/api/profile", json={"academic_score": 40}, headers=second_headers)

    assert client.get("/api/eligibility").status_code == 401
    first_result = client.get("/api/eligibility", headers=first_headers).json()[0]
    second_result = client.get("/api/eligibility", headers=second_headers).json()[0]
    assert first_result["eligibility_status"] == "eligible"
    assert second_result["eligibility_status"] == "ineligible"
    assert "student_id" not in first_result
    assert "student_id" not in second_result


def test_program_criteria_management_requires_university_and_valid_unique_ids(demo_storage):
    student = register_student()
    student_headers = {"Authorization": f"Bearer {student['token']}"}
    catalog = {
        "programs": [
            synthetic_program_criteria(
                seat_capacity=12,
                priority_rules=[
                    {
                        "field": "exam_score",
                        "exam_type": "Synthetic Exam",
                        "direction": "lowest",
                    }
                ],
            )
        ]
    }
    assert client.get("/api/university/program-criteria", headers=student_headers).status_code == 403
    assert client.put(
        "/api/university/program-criteria",
        json=catalog,
        headers=student_headers,
    ).status_code == 403

    login = client.post(
        "/api/auth/login",
        json={"email": "admin@uniapply.ai", "password": "AdminPass123!"},
    )
    university_headers = {"Authorization": f"Bearer {login.json()['token']}"}
    listed = client.get("/api/university/program-criteria", headers=university_headers)
    assert listed.status_code == 200
    assert all(item["criteria_status"] == "illustrative" for item in listed.json())

    updated = client.put(
        "/api/university/program-criteria",
        json=catalog,
        headers=university_headers,
    )
    assert updated.status_code == 200
    assert updated.json()[0]["criteria_id"] == "test-criteria"
    assert updated.json()[0]["seat_capacity"] == 12
    assert updated.json()[0]["priority_rules"][0]["direction"] == "lowest"

    duplicate = synthetic_program_criteria(criteria_id="another-id")
    invalid = client.put(
        "/api/university/program-criteria",
        json={"programs": [catalog["programs"][0], duplicate]},
        headers=university_headers,
    )
    assert invalid.status_code == 422


def test_university_dashboard_and_role_check(demo_storage):
    login = client.post(
        "/api/auth/login",
        json={"email": "admin@uniapply.ai", "password": "AdminPass123!"},
    )
    assert login.status_code == 200
    headers = {"Authorization": f"Bearer {login.json()['token']}"}

    dashboard = client.get("/api/university/dashboard", headers=headers)
    assert dashboard.status_code == 200
    payload = dashboard.json()
    assert payload["total_applicants"] == 0
    assert "criteria" in payload
    student_login = client.post(
        "/api/auth/login",
        json={"email": "aanya@example.com", "password": "StrongPassword123!"},
    )
    student_headers = {"Authorization": f"Bearer {student_login.json()['token']}"}
    forbidden = client.get("/api/university/dashboard", headers=student_headers)
    assert forbidden.status_code == 403


def test_direct_application_submission_review_and_institution_isolation(
    demo_storage,
    document_storage,
):
    criteria = synthetic_program_criteria(
        required_documents=[
            {
                "document_type": "academic_marksheet",
                "label": "Academic marksheet",
                "required": True,
            }
        ],
        application_mode="direct",
        application_cycle=2027,
        application_deadline="2027-06-30",
        application_fee=250,
    )
    get_store().replace_program_criteria([criteria])
    registration = register_student()
    student_headers = {"Authorization": f"Bearer {registration['token']}"}
    profile = client.post(
        "/api/profile",
        json={"academic_score": 90, "location": "Synthetic City"},
        headers=student_headers,
    )
    assert profile.status_code == 200
    upload = client.post(
        "/api/documents/upload",
        files={"file": ("marksheet.pdf", synthetic_pdf(), "application/pdf")},
        data={"document_type": "academic_marksheet"},
        headers=student_headers,
    )
    assert upload.status_code == 200
    document_id = upload.json()["document_id"]
    assert upload.json()["document_type"] == "academic_marksheet"

    eligibility = client.get("/api/eligibility", headers=student_headers).json()[0]
    assert eligibility["eligibility_status"] == "eligible"
    assert eligibility["requirements"][0]["status"] == "pending_verification"
    assert eligibility["requirements_complete"] is True
    assert eligibility["can_apply"] is True

    draft = client.post(
        "/api/applications",
        json={
            "program_id": criteria["program_id"],
            "document_assignments": {"academic_marksheet": document_id},
        },
        headers=student_headers,
    )
    assert draft.status_code == 201
    application_id = draft.json()["application_id"]
    assert draft.json()["status"] == "draft"
    assert draft.json()["requirements"][0]["status"] == "pending_verification"

    other_student = register_student()
    other_headers = {"Authorization": f"Bearer {other_student['token']}"}
    client.post(
        "/api/profile",
        json={"academic_score": 90},
        headers=other_headers,
    )
    other_document = client.post(
        "/api/documents/upload",
        files={"file": ("other-marksheet.pdf", synthetic_pdf(), "application/pdf")},
        data={"document_type": "academic_marksheet"},
        headers=other_headers,
    )
    assert other_document.status_code == 200
    cross_owner = client.post(
        "/api/applications",
        json={
            "program_id": criteria["program_id"],
            "document_assignments": {"academic_marksheet": document_id},
        },
        headers=other_headers,
    )
    assert cross_owner.status_code == 404

    duplicate = client.post(
        "/api/applications",
        json={"program_id": criteria["program_id"]},
        headers=student_headers,
    )
    assert duplicate.status_code == 409

    university_login = client.post(
        "/api/auth/login",
        json={"email": "admin@uniapply.ai", "password": "AdminPass123!"},
    )
    university_headers = {"Authorization": f"Bearer {university_login.json()['token']}"}
    assert client.get("/api/university/applications", headers=university_headers).json()["total"] == 0
    assert client.get(
        f"/api/university/applications/{application_id}",
        headers=university_headers,
    ).status_code == 404

    submission = client.post(
        f"/api/applications/{application_id}/submit",
        json={"consent": True},
        headers=student_headers,
    )
    assert submission.status_code == 200
    reference_id = submission.json()["reference_id"]
    assert reference_id.startswith("UA-2027-")
    assert submission.json()["status"] == "submitted"
    assert submission.json()["consented_at"]

    store = get_store()
    other_user = dict(store.users["admin@uniapply.ai"])
    other_user.update(
        {
            "id": "other-institution-admin",
            "email": "other-admin@example.com",
            "institution_id": "other-institute",
        }
    )
    store.users[other_user["email"]] = other_user
    other_login = client.post(
        "/api/auth/login",
        json={"email": other_user["email"], "password": "AdminPass123!"},
    )
    other_headers = {"Authorization": f"Bearer {other_login.json()['token']}"}
    assert client.get("/api/university/applications", headers=other_headers).json()["total"] == 0
    assert client.get(
        f"/api/university/applications/{application_id}",
        headers=other_headers,
    ).status_code == 404

    university_applications = client.get(
        "/api/university/applications",
        headers=university_headers,
    ).json()
    assert university_applications["total"] == 1
    assert university_applications["applications"][0]["reference_id"] == reference_id
    content = client.get(
        f"/api/university/applications/{application_id}/documents/{document_id}/content",
        headers=university_headers,
    )
    assert content.status_code == 200
    assert content.content.startswith(b"%PDF")

    verified = client.patch(
        f"/api/university/applications/{application_id}/documents/{document_id}/verification",
        json={"verification_status": "verified", "note": "The student identity matches."},
        headers=university_headers,
    )
    assert verified.status_code == 200
    assert verified.json()["verification_status"] == "verified"

    requested = client.patch(
        f"/api/university/applications/{application_id}",
        json={
            "status": "documents_requested",
            "requested_documents": ["academic_marksheet"],
            "note": "Internal review details",
        },
        headers=university_headers,
    )
    assert requested.status_code == 200
    student_view = client.get(
        f"/api/applications/{application_id}",
        headers=student_headers,
    ).json()
    assert student_view["requested_documents"] == ["academic_marksheet"]
    assert all(
        event["note"] is None
        for event in student_view["status_history"]
        if event["actor"] != registration["user"]["id"]
    )

    resubmitted = client.post(
        f"/api/applications/{application_id}/submit",
        json={"consent": True},
        headers=student_headers,
    )
    assert resubmitted.status_code == 200
    assert resubmitted.json()["reference_id"] == reference_id
    assert resubmitted.json()["status"] == "submitted"
    accepted = client.patch(
        f"/api/university/applications/{application_id}",
        json={"status": "under_review"},
        headers=university_headers,
    )
    assert accepted.status_code == 200
    accepted = client.patch(
        f"/api/university/applications/{application_id}",
        json={"status": "accepted"},
        headers=university_headers,
    )
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "accepted"


def test_orchestrator_graph_execution_uses_configured_program_criteria(demo_storage):
    orchestrator.profile_agent.provider = DemoLLMProvider()
    orchestrator.document_agent.provider = DemoLLMProvider()
    criteria = synthetic_program_criteria()
    get_store().replace_program_criteria([criteria])
    result = orchestrator.run({
        "student_id": "graph-student-1",
        "full_name": "Graph Student",
        "email": "graph@example.com",
        "stream": "B.Tech",
        "budget": 500000,
        "academic_score": 90,
    })
    assert result["status"] == "review_complete"
    assert result["model_mode"] in {"demo", "provider"}
    assert result["recommendations"][0]["program_id"] == criteria["program_id"]
    assert "allocation" in result


def test_demo_provider_is_selected_only_when_explicit(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("LLM_PROVIDER", "demo")
    provider = get_llm_provider()
    assert isinstance(provider, DemoLLMProvider)
    get_settings.cache_clear()


def test_ollama_is_the_default_provider(monkeypatch):
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    assert Settings(_env_file=None).llm_provider == "ollama"


def test_ollama_status_requires_successful_inference(monkeypatch):
    provider = OllamaLLMProvider(
        base_url="http://localhost:11434",
        model="test-model",
        timeout=1.0,
        max_retries=0,
    )

    class FakeResponse:
        status_code = 200

        def __init__(self, body):
            self.body = body

        def json(self):
            return self.body

    monkeypatch.setattr(
        httpx.Client,
        "get",
        lambda self, url, **kwargs: FakeResponse({"models": [{"name": "test-model"}]}),
    )
    monkeypatch.setattr(
        httpx.Client,
        "post",
        lambda self, url, json=None, **kwargs: FakeResponse(
            {
                "model": "test-model",
                "done": True,
                "message": {"content": "OLLAMA_STATUS_OK"},
            }
        ),
    )

    result = provider.inference_status()

    assert result["service_reachable"] is True
    assert result["model_available"] is True
    assert result["inference_verified"] is True
    assert result["connected"] is True
    assert result["mode"] == "real_ai"


def test_ollama_status_reports_missing_model_without_inference(monkeypatch):
    provider = OllamaLLMProvider(
        base_url="http://localhost:11434",
        model="missing-model",
        timeout=1.0,
        max_retries=0,
    )
    inference_calls = []

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"models": [{"name": "another-model"}]}

    monkeypatch.setattr(
        httpx.Client,
        "get",
        lambda self, url, **kwargs: FakeResponse(),
    )
    monkeypatch.setattr(
        httpx.Client,
        "post",
        lambda self, url, json=None, **kwargs: inference_calls.append(json),
    )

    result = provider.inference_status()

    assert result["service_reachable"] is True
    assert result["model_available"] is False
    assert result["inference_verified"] is False
    assert result["mode"] == "model_missing"
    assert inference_calls == []


def test_ollama_status_does_not_verify_empty_inference(monkeypatch):
    provider = OllamaLLMProvider(
        base_url="http://localhost:11434",
        model="test-model",
        timeout=1.0,
        max_retries=0,
    )

    class FakeResponse:
        status_code = 200

        def __init__(self, body):
            self.body = body

        def json(self):
            return self.body

    monkeypatch.setattr(
        httpx.Client,
        "get",
        lambda self, url, **kwargs: FakeResponse({"models": [{"name": "test-model"}]}),
    )
    monkeypatch.setattr(
        httpx.Client,
        "post",
        lambda self, url, json=None, **kwargs: FakeResponse(
            {"model": "test-model", "done": True, "message": {"content": ""}}
        ),
    )

    result = provider.inference_status()

    assert result["service_reachable"] is True
    assert result["model_available"] is True
    assert result["inference_verified"] is False
    assert result["mode"] == "inference_failed"


def test_openai_provider_strict_json_retries_and_returns_schema_valid_output(monkeypatch):
    provider = OpenAILLMProvider(
        api_key="synthetic-not-a-secret",
        model="synthetic-model",
        timeout=1.0,
        max_retries=0,
    )

    class FakeCompletions:
        def create(self, **kwargs):
            class Choice:
                message = SimpleNamespace(content='{"status":"ok"}')
            return SimpleNamespace(choices=[Choice()])

    provider.client = SimpleNamespace(
        chat=SimpleNamespace(completions=FakeCompletions()),
        close=lambda: None,
    )

    result = provider.generate_json_strict(
        "synthetic prompt",
        schema={"required": ["status"]},
    )
    assert result == {"status": "ok"}


def test_openai_provider_strict_json_is_bounded_and_fails_without_silently_saving(monkeypatch):
    provider = OpenAILLMProvider(
        api_key="synthetic-not-a-secret",
        model="synthetic-model",
        timeout=1.0,
        max_retries=1,
    )

    class FakeCompletions:
        def create(self, **kwargs):
            raise httpx.TimeoutException("synthetic timeout")

    provider.client = SimpleNamespace(
        chat=SimpleNamespace(completions=FakeCompletions()),
        close=lambda: None,
    )

    with pytest.raises(LLMResponseError, match="Provider response validation failed"):
        provider.generate_json_strict(
            "synthetic prompt",
            schema={"required": ["status"]},
        )
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "")
    with pytest.raises(LLMResponseError, match="demo mode was not enabled"):
        get_llm_provider()
    get_settings.cache_clear()


def test_invalid_model_response_is_rejected():
    provider = DemoLLMProvider()
    with pytest.raises(LLMResponseError):
        provider._validate_json_payload({"not_required": "value"}, schema={"required": ["name"]})


def test_ollama_successful_inference(monkeypatch):
    provider = OllamaLLMProvider(base_url="http://localhost:11434", model="llama3.2:3b", timeout=20.0, max_retries=1)

    class FakeResponse:
        status_code = 200
        text = '{"message":{"content":"{\\"status\\":\\"ok\\"}"}}'

        def json(self):
            return {"message": {"content": '{"status": "ok"}'}}

    monkeypatch.setattr(httpx.Client, "post", lambda self, url, json=None: FakeResponse())
    result = provider.generate_json(
        "Return JSON only.",
        fallback={"status": "fallback"},
        schema={"required": ["status"]},
        system_prompt="Return valid JSON.",
    )
    assert result == {"status": "ok"}


def test_ollama_strict_json_does_not_substitute_fallback(monkeypatch):
    provider = OllamaLLMProvider(base_url="http://localhost:11434", model="test-model", timeout=5.0, max_retries=0)

    class FakeResponse:
        status_code = 200
        text = '{"message":{"content":"not-json"}}'

        def json(self):
            return {"message": {"content": "not-json"}}

    monkeypatch.setattr(httpx.Client, "post", lambda self, url, json=None: FakeResponse())

    with pytest.raises(LLMResponseError, match="not valid JSON"):
        provider.generate_json_strict("Return JSON only.")


def test_ollama_strict_json_returns_model_output(monkeypatch):
    provider = OllamaLLMProvider(base_url="http://localhost:11434", model="test-model", timeout=5.0, max_retries=0)
    request_payload = {}

    class FakeResponse:
        status_code = 200
        text = '{"message":{"content":"{\\"status\\":\\"model-output\\"}"}}'

        def json(self):
            return {"message": {"content": '{"status": "model-output"}'}}

    def fake_post(self, url, json=None):
        request_payload.update(json or {})
        return FakeResponse()

    monkeypatch.setattr(httpx.Client, "post", fake_post)
    schema = {"type": "object", "required": ["status"], "properties": {"status": {"type": "string"}}}

    result = provider.generate_json_strict("Return JSON only.", schema=schema)

    assert result == {"status": "model-output"}
    assert request_payload["format"] == schema


def test_ollama_unavailable_service_does_not_fall_back(monkeypatch):
    provider = OllamaLLMProvider(base_url="http://localhost:11434", model="llama3.2:3b", timeout=5.0, max_retries=1)

    def raise_error(self, *args, **kwargs):
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(httpx.Client, "post", raise_error)
    with pytest.raises(httpx.ConnectError):
        provider.generate_text("hi", fallback="fallback", system_prompt="Return text")


def test_ollama_missing_model_raises_clear_error(monkeypatch):
    provider = OllamaLLMProvider(base_url="http://localhost:11434", model="missing-model", timeout=5.0, max_retries=0)

    class FakeResponse:
        status_code = 404
        text = "model not found"

        def json(self):
            return {"error": "model not found"}

    monkeypatch.setattr(httpx.Client, "post", lambda self, url, json=None: FakeResponse())
    with pytest.raises(LLMResponseError, match="not found"):
        provider.generate_text("hi", fallback="fallback")


def test_ollama_timeout_is_handled(monkeypatch):
    provider = OllamaLLMProvider(base_url="http://localhost:11434", model="llama3.2:3b", timeout=2.0, max_retries=1)

    def raise_timeout(self, *args, **kwargs):
        raise httpx.TimeoutException("timeout")

    monkeypatch.setattr(httpx.Client, "post", raise_timeout)
    with pytest.raises(httpx.TimeoutException):
        provider.generate_json("hi", fallback={"status": "fallback"}, schema={"required": ["status"]})


def test_ollama_invalid_response_does_not_fall_back(monkeypatch):
    provider = OllamaLLMProvider(base_url="http://localhost:11434", model="llama3.2:3b", timeout=5.0, max_retries=0)

    class FakeResponse:
        status_code = 200
        text = '{"message":{"content":"not-json"}}'

        def json(self):
            return {"message": {"content": "not-json"}}

    monkeypatch.setattr(httpx.Client, "post", lambda self, url, json=None: FakeResponse())
    with pytest.raises(LLMResponseError, match="not valid JSON"):
        provider.generate_json("hi", fallback={"status": "fallback"}, schema={"required": ["status"]})


def test_ollama_provider_selected_from_env(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:11434")
    monkeypatch.setenv("OLLAMA_MODEL", "llama3.2:3b")
    provider = get_llm_provider()
    assert provider.name == "ollama"
    assert provider.model == "llama3.2:3b"
    get_settings.cache_clear()


def test_store_manager_uses_demo_fallback_when_mongo_is_unavailable(monkeypatch):
    monkeypatch.setattr(
        "app.core.config.get_settings",
        lambda: SimpleNamespace(
            app_env="development",
            storage_backend="auto",
            mongodb_uri="",
            mongodb_database="uniapply_test",
        ),
    )
    with patch.object(MongoStore, "_connect", lambda self: None):
        manager = StoreManager()
    assert manager.backend_name == "demo"
    assert manager.users == manager.demo_store.users


def test_explicit_demo_storage_skips_mongo_initialization(monkeypatch):
    monkeypatch.setattr(
        "app.core.config.get_settings",
        lambda: SimpleNamespace(app_env="development", storage_backend="demo"),
    )
    monkeypatch.setattr(
        MongoStore,
        "_connect",
        lambda self: pytest.fail("MongoDB must not be initialized in explicit demo storage mode."),
    )

    manager = StoreManager()

    assert manager.backend_name == "demo"
    assert manager.mongo_store is None
    assert manager.users == manager.demo_store.users


def test_mongo_store_is_unavailable_without_a_uri():
    store = MongoStore(uri="")
    assert store.is_available is False
    assert store.connection_error == "MONGODB_URI is not configured."


def test_mongo_store_rejects_standalone_topology_for_transactions(monkeypatch):
    hello_response = {"ok": 1, "isWritablePrimary": True}

    class FakeAdmin:
        def command(self, name):
            return hello_response if name == "hello" else {"ok": 1}

    class FakeClient:
        def __init__(self):
            self.admin = FakeAdmin()
            self.closed = False

        def __getitem__(self, _database_name):
            raise AssertionError("Unsupported topology must be rejected before database use.")

        def close(self):
            self.closed = True

    fake_client = FakeClient()
    monkeypatch.setattr("pymongo.MongoClient", lambda *_args, **_kwargs: fake_client)
    store = MongoStore.__new__(MongoStore)
    store.uri = "mongodb://synthetic.invalid"
    store.database_name = "synthetic"
    store.client = None
    store.db = None
    store.connected = False
    store.connection_error = None

    store._connect()

    assert store.is_available is False
    assert "replica set or sharded cluster" in store.connection_error
    assert store.client is None
    assert fake_client.closed


def test_mongo_store_health_check_recovers_after_transient_disconnect():
    from pymongo.errors import AutoReconnect

    class FakeAdmin:
        calls = 0

        def command(self, _name):
            self.calls += 1
            if self.calls == 1:
                raise AutoReconnect("synthetic temporary disconnect")
            return {"ok": 1}

    class FakeClient:
        def __init__(self):
            self.admin = FakeAdmin()

    store = MongoStore.__new__(MongoStore)
    store.client = FakeClient()
    store.db = object()
    store.connected = True
    store.connection_error = None

    assert store.ping() is False
    assert store.is_available is False
    assert store.ping() is True
    assert store.is_available is True
    assert store.connection_error is None


def test_mongo_store_crud_and_auth_flow_works_with_mocked_database():
    store = MongoStore.__new__(MongoStore)
    store.uri = "mongodb://localhost:27017"
    store.database_name = "uniapply_ai"
    store.client = object()
    store.connected = True
    store.connection_error = None
    store.users = {}
    store.profiles = {}
    store.documents = {}
    store.interviews = {}
    store.allocation_runs = {}
    store.allocation_cycles = {}
    store.program_criteria = []
    store.university_criteria = {"minimum_aggregate": 75.0, "ranking_weights": {"academic_score": 0.4}}

    class FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc_value, traceback):
            return False

        def with_transaction(self, callback):
            return callback(self)

    class FakeClient:
        def start_session(self):
            return FakeSession()

    store.client = FakeClient()

    class FakeCollection:
        def __init__(self, source):
            self.source = source

        def find_one(self, query, session=None):
            return next(
                (
                    item
                    for item in self.source.values()
                    if all(item.get(key) == value for key, value in query.items())
                ),
                None,
            )

        def insert_one(self, doc, session=None):
            key = next(key for key in ("email", "student_id", "document_id", "interview_id", "allocation_id") if key in doc)
            self.source[doc[key]] = doc
            return doc

        def find(self, query=None):
            if not query:
                return list(self.source.values())
            return [
                item
                for item in self.source.values()
                if all(item.get(key) == value for key, value in query.items())
            ]

        def update_one(self, query, update, upsert=False, session=None):
            payload = update.get("$set", {})
            existing = next(
                (
                    item
                    for item in self.source.values()
                    if all(item.get(key) == value for key, value in query.items())
                ),
                None,
            )
            if existing is not None:
                existing.update(payload)
                return SimpleNamespace(matched_count=1, upserted_id=None)
            elif upsert:
                payload.update(update.get("$setOnInsert", {}))
                key, value = next(iter(query.items()))
                self.source[payload.get(key, value)] = payload
                return SimpleNamespace(matched_count=0, upserted_id=value)
            return SimpleNamespace(matched_count=0, upserted_id=None)

        def delete_many(self, query, session=None):
            assert session is not None
            keys = [
                key
                for key, item in self.source.items()
                if all(item.get(field) == value for field, value in query.items())
            ]
            for key in keys:
                del self.source[key]
            return SimpleNamespace(deleted_count=len(keys))

        def delete_one(self, query, session=None):
            assert session is not None
            key = next(
                (
                    key
                    for key, item in self.source.items()
                    if all(item.get(field) == value for field, value in query.items())
                ),
                None,
            )
            if key is not None:
                del self.source[key]
            return SimpleNamespace(deleted_count=int(key is not None))

    recommendations = {}
    applications = {}
    chat_sessions = {}
    saved_colleges = {}
    allocations = {}
    store.db = type("FakeDB", (), {
        "users": FakeCollection(store.users),
        "profiles": FakeCollection(store.profiles),
        "documents": FakeCollection(store.documents),
        "interviews": FakeCollection(store.interviews),
        "applications": FakeCollection(applications),
        "recommendations": FakeCollection(recommendations),
        "chat_sessions": FakeCollection(chat_sessions),
        "saved_colleges": FakeCollection(saved_colleges),
        "allocations": FakeCollection(allocations),
        "allocation_cycles": FakeCollection({}),
        "settings": FakeCollection({}),
    })()

    created = store.create_user("Mongo User", "mongo@example.com", "StrongPassword123!", "student")
    assert created["email"] == "mongo@example.com"
    assert store.get_user("mongo@example.com")["id"] == created["id"]
    auth = store.authenticate("mongo@example.com", "StrongPassword123!")
    assert auth["role"] == "student"
    updated = store.update_profile(auth["id"], {"location": "Delhi", "career_goal": "Product engineer"})
    assert updated["location"] == "Delhi"
    store.profiles[auth["id"]]["_id"] = "mock-object-id"
    assert "_id" not in store.get_profile(auth["id"])
    updated = store.update_profile(auth["id"], {"location": "Mumbai"})
    assert "_id" not in store.db.profiles.source[auth["id"]]
    doc = store.add_document(
        {
            "document_id": f"doc-{uuid4().hex}",
            "student_id": auth["id"],
            "filename": "mark-sheet.pdf",
            "file_hash": "hash123",
            "status": "review_required",
            "extracted_fields": {"institution": "Synthetic Institution"},
            "warnings": ["review"],
            "confidence": None,
        }
    )
    assert doc["filename"] == "mark-sheet.pdf"
    store.documents[doc["document_id"]]["_id"] = "mock-object-id"
    assert "_id" not in store.list_documents(auth["id"])[0]
    assert store.get_document(doc["document_id"], auth["id"])["filename"] == "mark-sheet.pdf"
    reviewed = store.mark_document_reviewed(
        doc["document_id"],
        auth["id"],
        {"percentage": 91},
        "2026-01-01T00:00:00+00:00",
    )
    assert reviewed["reviewed_fields"] == {"percentage": 91}
    assert store.get_document(doc["document_id"], "another-student") is None
    persisted_criteria = store.replace_program_criteria(SYNTHETIC_PROGRAM_CRITERIA)
    assert persisted_criteria == SYNTHETIC_PROGRAM_CRITERIA
    assert store.db.settings.source["program_criteria"]["value"] == SYNTHETIC_PROGRAM_CRITERIA
    interview = store.create_interview(auth["id"], "B.Tech", 3, "text")
    assert interview["interview_id"] in store.db.interviews.source
    allocation_run = {
        "run_id": f"allocation-{uuid4().hex}",
        "created_at": "2026-01-01T00:00:00+00:00",
        "input_hash": "synthetic-hash",
        "algorithm_version": "preference-rank-greedy-v1",
        "input_snapshot": {},
        "seats_remaining": {},
        "results": [],
        "notes": [],
    }
    store.save_allocation_run(allocation_run)
    assert store.get_allocation_run(allocation_run["run_id"])["input_hash"] == "synthetic-hash"
    assert len(store.db.allocations.source) == 1
    cycle_run = {
        "run_id": f"allocation-{uuid4().hex}",
        "created_at": "2026-01-02T00:00:00+00:00",
        "input_hash": "cycle-input-hash",
        "submission_hash": "cycle-submission-hash",
        "algorithm_version": "preference-rank-greedy-v1",
        "cycle_id": "synthetic-cycle",
        "cycle_revision": 1,
        "program_config_hash": "synthetic-config-hash",
        "input_snapshot": {
            "programs": [{"program_id": "synthetic-program", "seat_capacity": 1}]
        },
        "results": [
            {"student_id": auth["id"], "allocated_program_id": "synthetic-program"}
        ],
        "seats_remaining": {"synthetic-program": 0},
        "notes": [],
    }
    committed = store.save_cycle_allocation_run(
        cycle_run,
        expected_revision=0,
        program_config_hash="synthetic-config-hash",
    )
    assert committed["cycle_revision"] == 1
    assert store.get_allocation_cycle_state("synthetic-cycle")["used_seats"] == {
        "synthetic-program": 1
    }
    assert store.get_allocation_run_by_submission(
        "synthetic-cycle",
        "cycle-submission-hash",
    )["run_id"] == cycle_run["run_id"]
    dashboard = store.get_university_dashboard()
    assert dashboard["total_applicants"] == 0
    assert store.backend_name == "mongodb"

    store.save_ai_recommendation({
        "student_id": auth["id"],
        "recommendation_id": "mongo-delete-recommendation",
        "created_at": "2026-01-03T00:00:00+00:00",
    })
    applications["application-1"] = {"student_id": auth["id"]}
    chat_sessions["chat-1"] = {"student_id": auth["id"]}
    saved_colleges["college-1"] = {"student_id": auth["id"]}
    allocations["allocation-1"] = {"allocation_id": "allocation-1", "student_id": auth["id"]}

    assert store.delete_student_account(auth["id"]) is True
    assert store.db.users.find_one({"id": auth["id"], "role": "student"}) is None
    assert auth["id"] not in store.db.profiles.source
    assert not any(item.get("student_id") == auth["id"] for item in store.db.documents.source.values())
    assert not any(item.get("student_id") == auth["id"] for item in store.db.interviews.source.values())
    assert not any(item.get("student_id") == auth["id"] for item in applications.values())
    assert not any(item.get("student_id") == auth["id"] for item in recommendations.values())
    assert not any(item.get("student_id") == auth["id"] for item in chat_sessions.values())
    assert not any(item.get("student_id") == auth["id"] for item in saved_colleges.values())
    assert not any(item.get("student_id") == auth["id"] for item in allocations.values())
