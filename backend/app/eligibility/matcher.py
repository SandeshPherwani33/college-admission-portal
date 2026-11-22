from __future__ import annotations

from typing import Any

from app.schemas.eligibility import EvaluatedCriterion, ProgramCriteria


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _reviewed_document_values(profile: dict[str, Any], field: str) -> list[Any]:
    values = []
    documents = profile.get("academic_documents", [])
    if not isinstance(documents, list):
        return values
    for document in documents:
        if isinstance(document, dict):
            value = document.get(field)
            if value is not None:
                values.append(value)
    return values


def _single_numeric_document_value(profile: dict[str, Any], field: str) -> float | None:
    values = {
        float(value)
        for value in _reviewed_document_values(profile, field)
        if _is_number(value)
    }
    return next(iter(values)) if len(values) == 1 else None


def _percentage(profile: dict[str, Any]) -> float | None:
    score = profile.get("academic_score")
    if _is_number(score) and 0 <= score <= 100:
        return float(score)
    return _single_numeric_document_value(profile, "percentage")


def _marks_pair(profile: dict[str, Any]) -> tuple[float, float] | None:
    documents = profile.get("academic_documents", [])
    if not isinstance(documents, list):
        return None
    pairs = {
        (float(document["marks"]), float(document["maximum_marks"]))
        for document in documents
        if isinstance(document, dict)
        and _is_number(document.get("marks"))
        and _is_number(document.get("maximum_marks"))
        and document["maximum_marks"] > 0
        and document["marks"] <= document["maximum_marks"]
    }
    return next(iter(pairs)) if len(pairs) == 1 else None


