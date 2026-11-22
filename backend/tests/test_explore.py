import pytest
from fastapi.testclient import TestClient

from app.api.routes.explore import build_college_directory
from app.database.store import MongoStore, get_store
from app.main import app
from app.mhtcet.recommendations import load_mhtcet_dataset
from app.schemas.eligibility import ProgramCriteria
from app.security.auth import create_token


client = TestClient(app)


@pytest.fixture
def demo_storage(monkeypatch):
    monkeypatch.setattr(MongoStore, "_connect", lambda self: None)
    if hasattr(get_store, "instance"):
        get_store.instance.close()
        del get_store.instance
    yield
    if hasattr(get_store, "instance"):
        get_store.instance.close()
        del get_store.instance


def _verified_program(institution: str) -> dict:
    return ProgramCriteria(
        criteria_id="explore-test-criteria",
        institution_id="explore-test-institution",
        program_id="explore-test-program",
        institution=institution,
        program="Computer Engineering",
        location="Mumbai",
        tuition_budget=None,
        seat_capacity=50,
        priority_rules=[],
        minimum_percentage=60,
        minimum_marks=None,
        marks_out_of=None,
        required_subjects=["Mathematics"],
        required_qualifications=["Class 12"],
        examination_type="MHT-CET",
        examination_cutoff=70,
        examination_comparison="minimum",
        admission_year=2026,
        required_category=None,
        required_domicile=None,
        required_documents=[],
        source="Verified institution admissions criteria",
        effective_year=2026,
        criteria_status="verified",
        application_mode="external",
        application_cycle=2026,
        application_deadline=None,
        application_fee=None,
        official_application_url="https://admissions.example.edu/apply",
        official_website="https://www.example.edu",
        admission_exam="MHT-CET",
    ).model_dump(mode="json")


def test_directory_preserves_uploaded_colleges_and_labels_partial_cutoffs():
    dataset = load_mhtcet_dataset()

    response = build_college_directory(dataset, [])

    assert response.total == len(dataset["college_directory"]) == 732
    assert len({college.college_id for college in response.colleges}) == response.total
    assert len({college.source_record_id for college in response.colleges}) == response.total
    assert all(college.verification_status == "partial_uploaded_dataset" for college in response.colleges)
    assert all(college.application_links == [] for college in response.colleges)
    assert all(
        cutoff.data_quality == "secondary_unverified"
        for college in response.colleges
        for cutoff in college.historical_cutoffs
    )
    first_row = dataset["college_directory"][0]
    first_college = next(
        college for college in response.colleges
        if college.source_record_id == first_row["source_row_id"]
    )
    assert first_college.name == first_row["institute_name"]
    assert first_college.state == first_row["state"]
    assert first_college.ug_fee == first_row["ug_fee"]
    assert first_college.rating == first_row["rating"]
    assert first_college.city is None
    assert first_college.courses == []
    assert "guarantee admission" in response.disclaimer


def test_official_application_links_only_join_matching_verified_programs():
    dataset = load_mhtcet_dataset()
    college_name = dataset["college_directory"][0]["institute_name"]
    programs = [_verified_program(college_name)]

    response = build_college_directory(dataset, programs)

    matched_colleges = [college for college in response.colleges if college.name == college_name]
    assert len(matched_colleges) == 1
    college = matched_colleges[0]
    assert college.official_website == "https://www.example.edu/"
    assert len(college.application_links) == 1
    assert college.application_links[0].program_id == "explore-test-program"
    assert college.application_links[0].url == "https://admissions.example.edu/apply"
    assert not any(
        link.url.startswith("http://")
        for record in response.colleges
        for link in record.application_links
    )


def test_college_directory_endpoint_requires_student_auth_and_uses_dataset(demo_storage):
    assert client.get("/api/explore/colleges").status_code == 401
    token = create_token("aanya@example.com", "student")

    response = client.get(
        "/api/explore/colleges",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 732
    assert body["data_status"] == "partial_reference_dataset"
    assert body["colleges"][0]["name"]
    assert body["source"]
