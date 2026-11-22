from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

from app.api.routes.explore import build_college_directory
from app.eligibility.matcher import match_programs
from app.mhtcet.pipeline import lookup_key
from app.schemas.ai import AICollegeRecommendation, AIHistoricalCutoff


RECOMMENDATION_DISCLAIMER = (
    "Safe, Moderate, and Ambitious describe only how the student's recorded rank compares "
    "with the matching supplied historical cutoff rows. They are not admission probabilities, "
    "current eligibility decisions, seat availability, or guarantees. The current cutoff source "
    "is partial and secondary_unverified."
)
INSUFFICIENT_DATA_MESSAGE = "I don't have verified information about this yet."
_STOP_WORDS = {
    "a", "an", "and", "are", "about", "can", "college", "colleges", "compare",
    "course", "courses", "for", "from", "help", "how", "i", "me", "my", "of",
    "please", "recommend", "recommendation", "show", "suggest", "the", "this",
    "to", "what", "which", "with", "you", "your",
}


class CollegeContextNotFoundError(ValueError):
    pass


def _https_url(value: str | None) -> str | None:
    if not value:
        return None
    try:
        parsed = urlsplit(value)
    except ValueError:
        return None
    if (
        parsed.scheme.lower() != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        return None
    return value


def _canonical_exam(value: str) -> str | None:
    key = lookup_key(value)
    if key in {"mht cet", "mhtcet"}:
        return "MHT-CET"
    if key in {"jee main", "joint entrance examination main"}:
        return "JEE Main"
    return None


def _profile_rank(profile: dict[str, Any]) -> tuple[str | None, int | None]:
    ranks = profile.get("exam_ranks")
    if not isinstance(ranks, dict):
        return None, None
    for exam, rank in ranks.items():
        if not isinstance(exam, str) or isinstance(rank, bool) or not isinstance(rank, int) or rank <= 0:
            continue
        canonical = _canonical_exam(exam)
        if canonical:
            return canonical, rank
    return None, None


def _text_matches(left: str | None, right: str | None) -> bool:
    if not left or not right:
        return False
    left_key = lookup_key(left)
    right_key = lookup_key(right)
    return bool(left_key and right_key and (left_key in right_key or right_key in left_key))


def generate_recommendations(
    student_id: str,
    profile: dict[str, Any],
    dataset: dict[str, Any],
    configured_programs: list[dict[str, Any]],
) -> dict[str, Any]:
    directory = build_college_directory(dataset, configured_programs)
    exam, rank = _profile_rank(profile)
    category = profile.get("reservation_category")
    preferred_fields = [
        item.strip()
        for item in profile.get("preferred_fields", [])
        if isinstance(item, str) and item.strip()
    ]
    missing_information = []
    if rank is None:
        missing_information.append(
            "An entrance examination rank is not saved. Add an MHT-CET or JEE Main rank to your profile."
        )
    if not isinstance(category, str) or not category.strip():
        missing_information.append(
            "A reservation category is not saved, so category-specific historical cutoffs cannot be compared."
        )
    if not preferred_fields:
        missing_information.append(
            "No preferred course or branch is saved; recommendations cannot be narrowed to your course interests."
        )

    program_evaluations = match_programs(
        profile,
        configured_programs,
    ) if configured_programs else []
    verified_programs_by_id = {
        item["program_id"]: item
        for item in program_evaluations
        if item.get("criteria_status") == "verified"
    }

    recommendations: list[AICollegeRecommendation] = []
    matching_cutoff_count = 0
    for college in directory.colleges:
        saved_program_ids = {
            program.program_id
            for program in college.verified_programs
            if program.program_id in verified_programs_by_id
        }
        verified_programs = [
            program for program in college.verified_programs
            if program.program_id in saved_program_ids
        ]
        if preferred_fields:
            verified_programs = [
                program for program in verified_programs
                if any(_text_matches(program.course, preference) for preference in preferred_fields)
            ]
        cutoffs = [
            item
            for item in college.historical_cutoffs
            if rank is not None
            and exam is not None
            and category
            and item.exam == exam
            and lookup_key(item.category) == lookup_key(category)
            and item.historical_closing_rank is not None
        ]
        if preferred_fields:
            cutoffs = [
                item for item in cutoffs
                if any(_text_matches(item.course, preference) for preference in preferred_fields)
            ]
            if not cutoffs and not verified_programs:
                continue

        if cutoffs:
            latest_year = max(
                (item.year for item in cutoffs if item.year is not None),
                default=None,
            )
            latest_rows = (
                [item for item in cutoffs if item.year == latest_year]
                if latest_year is not None
                else cutoffs
            )
            grouped: dict[str, list[Any]] = {}
            for item in latest_rows:
                grouped.setdefault(item.course, []).append(item)
            for course, rows in grouped.items():
                matching_cutoff_count += len(rows)
                within = sum(rank <= item.historical_closing_rank for item in rows)
                tier = (
                    "safe" if within == len(rows)
                    else "moderate" if within > 0
                    else "ambitious"
                )
                matching_criteria = [
                    f"Rank {rank} compared with {len(rows)} {exam} {category} historical cutoff row(s) for {course}."
                ]
                missing_criteria = []
                if not any(program.course == course for program in verified_programs):
                    missing_criteria.append("No matching current verified institution eligibility criteria are available.")
                reasons = [
                    (
                        f"The recorded rank is within all {len(rows)} matching historical cutoff row(s)."
                        if tier == "safe"
                        else f"The recorded rank is within {within} of {len(rows)} matching historical cutoff row(s)."
                        if tier == "moderate"
                        else f"The recorded rank is outside all {len(rows)} matching historical cutoff row(s)."
                    ),
                    f"Historical records are from {latest_year or 'an unspecified year'} and are labeled "
                    f"{', '.join(sorted({item.data_quality or 'unclassified' for item in rows}))}.",
                ]
                verified_program = next(
                    (program for program in verified_programs if program.course == course),
                    None,
                )
                program_evaluation = (
                    verified_programs_by_id.get(verified_program.program_id)
                    if verified_program else None
                )
                if program_evaluation:
                    matching_criteria.extend(
                        item["requirement"]
                        for item in program_evaluation.get("evaluated_criteria", [])
                        if item.get("status") == "met"
                    )
                    missing_criteria.extend(
                        item["requirement"]
                        for item in program_evaluation.get("evaluated_criteria", [])
                        if item.get("status") != "met"
                    )
                    if program_evaluation.get("eligibility_status") != "eligible":
                        reasons.append(
                            "Current verified criteria do not confirm eligibility; review the unmet or unavailable requirements."
                        )
                preferred_location = profile.get("location")
                college_location = " ".join(filter(None, [college.city, college.state]))
                if preferred_location:
                    if _text_matches(str(preferred_location), college_location):
                        reasons.append(f"Matches the saved preferred location: {preferred_location}.")
                    else:
                        missing_criteria.append(
                            "The available city/state information does not match or is insufficient to confirm the saved location preference."
                        )
                application_url = (
                    verified_program.official_application_url
                    if verified_program else None
                )
                official_website = verified_program.official_website if verified_program else None
                recommendations.append(AICollegeRecommendation(
                    college_id=college.college_id,
                    college_name=college.name,
                    city=college.city,
                    state=college.state,
                    course=course,
                    tier=tier,
                    exam=exam,
                    student_rank=rank,
                    category=str(category),
                    historical_cutoffs=[
                        AIHistoricalCutoff(
                            course=item.course,
                            exam=item.exam,
                            year=item.year,
                            cap_round=item.cap_round,
                            category=item.category,
                            seat_level=item.seat_level,
                            student_rank=rank,
                            historical_closing_rank=item.historical_closing_rank,
                            comparison=(
                                "within_historical_cutoff"
                                if rank <= item.historical_closing_rank
                                else "outside_historical_cutoff"
                            ),
                            data_quality=item.data_quality,
                            source_url=_https_url(item.source_url),
                        )
                        for item in rows
                    ],
                    matching_criteria=list(dict.fromkeys(matching_criteria)),
                    missing_criteria=list(dict.fromkeys(missing_criteria)),
                    reasons=reasons,
                    data_verification_status=(
                        "Historical cutoff data: "
                        + ", ".join(sorted({item.data_quality or "unclassified" for item in rows}))
                    ),
                    application_url=_https_url(application_url),
                    official_website=_https_url(official_website),
                    criteria_source=verified_program.criteria_source if verified_program else None,
                ))

        for program in verified_programs:
            if any(item.course == program.course for item in cutoffs):
                continue
            evaluation = verified_programs_by_id[program.program_id]
            if evaluation.get("eligibility_status") != "eligible":
                continue
            preferred_location = profile.get("location")
            college_location = " ".join(filter(None, [college.city, college.state]))
            reasons = [
                "Verified institution criteria assess the saved profile as eligible; no comparable cutoff fit can be established."
            ]
            missing_criteria = ["Comparable historical cutoff data is not available for this course and exam."]
            if preferred_location and _text_matches(str(preferred_location), college_location):
                reasons.append(f"Matches the saved preferred location: {preferred_location}.")
            elif preferred_location:
                missing_criteria.append(
                    "The available city/state information does not match or is insufficient to confirm the saved location preference."
                )
            recommendations.append(AICollegeRecommendation(
                college_id=college.college_id,
                college_name=college.name,
                city=college.city,
                state=college.state,
                course=program.course,
                tier="insufficient_data",
                exam=exam or "Not specified",
                student_rank=rank,
                category=str(category or "Not specified"),
                matching_criteria=[
                    item["requirement"]
                    for item in evaluation.get("evaluated_criteria", [])
                    if item.get("status") == "met"
                ],
                missing_criteria=missing_criteria,
                reasons=reasons,
                data_verification_status="Current institution criteria verified; historical cutoff unavailable.",
                application_url=_https_url(program.official_application_url),
                official_website=_https_url(program.official_website),
                criteria_source=program.criteria_source,
            ))

    tier_order = {"safe": 0, "moderate": 1, "ambitious": 2, "insufficient_data": 3}
    preferred_location = profile.get("location")
    recommendations.sort(key=lambda item: (
        0 if preferred_location and _text_matches(
            str(preferred_location),
            " ".join(filter(None, [item.city, item.state])),
        ) else 1,
        tier_order[item.tier],
        item.college_name.casefold(),
        item.course.casefold(),
    ))
    if rank is not None and matching_cutoff_count == 0 and not verified_programs_by_id:
        missing_information.append(
            "No exact exam, category, course, and institution match was found in the available cutoff and verified-criteria data."
        )

    return {
        "recommendation_id": f"recommendation-{uuid.uuid4().hex}",
        "student_id": student_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "ready" if recommendations else "insufficient_data",
        "recommendations": [item.model_dump(mode="json") for item in recommendations[:100]],
        "missing_information": list(dict.fromkeys(missing_information)),
        "disclaimer": RECOMMENDATION_DISCLAIMER,
    }


def _query_terms(value: str) -> set[str]:
    return {
        token for token in re.findall(r"[a-z0-9]{2,}", value.casefold())
        if token not in _STOP_WORDS
    }


def retrieve_admission_context(
    query: str,
    profile: dict[str, Any],
    dataset: dict[str, Any],
    configured_programs: list[dict[str, Any]],
    applications: list[dict[str, Any]],
    saved_college_ids: list[str],
    context_college_id: str | None = None,
) -> tuple[str, list[dict[str, str]]]:
    directory = build_college_directory(dataset, configured_programs)
    query_terms = _query_terms(query)
    profile_terms = _query_terms(" ".join([
        str(profile.get("location") or ""),
        str(profile.get("stream") or ""),
        " ".join(profile.get("preferred_fields", [])),
    ]))
    terms = query_terms or profile_terms
    scored = []
    for college in directory.colleges:
        if context_college_id and college.college_id == context_college_id:
            scored.append((100, college))
            continue
        searchable = " ".join([
            college.name,
            college.state or "",
            college.city or "",
            " ".join(college.courses),
            " ".join(item.course for item in college.historical_cutoffs),
            " ".join(item.course for item in college.verified_programs),
            " ".join(item.exam for item in college.historical_cutoffs),
        ])
        college_terms = _query_terms(searchable)
        score = len(terms & college_terms)
        if college.college_id in saved_college_ids:
            score += 4
        if score:
            scored.append((score, college))
    scored.sort(key=lambda item: (-item[0], item[1].name.casefold()))
    if context_college_id:
        context_college = next(
            (item for item in directory.colleges if item.college_id == context_college_id),
            None,
        )
        if context_college is None:
            raise CollegeContextNotFoundError("Selected college is not in the uploaded directory.")
        selected = [context_college]
        selected.extend(
            college for _, college in scored
            if college.college_id != context_college_id
        )
        selected = selected[:5]
    else:
        selected = [item for _, item in scored[:5]]

    sources: list[dict[str, str]] = []
    college_context = []
    seen_sources: set[str] = set()
    for college in selected:
        source_id = f"college:{college.college_id}"
        sources.append({
            "source_id": source_id,
            "label": college.name,
            "data_status": "Uploaded reference record; not independently verified.",
        })
        seen_sources.add(source_id)
        cutoff_sources = []
        for item in college.historical_cutoffs[:8]:
            cutoff_source_id = (
                f"cutoff:{college.college_id}:{item.course}:{item.year}:"
                f"{item.cap_round}:{item.category}"
            )
            if item.source_url and cutoff_source_id not in seen_sources:
                sources.append({
                    "source_id": cutoff_source_id,
                    "label": f"{college.name} — {item.course} historical cutoff",
                    "data_status": item.data_quality or "Historical data; verification status unavailable.",
                    "source_url": item.source_url,
                })
                seen_sources.add(cutoff_source_id)
            cutoff_sources.append(item.model_dump(mode="json"))
        college_context.append({
            "source_id": source_id,
            "name": college.name,
            "state": college.state,
            "city": college.city,
            "fee_values_as_supplied": {
                "ug": college.ug_fee,
                "pg": college.pg_fee,
                "currency_and_period": "Not specified in source.",
            },
            "ratings_as_supplied": {
                "overall": college.rating,
                "academic": college.academic_rating,
                "accommodation": college.accommodation_rating,
                "faculty": college.faculty_rating,
                "infrastructure": college.infrastructure_rating,
                "placement": college.placement_rating,
                "social_life": college.social_life_rating,
            },
            "courses_from_historical_or_verified_sources": college.courses,
            "historical_cutoffs": cutoff_sources,
            "verified_program_criteria": [
                {
                    "course": item.course,
                    "source": item.criteria_source,
                    "minimum_percentage": item.minimum_percentage,
                    "required_subjects": item.required_subjects,
                    "required_qualifications": item.required_qualifications,
                }
                for item in college.verified_programs
            ],
            "verified_application_links": [
                {
                    "course": item.course,
                    "url": item.url,
                }
                for item in college.application_links
            ],
        })

    profile_context = {
        "academic_score": profile.get("academic_score"),
        "stream": profile.get("stream"),
        "board": profile.get("board"),
        "subject_scores": profile.get("subject_scores", {}),
        "exam_scores": profile.get("exam_scores", {}),
        "exam_ranks": profile.get("exam_ranks", {}),
        "category": profile.get("reservation_category"),
        "domicile": profile.get("domicile"),
        "preferred_courses": profile.get("preferred_fields", []),
        "preferred_location": profile.get("location"),
        "academic_documents": [
            {
                "qualification": item.get("qualification"),
                "percentage": item.get("percentage"),
                "verification_status": item.get("verification_status"),
            }
            for item in profile.get("academic_documents", [])
            if isinstance(item, dict)
        ],
    }
    if any(
        value is not None and value not in ("", [], {})
        for value in profile_context.values()
    ):
        sources.append({
            "source_id": "student-profile",
            "label": "Saved student profile",
            "data_status": "Account profile data supplied or reviewed by the student; not independently verified.",
        })
    relevant_applications = [
        {
            "institution": item.get("institution"),
            "program": item.get("program"),
            "status": item.get("status"),
            "admission_cycle": item.get("admission_cycle"),
        }
        for item in applications[:10]
    ]
    if relevant_applications:
        sources.append({
            "source_id": "student-applications",
            "label": "Your application records",
            "data_status": "Account records; statuses reflect the information returned by this portal.",
        })
    saved = [
        item.name for item in directory.colleges
        if item.college_id in saved_college_ids
    ]
    context = {
        "notice": (
            "Use only these retrieved records. Missing values are unavailable. "
            "Historical rows are not current criteria or admission guarantees. "
            "Only links in verified_application_links are verified application links."
        ),
        "student_academic_profile": profile_context,
        "retrieved_colleges": college_context,
        "saved_college_names": saved,
        "student_application_statuses": relevant_applications,
        "available_records": len(selected),
    }
    return json.dumps(context, ensure_ascii=False), sources


def sanitize_chat_answer(answer: str, verified_urls: set[str]) -> str:
    def keep_verified_url(match: re.Match[str]) -> str:
        candidate = match.group(0).rstrip(".,;:!?")
        suffix = match.group(0)[len(candidate):]
        return candidate + suffix if candidate in verified_urls else "[unverified link omitted]" + suffix

    return re.sub(r"https?://[^\s<>\])}]+", keep_verified_url, answer)
