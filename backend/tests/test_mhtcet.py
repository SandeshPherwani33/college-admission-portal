import csv
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.database.store import MongoStore, get_store
from app.main import app
from app.mhtcet.pipeline import process_datasets
from app.mhtcet.recommendations import get_mhtcet_options, recommend_mhtcet
from app.mhtcet.schemas import MhtcetRecommendationRequest
from app.security.auth import create_token


client = TestClient(app)
RAW_DIR = Path(__file__).resolve().parents[1] / "data" / "raw"


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


def _write_csv(path: Path, headers: list[str], rows: list[list[str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as destination:
        writer = csv.writer(destination)
        writer.writerow(headers)
        writer.writerows(rows)


def test_pipeline_loads_supplied_datasets_and_reports_quality(tmp_path):
    processed_path = tmp_path / "processed" / "dataset.json"
    report_path = tmp_path / "reports" / "quality.json"

    report = process_datasets(RAW_DIR, processed_path, report_path)

    assert report["datasets"]["reference"]["rows_read"] == 15
    assert report["datasets"]["colleges"]["rows_read"] == 35
    assert report["datasets"]["college_directory"]["rows_read"] == 732
    assert report["datasets"]["cutoffs"]["rows_read"] == 134
    assert report["college_directory"]["processed_rows"] == 732
    assert report["cutoffs"]["closing_rank"]["valid_count"] == 134
    assert report["cutoffs"]["closing_rank"]["malformed_or_missing_rows"] == []
    assert report["cutoffs"]["years"] == [2026]
    assert report["cutoffs"]["cap_rounds"] == [3, 4]
    assert report["cutoffs"]["city_mapped_rows"] == 134
    assert report["cutoffs"]["categories"] == ["General/Open"]
    assert report["cutoffs"]["data_quality_labels"] == ["secondary_unverified"]
    assert report["cutoffs"]["source_urls"] == [
        "https://engineering.careers360.com/articles/mht-cet-2026-round-4-cutoff-college-wise-closing-ranks"
    ]
    assert "reference seat codes" in report["reference_values"]["note"].lower()
    assert processed_path.is_file()
    assert report_path.is_file()
    processed_content = processed_path.read_text(encoding="utf-8")
    report_content = report_path.read_text(encoding="utf-8")

    repeated_report = process_datasets(RAW_DIR, processed_path, report_path)

    assert repeated_report == report
    assert processed_path.read_text(encoding="utf-8") == processed_content
    assert report_path.read_text(encoding="utf-8") == report_content


def test_pipeline_handles_missing_values_malformed_ranks_and_exact_duplicates(tmp_path):
    raw_dir = tmp_path / "raw"
    raw_dir.mkdir()
    _write_csv(
        raw_dir / "mhcap_reference.csv",
        ["type", "name", "description"],
        [["seat_type", "State Level (S)", "Keep separate"]],
    )
    _write_csv(
        raw_dir / "maharashtra_colleges_mhtcet.csv",
        ["institute_name", "short_name", "city", "source_note"],
        [["Example Engineering College", "EEC", "Pune", "Reference city"]],
    )
    _write_csv(
        raw_dir / "Indian_Engineering_Colleges_Dataset.csv",
        [
            "", "College_Name", "State", "UG_fee", "PG_fee", "Rating", "Academic",
            "Accommodation", "Faculty", "Infrastructure", "Placement", "Social_Life",
        ],
        [[
            "0", "Example Engineering College", "Maharashtra", "50,000", "--", "8.5",
            "8.1", "7.9", "8.0", "8.2", "8.4", "7.8",
        ]],
    )
    cutoff_headers = [
        "year", "cap_round", "seat_level", "institute", "branch",
        "category", "closing_rank", "source_url", "data_quality",
    ]
    valid_round_3 = [
        "2026", "3", "State", "Example Engineering College", "Computer Engineering",
        "General/Open", "120", "https://example.invalid/source", "secondary_unverified",
    ]
    _write_csv(
        raw_dir / "mhtcet_2026_cutoffs_partial.csv",
        cutoff_headers,
        [
            valid_round_3,
            valid_round_3,
            [
                "2026", "4", "State", "Example Engineering College", "Computer Engineering",
                "General/Open", "130", "https://example.invalid/source", "secondary_unverified",
            ],
            [
                "2026", "4", "State", "Example Engineering College", "Mechanical Engineering",
                "General/Open", "not-a-rank", "", "secondary_unverified",
            ],
        ],
    )

    report = process_datasets(
        raw_dir,
        tmp_path / "processed.json",
        tmp_path / "quality.json",
    )

    assert report["datasets"]["cutoffs"]["exact_duplicate_rows"] == 1
    assert report["datasets"]["cutoffs"]["missing_values_by_column"]["source_url"] == 1
    assert report["cutoffs"]["processed_rows"] == 3
    assert report["cutoffs"]["closing_rank"]["valid_count"] == 2
    assert report["cutoffs"]["closing_rank"]["malformed_or_missing_rows"] == [
        {"row": 4, "closing_rank": "not-a-rank"}
    ]
    assert report["cutoffs"]["cap_rounds"] == [3, 4]


def test_rank_comparison_uses_exact_category_round_branch_and_city_filters():
    request = MhtcetRecommendationRequest(
        rank=2660,
        category="General/Open",
        branch="Civil Engineering",
        city="Pune",
        cap_round=4,
    )

    response = recommend_mhtcet(request)

    assert response.data_status == "partial_historical_data"
    assert len(response.recommendations) == 1
    recommendation = response.recommendations[0]
    assert recommendation.institute == "COEP Technological University, Pune"
    assert recommendation.historical_closing_rank == 2660
    assert recommendation.comparison == "within_historical_cutoff"
    assert recommendation.year == 2026
    assert recommendation.cap_round == 4
    assert recommendation.data_quality == "secondary_unverified"
    assert recommendation.source_url.startswith("https://")


def test_rank_comparison_preserves_state_pool_and_refuses_all_india_rank_mix():
    state_response = recommend_mhtcet(
        MhtcetRecommendationRequest(
            rank=11243,
            category="General/Open",
            branch="Computer Science and Engineering",
            city="Amravati",
            cap_round=3,
        )
    )
    assert state_response.data_status == "partial_historical_data"
    assert any(
        item.institute == "Government College of Engineering, Amravati"
        and item.historical_closing_rank == 11243
        and item.comparison == "within_historical_cutoff"
        for item in state_response.recommendations
    )

    all_india_response = recommend_mhtcet(
        MhtcetRecommendationRequest(
            rank=11243,
            category="General/Open",
            seat_level="All India",
        )
    )
    assert all_india_response.data_status == "insufficient_data"
    assert all_india_response.recommendations == []
    assert "JEE Main rank" in all_india_response.message


def test_unknown_category_and_missing_filter_matches_are_insufficient():
    unknown_category = recommend_mhtcet(
        MhtcetRecommendationRequest(rank=1000, category="Open")
    )
    missing_branch = recommend_mhtcet(
        MhtcetRecommendationRequest(
            rank=1000,
            category="General/Open",
            branch="A branch not present in the dataset",
        )
    )

    assert unknown_category.data_status == "insufficient_data"
    assert "General/Open" in unknown_category.message
    assert missing_branch.data_status == "insufficient_data"
    assert missing_branch.recommendations == []


def test_missing_filter_combination_suggests_only_dataset_backed_relaxations():
    response = recommend_mhtcet(
        MhtcetRecommendationRequest(
            rank=11243,
            category="General/Open",
            branch="Computer Engineering",
            city="Mumbai",
            cap_round=4,
        )
    )

    assert response.data_status == "insufficient_data"
    assert response.recommendations == []
    assert [(item.filter, item.matching_rows) for item in response.filter_suggestions] == [
        ("branch", 7),
        ("all", 65),
    ]


def test_filter_options_are_dataset_driven_and_mark_incompatible_pool(demo_storage):
    options = get_mhtcet_options()
    assert options.categories == ["General/Open"]
    assert options.cap_rounds == [3, 4]
    pools = {item.value: item for item in options.seat_pools}
    assert pools["State"].selectable is True
    assert pools["All India"].selectable is False
    assert "JEE Main rank" in pools["All India"].reason


def test_mhtcet_endpoints_require_student_authorization_and_validate_inputs(demo_storage):
    assert client.get("/api/recommendations/mhtcet/options").status_code in {401, 403}
    assert client.post(
        "/api/recommendations/mhtcet",
        json={"rank": 0, "category": "General/Open"},
    ).status_code in {401, 403}

    registration = client.post(
        "/api/auth/register",
        json={
            "full_name": "MHT-CET Test Student",
            "email": "mhtcet-test@example.com",
            "password": "StrongPassword123!",
            "role": "student",
        },
    )
    assert registration.status_code == 200
    headers = {"Authorization": f"Bearer {registration.json()['token']}"}

    invalid_rank = client.post(
        "/api/recommendations/mhtcet",
        json={"rank": 0, "category": "General/Open"},
        headers=headers,
    )
    assert invalid_rank.status_code == 422
    unvalidated_percentile = client.post(
        "/api/recommendations/mhtcet",
        json={"rank": 12000, "category": "General/Open", "percentile": 98.5},
        headers=headers,
    )
    assert unvalidated_percentile.status_code == 422

    valid_result = client.post(
        "/api/recommendations/mhtcet",
        json={
            "rank": 2660,
            "category": "General/Open",
            "branch": "Civil Engineering",
            "city": "Pune",
            "cap_round": 4,
        },
        headers=headers,
    )
    assert valid_result.status_code == 200
    assert valid_result.json()["recommendations"][0]["institute"] == "COEP Technological University, Pune"

    university_token = create_token("admin@uniapply.ai", "university")
    denied = client.get(
        "/api/recommendations/mhtcet/options",
        headers={"Authorization": f"Bearer {university_token}"},
    )
    assert denied.status_code == 403
