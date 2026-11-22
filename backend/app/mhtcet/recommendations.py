from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.mhtcet.pipeline import lookup_key
from app.mhtcet.schemas import (
    MhtcetInstituteCutoff,
    MhtcetOptionsResponse,
    MhtcetRecommendation,
    MhtcetRecommendationRequest,
    MhtcetRecommendationResponse,
)


BACKEND_DIR = Path(__file__).resolve().parents[2]
PROCESSED_DATA_PATH = BACKEND_DIR / "data" / "processed" / "mhtcet_dataset.json"
DISCLAIMER = (
    "Recommendations are based on available historical cutoff data and do not guarantee admission. "
    "The supplied 2026 cutoff data is partial and secondary_unverified."
)


@lru_cache(maxsize=1)
def load_mhtcet_dataset() -> dict[str, Any]:
    if not PROCESSED_DATA_PATH.is_file():
        raise FileNotFoundError(
            "MHT-CET processed data is missing. Run `python -m app.mhtcet.pipeline` from the backend directory."
        )
    with PROCESSED_DATA_PATH.open("r", encoding="utf-8") as source:
        payload = json.load(source)
    if (
        payload.get("format_version") != 1
        or not isinstance(payload.get("cutoffs"), list)
        or not isinstance(payload.get("college_directory"), list)
    ):
        raise ValueError("The processed MHT-CET dataset has an unsupported format.")
    return payload


def get_mhtcet_options(dataset: dict[str, Any] | None = None) -> MhtcetOptionsResponse:
    data = dataset if dataset is not None else load_mhtcet_dataset()
    cutoffs = data["cutoffs"]
    comparable_cutoffs = [row for row in cutoffs if row.get("seat_level") == "State"]
    categories = sorted({row["category"] for row in comparable_cutoffs if row.get("category")})
    branches = sorted(
        {row["branch"] for row in comparable_cutoffs if row.get("branch")},
        key=str.casefold,
    )
    cities = sorted({row["city"] for row in comparable_cutoffs if row.get("city")}, key=str.casefold)
    institutes = sorted(
        {row["institute"] for row in comparable_cutoffs if row.get("institute")},
        key=str.casefold,
    )
    institute_cutoffs = [
        MhtcetInstituteCutoff(
            institute=row["institute"],
            branch=row["branch"],
            city=row.get("city"),
            historical_closing_rank=row["closing_rank"],
            year=row["year"],
            cap_round=row["cap_round"],
            category=row["category"],
        )
        for row in comparable_cutoffs
        if (
            row.get("institute")
            and row.get("branch")
            and row.get("closing_rank") is not None
            and row.get("year") is not None
            and row.get("cap_round") is not None
            and row.get("category")
        )
    ]
    cap_rounds = sorted({
        row["cap_round"] for row in comparable_cutoffs if row.get("cap_round") is not None
    })
    seat_levels = sorted({row["seat_level"] for row in cutoffs if row.get("seat_level")})
    seat_pools = [
        {
            "value": seat_level,
            "label": (
                "State (MHT-CET rank comparison)"
                if seat_level == "State"
                else f"{seat_level} (not comparable to MHT-CET rank)"
            ),
            "selectable": seat_level == "State",
            "reason": (
                None
                if seat_level == "State"
                else "The supplied reference identifies All India seats as using JEE Main rank."
            ),
        }
        for seat_level in seat_levels
    ]
    return MhtcetOptionsResponse(
        categories=categories,
        branches=branches,
        cities=cities,
        institutes=institutes,
        institute_cutoffs=institute_cutoffs,
        cap_rounds=cap_rounds,
        seat_pools=seat_pools,
        data_status="partial_historical_data",
        disclaimer=DISCLAIMER,
    )


