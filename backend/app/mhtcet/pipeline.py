from __future__ import annotations

import csv
import json
import math
import re
import statistics
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


RAW_FILENAMES = {
    "reference": "mhcap_reference.csv",
    "colleges": "maharashtra_colleges_mhtcet.csv",
    "cutoffs": "mhtcet_2026_cutoffs_partial.csv",
    "college_directory": "Indian_Engineering_Colleges_Dataset.csv",
}
NORMALIZED_COLUMN_TYPES = {
    "reference": {"type": "string|null", "name": "string|null", "description": "string|null"},
    "colleges": {
        "institute_name": "string|null",
        "short_name": "string|null",
        "city": "string|null",
        "source_note": "string|null",
    },
    "college_directory": {
        "source_row_id": "string|null",
        "college_name": "string|null",
        "state": "string|null",
        "ug_fee": "string|null",
        "pg_fee": "string|null",
        "rating": "number|null",
        "academic": "number|null",
        "accommodation": "number|null",
        "faculty": "number|null",
        "infrastructure": "number|null",
        "placement": "number|null",
        "social_life": "number|null",
    },
    "cutoffs": {
        "year": "integer|null",
        "cap_round": "integer|null",
        "seat_level": "string|null",
        "institute": "string|null",
        "branch": "string|null",
        "category": "string|null",
        "closing_rank": "integer|null",
        "source_url": "string|null",
        "data_quality": "string|null",
    },
}


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    cleaned = " ".join(unicodedata.normalize("NFKC", str(value)).split())
    return cleaned or None


def lookup_key(value: str | None) -> str:
    if not value:
        return ""
    cleaned = unicodedata.normalize("NFKC", value).casefold()
    return " ".join(re.findall(r"[a-z0-9]+", cleaned))


def normalize_column_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", unicodedata.normalize("NFKC", value).casefold()).strip("_")


