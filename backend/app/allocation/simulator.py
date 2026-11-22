from __future__ import annotations

import hashlib
import json
import math
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from functools import cmp_to_key
from typing import Any

from app.eligibility.matcher import match_programs

ALGORITHM_VERSION = "preference-rank-greedy-v1"
NOT_OFFICIAL = "Simulated result only; this is not an official admission offer."
PREVIEW_NOTICE = "Student preview runs do not reserve seats in university allocation cycles."
CYCLE_NOTICE = "This run reserves configured seats within its cycle; it is not an official admission offer."


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items() if key != "_id"}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _stable_hash(value: Any) -> str:
    canonical = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def program_catalog_hash(programs: list[dict[str, Any]]) -> str:
    normalized = sorted(
        (_json_safe(item) for item in programs),
        key=lambda item: item["program_id"],
    )
    return _stable_hash({"algorithm_version": ALGORITHM_VERSION, "programs": normalized})


def _priority_value(profile: dict[str, Any], rule: dict[str, Any]) -> float | None:
    if rule["field"] == "academic_score":
        value = profile.get("academic_score")
    else:
        exam_scores = profile.get("exam_scores")
        value = next(
            (
                score
                for name, score in exam_scores.items()
                if isinstance(name, str)
                and name.casefold() == rule["exam_type"].casefold()
            ),
            None,
        ) if isinstance(exam_scores, dict) else None
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
    ):
        return None
    return float(value)


def _compare_applicants(
    left: dict[str, Any],
    right: dict[str, Any],
    rules: list[dict[str, Any]],
) -> int:
    for rule in rules:
        left_value = _priority_value(left["profile"], rule)
        right_value = _priority_value(right["profile"], rule)
        if left_value is None and right_value is not None:
            return 1
        if right_value is None and left_value is not None:
            return -1
        if left_value is None:
            continue
        if left_value != right_value:
            left_first = (
                left_value > right_value
                if rule["direction"] == "highest"
                else left_value < right_value
            )
            return -1 if left_first else 1
    left_id = left["student_id"]
    right_id = right["student_id"]
    return (left_id > right_id) - (left_id < right_id)


def _priority_summary(
    profile: dict[str, Any],
    rules: list[dict[str, Any]],
    position: int,
    applicant_count: int,
) -> str:
    if not rules:
        return (
            "No program priority rules were configured; student ID was the deterministic tie-breaker "
            f"({position} of {applicant_count} eligible applicants at this preference rank)."
        )
    configured_values = []
    for rule in rules:
        field = (
            f"{rule['exam_type']} exam score"
            if rule["field"] == "exam_score"
            else "academic score"
        )
        value = _priority_value(profile, rule)
        value_text = "missing" if value is None else f"{value:g}"
        configured_values.append(
            f"{field} {rule['direction']} first (student value: {value_text})"
        )
    return (
        f"Configured priorities: {'; '.join(configured_values)}. "
        f"Student ranked {position} of {applicant_count} eligible applicants at this preference rank; "
        "missing priority values sort after recorded values, and student ID breaks remaining ties."
    )


