import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.national_schemas import NationalCutoffRequest, NationalCutoffResponse, NationalCutoffRow


DATA_PATH = Path(__file__).resolve().parents[1] / "data" / "processed" / "national_exam_cutoffs.json"


@lru_cache(maxsize=1)
def load_national_cutoffs() -> dict[str, Any]:
    with DATA_PATH.open("r", encoding="utf-8") as source:
        payload = json.load(source)
    if payload.get("format_version") != 1 or not isinstance(payload.get("cutoffs"), list):
        raise ValueError("Unsupported national exam cutoff data format.")
    return payload


def national_cutoff_options() -> dict[str, list[int] | list[str]]:
    cutoffs = load_national_cutoffs()["cutoffs"]
    return {
        "exams": ["JEE Advanced via JoSAA", "NEET UG", "CUET UG"],
        "years": sorted({int(row["year"]) for row in cutoffs}),
        "institutes": sorted({row["institute"] for row in cutoffs}, key=str.casefold),
        "programmes": sorted({row["programme"] for row in cutoffs}, key=str.casefold),
    }


def search_national_cutoffs(request: NationalCutoffRequest) -> NationalCutoffResponse:
    payload = load_national_cutoffs()
    if request.exam == "NEET UG":
        return NationalCutoffResponse(
            exam=request.exam,
            data_status="insufficient_data",
            recommendations=[],
            message="No NEET cutoff values are included in the supplied workbook. Download verified counselling records and append them as rows.",
            disclaimer=payload["disclaimer"],
        )

    rows: list[NationalCutoffRow] = []
    for raw in payload["cutoffs"]:
        if raw["exam"] != request.exam or raw["year"] != request.year:
            continue
        if request.institute_or_university and request.institute_or_university.casefold() not in raw["institute"].casefold():
            continue
        if request.category and raw.get("category") and request.category.casefold() != str(raw["category"]).casefold():
            continue

        metric = float(raw["metric_value"])
        if raw["metric_type"] == "closing_rank":
            comparison = request.rank_or_score <= metric
            comparison_label = "within_historical_cutoff" if comparison else "outside_historical_cutoff"
        else:
            comparison = request.rank_or_score >= metric
            comparison_label = "within_historical_cutoff" if comparison else "outside_historical_cutoff"
        if comparison:
            row = NationalCutoffRow.model_validate({**raw, "comparison": comparison_label})
            rows.append(row)

    if not rows:
        rows = []
        for raw in payload["cutoffs"]:
            if raw["exam"] != request.exam or raw["year"] != request.year:
                continue
            metric = float(raw["metric_value"])
            comparison_label = (
                "within_historical_cutoff"
                if (request.rank_or_score <= metric if raw["metric_type"] == "closing_rank"
                    else request.rank_or_score >= metric)
                else "outside_historical_cutoff"
            )
            rows.append(NationalCutoffRow.model_validate({**raw, "comparison": comparison_label}))
        if request.institute_or_university:
            search = request.institute_or_university.casefold()
            rows = [row for row in rows if search in row.institute.casefold()]
        if request.category:
            rows = [row for row in rows if row.category is None or request.category.casefold() == row.category.casefold()]

    return NationalCutoffResponse(
        exam=request.exam,
        data_status="partial_historical_data",
        recommendations=rows,
        message=None if rows else "No matching cutoff rows are available for these filters.",
        disclaimer=payload["disclaimer"],
    )
