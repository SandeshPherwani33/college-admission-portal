import re
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends

from app.api.routes.dependencies import require_roles
from app.database.store import get_store
from app.mhtcet.pipeline import lookup_key
from app.mhtcet.recommendations import load_mhtcet_dataset
from app.schemas.eligibility import ProgramCriteria
from app.schemas.explore import (
    CollegeApplicationLink,
    CollegeCutoffRecord,
    ExploreCollegeDirectoryResponse,
    ExploreCollegeRecord,
    VerifiedCollegeProgram,
)


router = APIRouter(prefix="/explore", tags=["explore"])

COLLEGE_DATA_SOURCE = "Indian_Engineering_Colleges_Dataset.csv"
CUTOFF_DATA_SOURCE = "mhtcet_2026_cutoffs_partial.csv"
DIRECTORY_DISCLAIMER = (
    "This directory preserves all rows in the uploaded Indian engineering-college CSV; repeated "
    "college names are separate source records. Names, states, fees, and ratings are shown as "
    "supplied and are not independently verified. The CSV does not provide courses, cities, "
    "official links, fee currency, or billing period. Historical cutoff rows are partial "
    "secondary_unverified data and do not establish current eligibility or guarantee admission. "
    "Application links are included only from matching verified institution program criteria."
)


def _match_college_record(
    institution: str,
    colleges: list[dict],
) -> dict | None:
    key = lookup_key(institution)
    if not key:
        return None

    exact_matches = [
        college
        for college in colleges
        if key in {
            college.get("normalized_institute_name"),
            college.get("normalized_short_name"),
        }
    ]
    if len(exact_matches) == 1:
        return exact_matches[0]
    if exact_matches:
        return None

    partial_matches = []
    for college in colleges:
        full_key = college.get("normalized_institute_name") or ""
        short_key = college.get("normalized_short_name") or ""
        short_name_matches = (
            len(short_key.replace(" ", "")) >= 4
            and re.search(rf"(?<!\S){re.escape(short_key)}(?!\S)", key) is not None
        )
        full_name_matches = (
            min(len(key), len(full_key)) >= 20
            and (key in full_key or full_key in key)
        )
        if short_name_matches or full_name_matches:
            partial_matches.append(college)
    return partial_matches[0] if len(partial_matches) == 1 else None


def _verified_https_url(value: object) -> str | None:
    if not isinstance(value, str) or not value:
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