def _read_csv(path: Path) -> tuple[list[dict[str, str | None]], list[str], list[str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        if not reader.fieldnames:
            raise ValueError(f"{path.name} must contain a header row.")
        original_columns = list(reader.fieldnames)
        normalized_columns = [
            "source_row_id" if index == 0 and not column.strip()
            else normalize_column_name(column)
            for index, column in enumerate(original_columns)
        ]
        if any(not column for column in normalized_columns) or len(set(normalized_columns)) != len(normalized_columns):
            raise ValueError(f"{path.name} contains empty or duplicate normalized column names.")
        rows = []
        for raw_row in reader:
            rows.append({
                normalized_columns[index]: clean_text(raw_row.get(original_columns[index]))
                for index in range(len(original_columns))
            })
    return rows, original_columns, normalized_columns


def _available_source_value(value: str | None) -> str | None:
    if value is None or value.casefold() in {"-", "--", "n/a", "na"}:
        return None
    return value


def _parse_source_number(value: str | None, field: str, source_row_id: str | None) -> float | None:
    available_value = _available_source_value(value)
    if available_value is None:
        return None
    try:
        parsed = float(available_value.replace(",", ""))
    except ValueError as exc:
        raise ValueError(
            f"{field} in source row {source_row_id or 'unknown'} must be numeric or unavailable."
        ) from exc
    if not math.isfinite(parsed):
        raise ValueError(
            f"{field} in source row {source_row_id or 'unknown'} must be finite."
        )
    return parsed


def _deduplicate_exact_rows(
    rows: list[dict[str, str | None]],
) -> tuple[list[dict[str, str | None]], int]:
    unique_rows = []
    seen: set[tuple[tuple[str, str | None], ...]] = set()
    duplicate_count = 0
    for row in rows:
        key = tuple(sorted(row.items()))
        if key in seen:
            duplicate_count += 1
            continue
        seen.add(key)
        unique_rows.append(row)
    return unique_rows, duplicate_count


def _metadata(
    dataset_name: str,
    path: Path,
    source_rows: list[dict[str, str | None]],
    rows: list[dict[str, str | None]],
    original_columns: list[str],
    normalized_columns: list[str],
    duplicate_count: int,
) -> dict[str, Any]:
    return {
        "file": path.name,
        "rows_read": len(source_rows),
        "rows_after_exact_duplicate_removal": len(rows),
        "exact_duplicate_rows": duplicate_count,
        "normalized_value_types": NORMALIZED_COLUMN_TYPES[dataset_name],
        "columns": [
            {"original": original, "normalized": normalized}
            for original, normalized in zip(original_columns, normalized_columns, strict=True)
        ],
        "missing_values_by_column": {
            column: sum(row.get(column) is None for row in source_rows)
            for column in normalized_columns
        },
    }


def _city_for_institute(
    institute_name: str,
    colleges: list[dict[str, Any]],
) -> tuple[str | None, str | None]:
    institute_key = lookup_key(institute_name)
    matches = []
    for college in colleges:
        keys = (college["normalized_institute_name"], college["normalized_short_name"])
        if any(institute_key == key for key in keys if key):
            matches.append(college)
            continue
        short_key = college["normalized_short_name"]
        if (
            len(short_key.replace(" ", "")) >= 4
            and re.search(rf"(?<!\S){re.escape(short_key)}(?!\S)", institute_key)
        ):
            matches.append(college)
            continue
        if any(
            min(len(institute_key), len(key)) >= 20
            and (institute_key in key or key in institute_key)
            for key in keys
            if key
        ):
            matches.append(college)
    unique_matches = {college["city"]: college for college in matches if college["city"]}
    if len(unique_matches) != 1:
        return None, None
    college = next(iter(unique_matches.values()))
    return college["city"], college["source_note"]


def process_datasets(raw_dir: Path, processed_path: Path, report_path: Path) -> dict[str, Any]:
    raw_dir = Path(raw_dir)
    processed_path = Path(processed_path)
    report_path = Path(report_path)
    loaded: dict[str, list[dict[str, str | None]]] = {}
    metadata: dict[str, dict[str, Any]] = {}

    for dataset_name, filename in RAW_FILENAMES.items():
        path = raw_dir / filename
        if not path.is_file():
            raise FileNotFoundError(f"Required MHT-CET dataset was not found: {path}")
        source_rows, original_columns, normalized_columns = _read_csv(path)
        rows, duplicate_count = _deduplicate_exact_rows(source_rows)
        loaded[dataset_name] = rows
        metadata[dataset_name] = _metadata(
            dataset_name,
            path,
            source_rows,
            rows,
            original_columns,
            normalized_columns,
            duplicate_count,
        )

    college_rows = loaded["colleges"]
    colleges = [
        {
            "institute_name": row.get("institute_name"),
            "normalized_institute_name": lookup_key(row.get("institute_name")),
            "short_name": row.get("short_name"),
            "normalized_short_name": lookup_key(row.get("short_name")),
            "city": row.get("city"),
            "source_note": row.get("source_note"),
        }
        for row in college_rows
    ]

    reference = [
        {
            "type": row.get("type"),
            "name": row.get("name"),
            "description": row.get("description"),
        }
        for row in loaded["reference"]
    ]

    college_directory = []
    for row in loaded["college_directory"]:
        name = row.get("college_name")
        if not name:
            raise ValueError(
                f"{RAW_FILENAMES['college_directory']} contains a record without a college name."
            )
        source_row_id = row.get("source_row_id")
        college_directory.append({
            "source_row_id": source_row_id,
            "institute_name": name,
            "normalized_institute_name": lookup_key(name),
            "short_name": None,
            "normalized_short_name": "",
            "city": None,
            "state": row.get("state"),
            "ug_fee": _available_source_value(row.get("ug_fee")),
            "pg_fee": _available_source_value(row.get("pg_fee")),
            "rating": _parse_source_number(row.get("rating"), "Rating", source_row_id),
            "academic_rating": _parse_source_number(row.get("academic"), "Academic", source_row_id),
            "accommodation_rating": _parse_source_number(
                row.get("accommodation"), "Accommodation", source_row_id
            ),
            "faculty_rating": _parse_source_number(row.get("faculty"), "Faculty", source_row_id),
            "infrastructure_rating": _parse_source_number(
                row.get("infrastructure"), "Infrastructure", source_row_id
            ),
            "placement_rating": _parse_source_number(row.get("placement"), "Placement", source_row_id),
            "social_life_rating": _parse_source_number(
                row.get("social_life"), "Social_Life", source_row_id
            ),
            "source_note": (
                "The uploaded CSV does not include a source URL or verification date."
            ),
        })

    cutoffs: list[dict[str, Any]] = []
    malformed_rank_rows = []
    malformed_year_rows = []
    malformed_cap_round_rows = []
    for row_number, row in enumerate(loaded["cutoffs"], start=2):
        try:
            year = int(row["year"]) if row.get("year") is not None else None
        except ValueError:
            year = None
        if year is None:
            malformed_year_rows.append({"row": row_number, "year": row.get("year")})
        try:
            cap_round = int(row["cap_round"]) if row.get("cap_round") is not None else None
        except ValueError:
            cap_round = None
        if cap_round is None or cap_round < 1 or cap_round > 4:
            malformed_cap_round_rows.append({"row": row_number, "cap_round": row.get("cap_round")})
            cap_round = None
        rank_text = row.get("closing_rank")
        try:
            closing_rank = int(rank_text) if rank_text is not None else None
            if closing_rank is not None and closing_rank < 0:
                closing_rank = None
        except ValueError:
            closing_rank = None
        if closing_rank is None:
            malformed_rank_rows.append({"row": row_number, "closing_rank": rank_text})

        institute = row.get("institute") or ""
        city, city_source_note = _city_for_institute(institute, colleges)
        cutoffs.append({
            "year": year,
            "year_raw": row.get("year"),
            "cap_round": cap_round,
            "cap_round_raw": row.get("cap_round"),
            "seat_level": row.get("seat_level"),
            "institute": institute,
            "normalized_institute": lookup_key(institute),
            "branch": row.get("branch"),
            "normalized_branch": lookup_key(row.get("branch")),
            "category": row.get("category"),
            "closing_rank": closing_rank,
            "source_url": row.get("source_url"),
            "data_quality": row.get("data_quality"),
            "city": city,
            "city_source_note": city_source_note,
        })

    processed = {
        "format_version": 1,
        "cutoffs": cutoffs,
        "colleges": colleges,
        "college_directory": college_directory,
        "reference": reference,
    }
    processed_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    processed_path.write_text(
        json.dumps(processed, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    dimension_counts: Counter[tuple[Any, ...]] = Counter(
        (
            row["year"],
            row["cap_round"],
            row["seat_level"],
            row["normalized_institute"],
            row["normalized_branch"],
            lookup_key(row["category"]),
        )
        for row in cutoffs
    )
    rank_values = [row["closing_rank"] for row in cutoffs if row["closing_rank"] is not None]
    unmatched_institutes = sorted({
        row["institute"] for row in cutoffs if row["city"] is None
    })
    source_urls = sorted({row["source_url"] for row in cutoffs if row["source_url"]})
    data_quality_labels = sorted({row["data_quality"] for row in cutoffs if row["data_quality"]})

    report = {
        "datasets": metadata,
        "cutoffs": {
            "processed_rows": len(cutoffs),
            "years": sorted({row["year"] for row in cutoffs if row["year"] is not None}),
            "cap_rounds": sorted({row["cap_round"] for row in cutoffs if row["cap_round"] is not None}),
            "seat_levels": sorted({row["seat_level"] for row in cutoffs if row["seat_level"]}),
            "categories": sorted({row["category"] for row in cutoffs if row["category"]}),
            "data_quality_labels": data_quality_labels,
            "unique_institutes": len({row["normalized_institute"] for row in cutoffs}),
            "unique_branches": len({row["normalized_branch"] for row in cutoffs}),
            "closing_rank": {
                "valid_count": len(rank_values),
                "malformed_or_missing_rows": malformed_rank_rows,
                "minimum": min(rank_values) if rank_values else None,
                "median": statistics.median(rank_values) if rank_values else None,
                "maximum": max(rank_values) if rank_values else None,
            },
            "malformed_or_missing_year_rows": malformed_year_rows,
            "malformed_or_missing_cap_round_rows": malformed_cap_round_rows,
            "duplicate_comparison_keys": sum(count > 1 for count in dimension_counts.values()),
            "source_urls": source_urls,
            "city_mapped_rows": sum(row["city"] is not None for row in cutoffs),
            "unmatched_institutes": unmatched_institutes,
        },
        "college_reference": {
            "processed_rows": len(colleges),
            "unique_cities": sorted({row["city"] for row in colleges if row["city"]}),
            "note": "The supplied college list is a partial reference list, not a complete CAP institute directory.",
        },
        "college_directory": {
            "processed_rows": len(college_directory),
            "unique_college_names": len({
                row["normalized_institute_name"] for row in college_directory
            }),
            "states": sorted({
                row["state"] for row in college_directory if row["state"]
            }, key=str.casefold),
            "note": (
                "All uploaded rows are retained, including repeated college names. "
                "The source provides no course, city, application-link, fee-currency, "
                "or fee-period details."
            ),
        },
        "reference_values": {
            "seat_types": [row for row in reference if row["type"] == "seat_type"],
            "categories": [row for row in reference if row["type"] == "category"],
            "rules": [row for row in reference if row["type"] == "rule"],
            "note": "Reference seat codes are preserved as supplied and are not mapped to cutoff seat_level values.",
        },
        "limitations": [
            "Cutoff rows are partial 2026 secondary_unverified data for CAP rounds 3 and 4.",
            "Only General/Open category is present in the cutoff dataset.",
            "The supplied reference identifies All India seats as JEE Main based; they are not compared with MHT-CET ranks.",
            "College and branch names are normalized for lookup only; original displayed names are preserved and aliases are not merged.",
            "No percentile-to-rank conversion or admission probability is produced.",
        ],
    }
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return report


def main() -> None:
    backend_dir = Path(__file__).resolve().parents[2]
    report = process_datasets(
        backend_dir / "data" / "raw",
        backend_dir / "data" / "processed" / "mhtcet_dataset.json",
        backend_dir / "data" / "reports" / "mhtcet_data_quality.json",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
