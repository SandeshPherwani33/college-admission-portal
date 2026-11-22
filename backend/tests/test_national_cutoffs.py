from app.national_cutoffs import search_national_cutoffs
from app.national_schemas import NationalCutoffRequest


def test_jee_rank_comparison_marks_rank_within_closing_cutoff():
    response = search_national_cutoffs(
        NationalCutoffRequest(
            exam="JEE Advanced via JoSAA",
            year=2025,
            rank_or_score=100,
        )
    )

    assert response.data_status == "partial_historical_data"
    assert response.recommendations
    assert all(
        row.comparison == "within_historical_cutoff"
        for row in response.recommendations
    )
    assert all(row.institute.startswith("IIT") for row in response.recommendations)


def test_cuet_score_comparison_filters_by_category_and_college():
    response = search_national_cutoffs(
        NationalCutoffRequest(
            exam="CUET UG",
            year=2026,
            rank_or_score=960,
            category="UR",
            institute_or_university="Hindu",
        )
    )

    assert len(response.recommendations) == 1
    assert response.recommendations[0].institute == "Hindu College"
    assert response.recommendations[0].comparison == "within_historical_cutoff"


def test_neet_returns_explicit_insufficient_data():
    response = search_national_cutoffs(
        NationalCutoffRequest(
            exam="NEET UG",
            year=2025,
            rank_or_score=100,
        )
    )

    assert response.data_status == "insufficient_data"
    assert response.recommendations == []
    assert "No NEET cutoff values" in (response.message or "")