def build_college_directory(
    dataset: dict,
    configured_programs: list[dict],
) -> ExploreCollegeDirectoryResponse:
    colleges = dataset.get("college_directory")
    cutoff_rows = dataset.get("cutoffs")
    if not isinstance(colleges, list) or not isinstance(cutoff_rows, list):
        raise ValueError("The uploaded college dataset has an unsupported format.")

    cutoffs_by_college: dict[str, list[dict]] = {}
    for cutoff in cutoff_rows:
        institution = cutoff.get("institute")
        if not institution:
            continue
        college = _match_college_record(institution, colleges)
        if college is not None:
            cutoffs_by_college.setdefault(college["normalized_institute_name"], []).append(cutoff)

    programs_by_college: dict[str, list[VerifiedCollegeProgram]] = {}
    for raw_program in configured_programs:
        program = ProgramCriteria.model_validate(raw_program)
        if program.criteria_status != "verified":
            continue
        college = _match_college_record(program.institution, colleges)
        if college is None:
            continue
        programs_by_college.setdefault(college["normalized_institute_name"], []).append(
            VerifiedCollegeProgram(
                program_id=program.program_id,
                course=program.program,
                admission_exam=program.admission_exam,
                minimum_percentage=program.minimum_percentage,
                minimum_marks=program.minimum_marks,
                marks_out_of=program.marks_out_of,
                examination_type=program.examination_type,
                examination_cutoff=program.examination_cutoff,
                required_subjects=program.required_subjects,
                required_qualifications=program.required_qualifications,
                required_category=program.required_category,
                required_domicile=program.required_domicile,
                admission_year=program.admission_year,
                criteria_source=program.source,
                official_website=_verified_https_url(
                    str(program.official_website) if program.official_website else None
                ),
                official_application_url=(
                    _verified_https_url(str(program.official_application_url))
                    if program.application_mode == "external" and program.official_application_url
                    else None
                ),
                application_cycle=program.application_cycle,
            )
        )

    records = []
    used_ids: set[str] = set()
    for row_index, college in enumerate(colleges, start=1):
        name = college.get("institute_name")
        if not name:
            raise ValueError("The uploaded college dataset contains a record without a college name.")
        normalized_name = college.get("normalized_institute_name") or lookup_key(name)
        name_slug = re.sub(r"[^a-z0-9]+", "-", normalized_name).strip("-")
        source_row_id = college.get("source_row_id")
        college_id = f"{name_slug}-{source_row_id or row_index}"
        if college_id in used_ids:
            raise ValueError("The uploaded college dataset contains duplicate college names.")
        used_ids.add(college_id)

        source_cutoffs = cutoffs_by_college.get(normalized_name, [])
        historical_cutoffs = [
            CollegeCutoffRecord(
                course=row["branch"],
                year=row.get("year"),
                cap_round=row.get("cap_round"),
                seat_level=row.get("seat_level"),
                category=row.get("category"),
                historical_closing_rank=row.get("closing_rank"),
                exam=(
                    "MHT-CET"
                    if row.get("seat_level") == "State"
                    else "JEE Main"
                    if row.get("seat_level") == "All India"
                    else "Not specified"
                ),
                data_quality=row.get("data_quality"),
                source_url=_verified_https_url(row.get("source_url")),
            )
            for row in source_cutoffs
            if row.get("branch")
        ]
        verified_programs = sorted(
            programs_by_college.get(normalized_name, []),
            key=lambda item: (item.course.casefold(), item.program_id),
        )
        courses = sorted(
            {
                *(row.course for row in historical_cutoffs),
                *(program.course for program in verified_programs),
            },
            key=str.casefold,
        )
        accepted_exams = sorted(
            {
                exam
                for program in verified_programs
                for exam in (program.admission_exam, program.examination_type)
                if exam
            },
            key=str.casefold,
        )
        categories = sorted(
            {
                *(row.category for row in historical_cutoffs if row.category),
                *(program.required_category for program in verified_programs if program.required_category),
            },
            key=str.casefold,
        )
        websites = sorted(
            {
                program.official_website
                for program in verified_programs
                if program.official_website
            }
        )
        application_links = [
            CollegeApplicationLink(
                program_id=program.program_id,
                course=program.course,
                url=program.official_application_url,
            )
            for program in verified_programs
            if program.official_application_url
        ]
        data_sources = [COLLEGE_DATA_SOURCE]
        if historical_cutoffs:
            data_sources.append(CUTOFF_DATA_SOURCE)
        if verified_programs:
            data_sources.append("Verified institution program criteria")

        records.append(
            ExploreCollegeRecord(
                college_id=college_id,
                name=name,
                source_record_id=source_row_id,
                short_name=college.get("short_name"),
                city=college.get("city"),
                state=college.get("state"),
                state_source_note=(
                    "State as supplied in the uploaded college dataset."
                    if college.get("state")
                    else "The uploaded college dataset does not provide a state for this record."
                ),
                address=None,
                logo_url=None,
                ug_fee=college.get("ug_fee"),
                pg_fee=college.get("pg_fee"),
                rating=college.get("rating"),
                academic_rating=college.get("academic_rating"),
                accommodation_rating=college.get("accommodation_rating"),
                faculty_rating=college.get("faculty_rating"),
                infrastructure_rating=college.get("infrastructure_rating"),
                placement_rating=college.get("placement_rating"),
                social_life_rating=college.get("social_life_rating"),
                courses=courses,
                accepted_exams=accepted_exams,
                historical_exams=sorted(
                    {cutoff.exam for cutoff in historical_cutoffs if cutoff.exam != "Not specified"},
                    key=str.casefold,
                ),
                categories=categories,
                historical_cutoffs=historical_cutoffs,
                verified_programs=verified_programs,
                official_website=websites[0] if len(websites) == 1 else None,
                application_links=application_links,
                data_sources=data_sources,
                source_note=college.get("source_note"),
            )
        )

    records.sort(key=lambda item: item.name.casefold())
    return ExploreCollegeDirectoryResponse(
        colleges=records,
        total=len(records),
        source=f"{COLLEGE_DATA_SOURCE}; {CUTOFF_DATA_SOURCE}; verified institution criteria where configured",
        disclaimer=DIRECTORY_DISCLAIMER,
    )


@router.get("/colleges", response_model=ExploreCollegeDirectoryResponse)
def list_explore_colleges(current_user: dict = Depends(require_roles("student"))):
    dataset = load_mhtcet_dataset()
    configured_programs = get_store().get_program_criteria()
    return build_college_directory(dataset, configured_programs)