def evaluate_program(
    profile: dict[str, Any],
    criteria: ProgramCriteria,
    documents: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    evaluated: list[EvaluatedCriterion] = []
    reasons: list[str] = []
    missing_info: list[str] = []
    configured_rules = 0

    def add_result(
        criterion: str,
        requirement: str,
        student_value: str | float | int | list[str] | None,
        status: str,
        explanation: str,
        missing: str | None = None,
    ) -> None:
        evaluated.append(
            EvaluatedCriterion(
                criterion=criterion,
                requirement=requirement,
                student_value=student_value,
                status=status,
                explanation=explanation,
            )
        )
        reasons.append(explanation)
        if missing:
            missing_info.append(missing)

    if criteria.minimum_percentage is not None:
        configured_rules += 1
        score = _percentage(profile)
        if score is None:
            add_result(
                "minimum_percentage",
                f"At least {criteria.minimum_percentage:g}%",
                None,
                "unknown",
                "Academic percentage is not available in the student's profile.",
                "Academic percentage is missing.",
            )
        elif score >= criteria.minimum_percentage:
            add_result(
                "minimum_percentage",
                f"At least {criteria.minimum_percentage:g}%",
                score,
                "met",
                f"Recorded academic percentage {score:g}% meets the configured minimum of {criteria.minimum_percentage:g}%.",
            )
        else:
            add_result(
                "minimum_percentage",
                f"At least {criteria.minimum_percentage:g}%",
                score,
                "not_met",
                f"Recorded academic percentage {score:g}% is below the configured minimum of {criteria.minimum_percentage:g}%.",
            )

    if criteria.minimum_marks is not None:
        configured_rules += 1
        if criteria.marks_out_of is None:
            add_result(
                "minimum_marks",
                f"At least {criteria.minimum_marks:g} marks",
                None,
                "unknown",
                "The criteria do not specify the marks scale.",
                "The configured minimum-marks scale is incomplete.",
            )
        else:
            marks_pair = _marks_pair(profile)
            if marks_pair is None:
                add_result(
                    "minimum_marks",
                    f"At least {criteria.minimum_marks:g} out of {criteria.marks_out_of:g}",
                    None,
                    "unknown",
                    "A single reviewed marks and maximum-marks pair is not available.",
                    "Reviewed marks and maximum marks are missing or conflicting.",
                )
            else:
                marks, maximum = marks_pair
                normalized_marks = marks / maximum * criteria.marks_out_of
                if normalized_marks >= criteria.minimum_marks:
                    add_result(
                        "minimum_marks",
                        f"At least {criteria.minimum_marks:g} out of {criteria.marks_out_of:g}",
                        normalized_marks,
                        "met",
                        f"Reviewed marks normalize to {normalized_marks:g} out of the configured {criteria.marks_out_of:g} scale.",
                    )
                else:
                    add_result(
                        "minimum_marks",
                        f"At least {criteria.minimum_marks:g} out of {criteria.marks_out_of:g}",
                        normalized_marks,
                        "not_met",
                        f"Reviewed marks normalize to {normalized_marks:g}, below the configured minimum of {criteria.minimum_marks:g}.",
                    )

    if criteria.required_subjects:
        scores = profile.get("subject_scores", {})
        normalized_scores = {}
        if isinstance(scores, dict):
            normalized_scores = {
                key.strip().casefold(): value
                for key, value in scores.items()
                if isinstance(key, str)
            }
        for subject in criteria.required_subjects:
            configured_rules += 1
            score = normalized_scores.get(subject.casefold())
            if not _is_number(score):
                add_result(
                    f"required_subject:{subject}",
                    f"Recorded subject: {subject}",
                    None,
                    "unknown",
                    f"No recorded score is available for required subject {subject}.",
                    f"Subject score for {subject} is missing.",
                )
            else:
                add_result(
                    f"required_subject:{subject}",
                    f"Recorded subject: {subject}",
                    float(score),
                    "met",
                    f"A student-provided score is recorded for required subject {subject}; no subject cutoff was configured.",
                )

    if criteria.required_qualifications:
        configured_rules += 1
        qualifications = [
            value.strip()
            for value in _reviewed_document_values(profile, "qualification")
            if isinstance(value, str) and value.strip()
        ]
        if not qualifications:
            add_result(
                "required_qualifications",
                "One of: " + ", ".join(criteria.required_qualifications),
                None,
                "unknown",
                "No reviewed qualification is available in the student's profile.",
                "Reviewed qualification is missing.",
            )
        elif any(
            observed.casefold() == required.casefold()
            for observed in qualifications
            for required in criteria.required_qualifications
        ):
            add_result(
                "required_qualifications",
                "One of: " + ", ".join(criteria.required_qualifications),
                qualifications,
                "met",
                "At least one reviewed qualification matches the configured requirement.",
            )
        else:
            add_result(
                "required_qualifications",
                "One of: " + ", ".join(criteria.required_qualifications),
                qualifications,
                "not_met",
                "The reviewed qualifications do not match the configured requirement.",
            )

    if criteria.examination_type is not None or criteria.examination_cutoff is not None:
        configured_rules += 1
        if criteria.examination_type is None or criteria.examination_cutoff is None:
            add_result(
                "examination_cutoff",
                "Examination type and cutoff must both be configured",
                None,
                "unknown",
                "The configured examination rule is incomplete.",
                "Examination type or cutoff is missing from criteria.",
            )
        else:
            scores = profile.get("exam_scores", {})
            score = next(
                (
                    value
                    for name, value in scores.items()
                    if isinstance(name, str)
                    and name.casefold() == criteria.examination_type.casefold()
                ),
                None,
            ) if isinstance(scores, dict) else None
            if not _is_number(score):
                comparison = "at least" if criteria.examination_comparison == "minimum" else "at most"
                add_result(
                    "examination_cutoff",
                    f"{criteria.examination_type} score {comparison} {criteria.examination_cutoff:g}",
                    None,
                    "unknown",
                    f"No score is recorded for {criteria.examination_type}.",
                    f"{criteria.examination_type} score is missing.",
                )
            elif (
                score >= criteria.examination_cutoff
                if criteria.examination_comparison == "minimum"
                else score <= criteria.examination_cutoff
            ):
                comparison = "minimum" if criteria.examination_comparison == "minimum" else "maximum"
                add_result(
                    "examination_cutoff",
                    f"{criteria.examination_type} score {comparison} {criteria.examination_cutoff:g}",
                    float(score),
                    "met",
                    f"Recorded {criteria.examination_type} score meets the configured cutoff.",
                )
            else:
                comparison = "minimum" if criteria.examination_comparison == "minimum" else "maximum"
                direction = "below" if criteria.examination_comparison == "minimum" else "above"
                add_result(
                    "examination_cutoff",
                    f"{criteria.examination_type} score {comparison} {criteria.examination_cutoff:g}",
                    float(score),
                    "not_met",
                    f"Recorded {criteria.examination_type} score is {direction} the configured cutoff.",
                )

    if criteria.admission_year is not None:
        configured_rules += 1
        year = profile.get("admission_year")
        if not isinstance(year, int) or isinstance(year, bool):
            add_result(
                "admission_year",
                f"Admission year {criteria.admission_year}",
                None,
                "unknown",
                "The student's intended admission year is not provided.",
                "Admission year is missing.",
            )
        elif year == criteria.admission_year:
            add_result(
                "admission_year",
                f"Admission year {criteria.admission_year}",
                year,
                "met",
                "The student's intended admission year matches the configured year.",
            )
        else:
            add_result(
                "admission_year",
                f"Admission year {criteria.admission_year}",
                year,
                "not_met",
                f"The student's intended admission year {year} differs from the configured year.",
            )

    for criterion, requirement, profile_field in (
        ("category", criteria.required_category, "reservation_category"),
        ("domicile", criteria.required_domicile, "domicile"),
    ):
        if requirement is None:
            continue
        configured_rules += 1
        supplied = profile.get(profile_field)
        if not isinstance(supplied, str) or not supplied.strip():
            label = "category" if criterion == "category" else "domicile"
            add_result(
                criterion,
                requirement,
                None,
                "unknown",
                f"The student has not explicitly provided a {label}.",
                f"{label.title()} is missing; it is not inferred.",
            )
        elif supplied.strip().casefold() == requirement.casefold():
            add_result(
                criterion,
                requirement,
                supplied.strip(),
                "met",
                f"The explicitly provided {criterion} matches the configured condition.",
            )
        else:
            add_result(
                criterion,
                requirement,
                supplied.strip(),
                "not_met",
                f"The explicitly provided {criterion} does not match the configured condition.",
            )

    if not configured_rules:
        add_result(
            "eligibility_criteria",
            "At least one explicit hard eligibility rule",
            None,
            "unknown",
            "No eligibility rules are configured for this program.",
            "Eligibility criteria are missing.",
        )

    statuses = {item.status for item in evaluated}
    if criteria.criteria_status != "verified" or not configured_rules:
        eligibility_status = "criteria_unavailable"
    elif "not_met" in statuses:
        eligibility_status = "ineligible"
    elif "unknown" in statuses:
        eligibility_status = "insufficient_data"
    else:
        eligibility_status = "eligible"

    criteria_data = criteria.model_dump()
    owned_documents = documents or []
    requirements = []
    for requirement in criteria.required_documents:
        matching = [
            item
            for item in owned_documents
            if item.get("document_type") == requirement.document_type
        ]
        verified = [
            item for item in matching if item.get("verification_status") == "verified"
        ]
        if verified:
            requirement_status = "completed"
        elif matching:
            requirement_status = "pending_verification"
        else:
            requirement_status = "missing"
        requirements.append(
            {
                "document_type": requirement.document_type,
                "label": requirement.label,
                "required": requirement.required,
                "status": requirement_status,
                "documents": [
                    {
                        "document_id": item["document_id"],
                        "filename": item["filename"],
                        "verification_status": item.get("verification_status", "not_verified"),
                        "created_at": item.get("created_at"),
                    }
                    for item in matching
                ],
            }
        )
    required_requirements = [item for item in requirements if item["required"]]
    requirements_complete = all(
        item["status"] in {"completed", "pending_verification"}
        for item in required_requirements
    )
    if not required_requirements:
        requirements_complete = True
    can_apply = (
        eligibility_status == "eligible"
        and criteria.criteria_status == "verified"
        and criteria.application_mode in {"direct", "external"}
        and criteria.application_cycle is not None
        and requirements_complete
    )
    return {
        "program_id": criteria.program_id,
        "criteria_id": criteria.criteria_id,
        "institution_id": criteria.institution_id,
        "institution": criteria.institution,
        "program": criteria.program,
        "course": criteria.program,
        "location": criteria.location,
        "tuition_budget": criteria.tuition_budget,
        "eligibility_status": eligibility_status,
        "reasons": reasons,
        "missing_info": missing_info,
        "evaluated_criteria": [item.model_dump() for item in evaluated],
        "criteria": criteria_data,
        "criteria_status": criteria.criteria_status,
        "effective_year": criteria.effective_year,
        "admission_year": criteria.admission_year,
        "source": criteria.source,
        "match_score": None,
        "competitiveness": "not_assessed",
        "required_documents": [item.model_dump() for item in criteria.required_documents],
        "application_mode": criteria.application_mode,
        "application_cycle": criteria.application_cycle,
        "application_deadline": criteria.application_deadline,
        "application_fee": criteria.application_fee,
        "official_application_url": (
            str(criteria.official_application_url)
            if criteria.official_application_url is not None
            else None
        ),
        "official_website": (
            str(criteria.official_website)
            if criteria.official_website is not None
            else None
        ),
        "admission_exam": criteria.admission_exam,
        "application_status": criteria.application_status,
        "requirements": requirements,
        "requirements_complete": requirements_complete,
        "requirements_completion_percent": (
            100
            if not required_requirements
            else round(
                sum(
                    item["status"] in {"completed", "pending_verification"}
                    for item in required_requirements
                )
                / len(required_requirements)
                * 100
            )
        ),
        "can_apply": can_apply,
    }


def match_programs(
    profile: dict[str, Any],
    criteria_records: list[dict[str, Any] | ProgramCriteria],
    documents: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    criteria_list = [
        item if isinstance(item, ProgramCriteria) else ProgramCriteria.model_validate(item)
        for item in criteria_records
    ]
    return [evaluate_program(profile, criteria, documents) for criteria in criteria_list]