def create_allocation_run(
    students: list[dict[str, Any]],
    programs: list[dict[str, Any]],
    profiles: dict[str, dict[str, Any]],
    *,
    cycle_id: str | None = None,
    cycle_revision: int = 0,
    used_seats: dict[str, int] | None = None,
    previously_allocated: dict[str, str] | None = None,
    program_config_hash: str | None = None,
) -> dict[str, Any]:
    """Run deterministic, preference-rank greedy allocation against explicit inputs."""
    normalized_programs = sorted(
        (_json_safe(item) for item in programs),
        key=lambda item: item["program_id"],
    )
    normalized_students = []
    for student in sorted(students, key=lambda item: item["student_id"]):
        profile = _json_safe(profiles[student["student_id"]])
        profile.setdefault("student_id", student["student_id"])
        eligibility = _json_safe(match_programs(profile, normalized_programs))
        normalized_students.append(
            {
                "student_id": student["student_id"],
                "preferences": list(student["preferences"]),
                "profile": profile,
                "eligibility": eligibility,
            }
        )

    cycle_context = None
    if cycle_id is not None:
        cycle_context = {
            "cycle_id": cycle_id,
            "revision": cycle_revision,
            "program_config_hash": program_config_hash,
            "used_seats": dict(sorted((used_seats or {}).items())),
            "previously_allocated": dict(sorted((previously_allocated or {}).items())),
        }
    submission_hash = _stable_hash(
        {
            "algorithm_version": ALGORITHM_VERSION,
            "cycle_id": cycle_id,
            "students": normalized_students,
            "programs": normalized_programs,
        }
    )
    snapshot = {
        "algorithm_version": ALGORITHM_VERSION,
        "students": normalized_students,
        "programs": normalized_programs,
        "cycle_state": cycle_context,
    }
    input_hash = _stable_hash(snapshot)

    programs_by_id = {item["program_id"]: item for item in normalized_programs}
    remaining = {
        item["program_id"]: max(
            0,
            item["seat_capacity"] - (used_seats or {}).get(item["program_id"], 0),
        )
        for item in normalized_programs
        if item.get("seat_capacity") is not None
    }
    eligibility_by_student = {
        item["student_id"]: {
            entry["program_id"]: entry for entry in item["eligibility"]
        }
        for item in normalized_students
    }
    profiles_by_student = {
        item["student_id"]: item["profile"] for item in normalized_students
    }
    preferences_by_student = {
        item["student_id"]: item["preferences"] for item in normalized_students
    }
    events: dict[str, list[str]] = {
        item["student_id"]: [] for item in normalized_students
    }
    previously_allocated = previously_allocated or {}
    for student_id, program_id in previously_allocated.items():
        if student_id in events:
            events[student_id].append(
                f"This student was already allocated to program {program_id} in cycle {cycle_id}; "
                "a student may receive at most one seat in a cycle."
            )
    assigned: dict[str, dict[str, Any]] = {}
    max_preferences = max(
        (len(item["preferences"]) for item in normalized_students),
        default=0,
    )

    for preference_rank in range(1, max_preferences + 1):
        applicants_by_program: dict[str, list[dict[str, Any]]] = {}
        for student_id, preferences in preferences_by_student.items():
            if (
                student_id in assigned
                or student_id in previously_allocated
                or len(preferences) < preference_rank
            ):
                continue
            program_id = preferences[preference_rank - 1]
            program = programs_by_id.get(program_id)
            eligibility = eligibility_by_student[student_id].get(program_id)
            if program is None or eligibility is None:
                events[student_id].append(
                    f"Preference {preference_rank} ({program_id}) was not found in the configured program catalog."
                )
                continue
            if eligibility["eligibility_status"] != "eligible":
                explanation = (
                    "Eligibility is unknown because required information is missing."
                    if eligibility["eligibility_status"] == "insufficient_data"
                    else "The student does not meet the configured eligibility criteria."
                )
                details = "; ".join(eligibility["reasons"])
                events[student_id].append(
                    f"Preference {preference_rank} ({program['institution']} - {program['program']}) was not accepted: "
                    f"{explanation} {details}"
                )
                continue
            if program.get("seat_capacity") is None:
                events[student_id].append(
                    f"Preference {preference_rank} ({program['institution']} - {program['program']}) is eligible, "
                    "but its seat capacity is not configured; no seat is assumed."
                )
                continue
            applicants_by_program.setdefault(program_id, []).append(
                {
                    "student_id": student_id,
                    "profile": profiles_by_student[student_id],
                    "eligibility": eligibility,
                }
            )

        for program_id, applicants in sorted(applicants_by_program.items()):
            program = programs_by_id[program_id]
            rules = program.get("priority_rules", [])
            applicants.sort(
                key=cmp_to_key(
                    lambda left, right: _compare_applicants(left, right, rules)
                )
            )
            for priority_position, applicant in enumerate(applicants, start=1):
                student_id = applicant["student_id"]
                priority_summary = _priority_summary(
                    applicant["profile"],
                    rules,
                    priority_position,
                    len(applicants),
                )
                if remaining[program_id] <= 0:
                    events[student_id].append(
                        f"Preference {preference_rank} ({program['institution']} - {program['program']}) "
                        f"was eligible but its configured capacity was full. {priority_summary}"
                    )
                    continue
                remaining[program_id] -= 1
                assigned[student_id] = {
                    "program_id": program_id,
                    "preference_rank": preference_rank,
                    "priority_position": priority_position,
                    "priority_summary": priority_summary,
                    "eligibility_reasons": applicant["eligibility"]["reasons"],
                }

    results = []
    for student in normalized_students:
        student_id = student["student_id"]
        assignment = assigned.get(student_id)
        if assignment:
            program = programs_by_id[assignment["program_id"]]
            explanation = [
                *events[student_id],
                f"Allocated to preference {assignment['preference_rank']} in the student's declared order.",
                assignment["priority_summary"],
                *assignment["eligibility_reasons"],
            ]
            result = {
                "student_id": student_id,
                "candidate": student_id,
                "allocated_program_id": program["program_id"],
                "allocated_college": program["institution"],
                "allocated_course": program["program"],
                "preference_rank": assignment["preference_rank"],
                "priority_position": assignment["priority_position"],
                "round_number": assignment["preference_rank"],
                "waitlist_status": "allocated",
                "reasons": explanation,
                "explanation": explanation,
                "unallocated_reason": None,
            }
        else:
            explanations = events[student_id]
            if student_id in previously_allocated:
                unallocated_reason = (
                    "No seat was allocated because this student already has an allocation in this cycle."
                )
            elif not student["preferences"]:
                unallocated_reason = "No program preferences were supplied."
            elif any("capacity is not configured" in item for item in explanations):
                unallocated_reason = (
                    "No seat was allocated because at least one eligible preference has no configured capacity."
                )
            elif any("Eligibility is unknown" in item for item in explanations):
                unallocated_reason = (
                    "No seat was allocated because eligibility could not be established for the remaining preferences."
                )
            elif any("capacity was full" in item for item in explanations):
                unallocated_reason = (
                    "No seat was allocated because all eligible configured preferences were at capacity."
                )
            else:
                unallocated_reason = (
                    "No seat was allocated because no declared preference had a configured program with confirmed eligibility."
                )
            explanation = [*explanations, unallocated_reason]
            result = {
                "student_id": student_id,
                "candidate": student_id,
                "allocated_program_id": None,
                "allocated_college": None,
                "allocated_course": None,
                "preference_rank": None,
                "priority_position": None,
                "round_number": max_preferences or 1,
                "waitlist_status": "unallocated",
                "reasons": explanation,
                "explanation": explanation,
                "unallocated_reason": unallocated_reason,
            }
        result["seats_remaining"] = deepcopy(remaining)
        result["notes"] = [CYCLE_NOTICE if cycle_id is not None else NOT_OFFICIAL]
        if cycle_id is None:
            result["notes"].append(PREVIEW_NOTICE)
        results.append(result)

    return {
        "run_id": f"allocation-{uuid.uuid4().hex}",
        "input_hash": input_hash,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "algorithm_version": ALGORITHM_VERSION,
        "cycle_id": cycle_id,
        "cycle_revision": cycle_revision + 1 if cycle_id is not None else None,
        "program_config_hash": program_config_hash,
        "submission_hash": submission_hash,
        "input_snapshot": snapshot,
        "seats_remaining": remaining,
        "results": results,
        "notes": [CYCLE_NOTICE if cycle_id is not None else NOT_OFFICIAL],
    }