def recommend_mhtcet(
    request: MhtcetRecommendationRequest,
    dataset: dict[str, Any] | None = None,
) -> MhtcetRecommendationResponse:
    data = dataset if dataset is not None else load_mhtcet_dataset()
    if request.seat_level != "State":
        return MhtcetRecommendationResponse(
            data_status="insufficient_data",
            recommendations=[],
            message=(
                "All India records are not compared with an MHT-CET rank because the supplied "
                "reference identifies that seat pool as using JEE Main rank."
            ),
            disclaimer=DISCLAIMER,
        )

    category_key = lookup_key(request.category)
    branch_key = lookup_key(request.branch)
    city_key = lookup_key(request.city)
    category_rows = []
    for row in data["cutoffs"]:
        if (
            row.get("closing_rank") is None
            or row.get("year") is None
            or row.get("cap_round") is None
            or not row.get("institute")
            or not row.get("branch")
            or not row.get("source_url")
            or not row.get("data_quality")
        ):
            continue
        if lookup_key(row.get("category")) != category_key:
            continue
        if row.get("seat_level") != "State":
            continue
        category_rows.append(row)

    def matches_filters(
        row: dict[str, Any],
        *,
        include_branch: bool,
        include_city: bool,
        include_round: bool,
    ) -> bool:
        return (
            (not include_round or request.cap_round is None or row.get("cap_round") == request.cap_round)
            and (not include_branch or not branch_key or row.get("normalized_branch") == branch_key)
            and (not include_city or not city_key or lookup_key(row.get("city")) == city_key)
        )

    filtered = [
        row
        for row in category_rows
        if matches_filters(row, include_branch=True, include_city=True, include_round=True)
    ]

    if not filtered:
        available_categories = sorted({
            row["category"] for row in data["cutoffs"] if row.get("seat_level") == "State"
        })
        if category_key not in {lookup_key(category) for category in available_categories}:
            message = (
                "No comparable State cutoff data is available for this category. "
                f"Available dataset categories: {', '.join(available_categories) or 'none'}."
            )
        else:
            message = "No comparable historical cutoff rows match the selected filters."
        filter_suggestions = []
        selected_filters = (
            ("branch", bool(branch_key), "Clear branch filter"),
            ("city", bool(city_key), "Clear city filter"),
            ("cap_round", request.cap_round is not None, "Clear CAP round filter"),
        )
        for relaxed_filter, selected, label in selected_filters:
            if not selected:
                continue
            matches = [
                row
                for row in category_rows
                if matches_filters(
                    row,
                    include_branch=relaxed_filter != "branch",
                    include_city=relaxed_filter != "city",
                    include_round=relaxed_filter != "cap_round",
                )
            ]
            if matches:
                filter_suggestions.append(
                    {
                        "filter": relaxed_filter,
                        "label": label,
                        "matching_rows": len(matches),
                    }
                )
        all_filter_matches = len(category_rows)
        if (
            category_rows
            and any(selected for _, selected, _ in selected_filters)
            and all(item["matching_rows"] != all_filter_matches for item in filter_suggestions)
        ):
            filter_suggestions.append(
                {
                    "filter": "all",
                    "label": "Clear branch, city, and CAP round filters",
                    "matching_rows": all_filter_matches,
                }
            )
        return MhtcetRecommendationResponse(
            data_status="insufficient_data",
            recommendations=[],
            message=message,
            disclaimer=DISCLAIMER,
            filter_suggestions=filter_suggestions,
        )

    filtered.sort(key=lambda row: (
        row["closing_rank"] < request.rank,
        row["closing_rank"],
        row["institute"].casefold(),
        row["branch"].casefold(),
    ))
    recommendations = [
        MhtcetRecommendation(
            institute=row["institute"],
            branch=row["branch"],
            city=row["city"],
            historical_closing_rank=row["closing_rank"],
            year=row["year"],
            cap_round=row["cap_round"],
            category=row["category"],
            seat_level=row["seat_level"],
            comparison=(
                "within_historical_cutoff"
                if request.rank <= row["closing_rank"]
                else "outside_historical_cutoff"
            ),
            data_quality=row["data_quality"],
            source_url=row["source_url"],
            city_source_note=row["city_source_note"],
        )
        for row in filtered
    ]
    return MhtcetRecommendationResponse(
        data_status="partial_historical_data",
        recommendations=recommendations,
        disclaimer=DISCLAIMER,
    )
