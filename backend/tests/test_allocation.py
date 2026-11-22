from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.allocation.simulator import ALGORITHM_VERSION, create_allocation_run
from app.allocation.simulator import program_catalog_hash
from app.database.store import AllocationConflict, DemoStore, MongoStore, get_store
from app.main import app

client = TestClient(app)


@pytest.fixture
def demo_storage(monkeypatch):
    monkeypatch.setattr(MongoStore, "_connect", lambda self: None)
    if hasattr(get_store, "instance"):
        del get_store.instance
    yield
    if hasattr(get_store, "instance"):
        get_store.instance.close()
        del get_store.instance


def program(program_id="synthetic-program", **overrides):
    criteria = {
        "criteria_id": f"criteria-{program_id}",
        "institution_id": "synthetic-institute",
        "program_id": program_id,
        "institution": f"Synthetic Institute {program_id}",
        "program": f"Synthetic Program {program_id}",
        "location": "Synthetic City",
        "tuition_budget": None,
        "seat_capacity": 1,
        "priority_rules": [],
        "minimum_percentage": 70,
        "minimum_marks": None,
        "marks_out_of": None,
        "required_subjects": [],
        "required_qualifications": [],
        "examination_type": None,
        "examination_cutoff": None,
        "examination_comparison": "minimum",
        "admission_year": None,
        "required_category": None,
        "required_domicile": None,
        "source": "Synthetic test criteria; not official",
        "effective_year": 2026,
        "criteria_status": "verified",
    }
    criteria.update(overrides)
    return criteria


def student(student_id, preferences, **profile):
    return {
        "student_id": student_id,
        "preferences": preferences,
        "profile": {"student_id": student_id, **profile},
    }


def run(students, programs):
    return create_allocation_run(
        students=[
            {"student_id": item["student_id"], "preferences": item["preferences"]}
            for item in students
        ],
        programs=programs,
        profiles={item["student_id"]: item["profile"] for item in students},
    )


def outcome(allocation_run, student_id):
    return next(
        item for item in allocation_run["results"] if item["student_id"] == student_id
    )


def test_preference_order_uses_first_eligible_program_with_capacity():
    first = program("first-choice")
    second = program("second-choice")
    allocation_run = run(
        [
            student("student-a", ["first-choice", "second-choice"], academic_score=90),
            student("student-b", ["first-choice", "second-choice"], academic_score=90),
        ],
        [first, second],
    )

    first_result = outcome(allocation_run, "student-a")
    second_result = outcome(allocation_run, "student-b")
    assert first_result["allocated_program_id"] == "first-choice"
    assert first_result["preference_rank"] == 1
    assert second_result["allocated_program_id"] == "second-choice"
    assert second_result["preference_rank"] == 2
    assert any("configured capacity was full" in item for item in second_result["explanation"])
    assert first_result["seats_remaining"] == {"first-choice": 0, "second-choice": 0}


def test_allocation_hash_serializes_verified_external_application_urls():
    external_program = program(
        "external-application-program",
        application_mode="external",
        application_cycle=2027,
        official_application_url="https://admissions.example.edu/apply",
        official_website="https://www.example.edu",
    )

    allocation_run = run(
        [student("student-a", ["external-application-program"], academic_score=90)],
        [external_program],
    )

    result = outcome(allocation_run, "student-a")
    assert result["allocated_program_id"] == "external-application-program"
    assert len(allocation_run["input_hash"]) == 64


def test_capacity_and_configured_priority_limit_seats():
    configured = program(
        priority_rules=[
            {
                "field": "exam_score",
                "exam_type": "Synthetic Priority Exam",
                "direction": "highest",
            }
        ]
    )
    allocation_run = run(
        [
            student(
                "student-lower",
                ["synthetic-program"],
                academic_score=82,
                exam_scores={"Synthetic Priority Exam": 82},
            ),
            student(
                "student-higher",
                ["synthetic-program"],
                academic_score=96,
                exam_scores={"Synthetic Priority Exam": 96},
            ),
            student("student-missing", ["synthetic-program"], academic_score=85),
        ],
        [configured],
    )

    assert outcome(allocation_run, "student-higher")["waitlist_status"] == "allocated"
    assert outcome(allocation_run, "student-lower")["waitlist_status"] == "unallocated"
    assert outcome(allocation_run, "student-higher")["priority_position"] == 1
    assert outcome(allocation_run, "student-lower")["seats_remaining"]["synthetic-program"] == 0
    lower_explanation = " ".join(outcome(allocation_run, "student-lower")["explanation"])
    missing_explanation = " ".join(outcome(allocation_run, "student-missing")["explanation"])
    assert "ranked 2 of 3" in lower_explanation
    assert "student value: 82" in lower_explanation
    assert "ranked 3 of 3" in missing_explanation
    assert "student value: missing" in missing_explanation


def test_ineligible_and_missing_data_are_not_allocated():
    configured = program()
    allocation_run = run(
        [
            student("ineligible", ["synthetic-program"], academic_score=69),
            student("unknown", ["synthetic-program"]),
        ],
        [configured],
    )

    ineligible = outcome(allocation_run, "ineligible")
    unknown = outcome(allocation_run, "unknown")
    assert ineligible["waitlist_status"] == "unallocated"
    assert any("does not meet" in item for item in ineligible["explanation"])
    assert unknown["waitlist_status"] == "unallocated"
    assert any("Eligibility is unknown" in item for item in unknown["explanation"])


def test_missing_capacity_is_unknown_not_invented():
    configured = program(seat_capacity=None)
    allocation_run = run(
        [student("student-a", ["synthetic-program"], academic_score=90)],
        [configured],
    )

    result = outcome(allocation_run, "student-a")
    assert result["waitlist_status"] == "unallocated"
    assert "no configured capacity" in result["unallocated_reason"]
    assert result["seats_remaining"] == {}


def test_category_and_domicile_are_only_used_when_configured():
    configured = program(
        required_category="Synthetic Category",
        required_domicile="Synthetic Region",
    )
    allocation_run = run(
        [
            student("missing", ["synthetic-program"], academic_score=90),
            student(
                "matching",
                ["synthetic-program"],
                academic_score=90,
                reservation_category="Synthetic Category",
                domicile="Synthetic Region",
            ),
            student(
                "mismatch",
                ["synthetic-program"],
                academic_score=90,
                reservation_category="Other Category",
                domicile="Other Region",
            ),
        ],
        [configured],
    )

    assert outcome(allocation_run, "matching")["waitlist_status"] == "allocated"
    assert outcome(allocation_run, "missing")["waitlist_status"] == "unallocated"
    assert any("unknown" in item.lower() for item in outcome(allocation_run, "missing")["explanation"])
    assert outcome(allocation_run, "mismatch")["waitlist_status"] == "unallocated"


def test_student_receives_at_most_one_seat_and_identical_inputs_reproduce_results():
    programs = [program("first"), program("second")]
    students = [
        student("student-a", ["first", "second"], academic_score=90),
    ]
    first_run = run(students, programs)
    second_run = run(students, programs)

    assert len(first_run["results"]) == 1
    assert outcome(first_run, "student-a")["allocated_program_id"] == "first"
    assert first_run["results"] == second_run["results"]
    assert first_run["input_hash"] == second_run["input_hash"]
    assert first_run["algorithm_version"] == ALGORITHM_VERSION
    assert first_run["run_id"] != second_run["run_id"]


def register_student():
    response = client.post(
        "/api/auth/register",
        json={
            "full_name": "Synthetic Allocation Student",
            "email": f"allocation-{uuid4().hex}@example.com",
            "password": "StrongPassword123!",
        },
    )
    assert response.status_code == 200
    data = response.json()
    return data, {"Authorization": f"Bearer {data['token']}"}


def test_allocation_run_authorization_and_cross_student_isolation(demo_storage):
    from app.database.store import get_store

    first, first_headers = register_student()
    second, second_headers = register_student()
    store = get_store()
    store.replace_program_criteria([program("private-program")])
    for student_data, headers, score in (
        (first, first_headers, 95),
        (second, second_headers, 90),
    ):
        updated = client.post(
            "/api/profile",
            json={"academic_score": score},
            headers=headers,
        )
        assert updated.status_code == 200
        get_store().create_application(
            {
                "application_id": f"application-{student_data['user']['id']}",
                "reference_id": f"UA-{student_data['user']['id']}",
                "student_id": student_data["user"]["id"],
                "institution_id": "synthetic-institute",
                "institution": "Synthetic Institute",
                "program_id": "private-program",
                "program": "Synthetic Program",
                "admission_cycle": 2026,
                "status": "submitted",
                "applicant_details": {
                    "full_name": "Synthetic Student",
                    "email": student_data["user"]["email"],
                    "phone": None,
                    "location": None,
                },
                "document_assignments": {},
                "documents": [],
                "requirements": [],
                "requirements_complete": True,
                "requested_documents": [],
                "status_history": [],
                "source": "synthetic-test",
                "application_deadline": None,
                "application_fee": None,
                "consented_at": "2026-01-01T00:00:00+00:00",
                "created_at": "2026-01-01T00:00:00+00:00",
                "updated_at": "2026-01-01T00:00:00+00:00",
                "submitted_at": "2026-01-01T00:00:00+00:00",
            }
        )

    assert client.post(
        "/api/university/allocation-runs",
        json={
            "cycle_id": "test-cycle",
            "students": [
                {"student_id": first["user"]["id"], "preferences": ["private-program"]}
            ]
        },
        headers=first_headers,
    ).status_code == 403
    assert client.post(
        "/api/university/allocation-runs",
        json={
            "cycle_id": "test-cycle",
            "students": [
                {"student_id": first["user"]["id"], "preferences": ["private-program"]},
                {"student_id": second["user"]["id"], "preferences": ["private-program"]},
            ]
        },
        headers=first_headers,
    ).status_code == 403
    assert client.get("/api/allocation/runs/unknown-run", headers=first_headers).status_code == 404

    single_run = client.post(
        "/api/allocation/simulate",
        json={
            "student_id": first["user"]["id"],
            "preferences": ["private-program"],
        },
        headers=first_headers,
    )
    assert single_run.status_code == 200
    private_run_id = single_run.json()["run_id"]
    assert get_store().get_allocation_cycle_state("test-cycle")["revision"] == 0
    assert client.get(
        f"/api/allocation/runs/{private_run_id}",
        headers=second_headers,
    ).status_code == 404

    university_login = client.post(
        "/api/auth/login",
        json={"email": "admin@uniapply.ai", "password": "AdminPass123!"},
    )
    university_headers = {"Authorization": f"Bearer {university_login.json()['token']}"}
    request = {
        "cycle_id": "synthetic-cycle-2026",
        "students": [
            {"student_id": first["user"]["id"], "preferences": ["private-program"]},
            {"student_id": second["user"]["id"], "preferences": ["private-program"]},
        ]
    }
    created = client.post(
        "/api/university/allocation-runs",
        json=request,
        headers=university_headers,
    )
    assert created.status_code == 200
    batch_run = created.json()
    assert len(batch_run["results"]) == 2
    run_id = batch_run["run_id"]
    assert batch_run["cycle_id"] == "synthetic-cycle-2026"
    assert batch_run["cycle_revision"] == 1
    assert store.get_allocation_cycle_state("synthetic-cycle-2026")["used_seats"] == {
        "private-program": 1
    }

    duplicate = client.post(
        "/api/university/allocation-runs",
        json=request,
        headers=university_headers,
    )
    assert duplicate.status_code == 200
    assert duplicate.json()["run_id"] == run_id
    assert store.get_allocation_cycle_state("synthetic-cycle-2026")["revision"] == 1

    first_result = client.get(
        f"/api/allocation/runs/{run_id}",
        headers=first_headers,
    )
    assert first_result.status_code == 200
    assert first_result.json()["student_id"] == first["user"]["id"]
    second_result = client.get(
        f"/api/allocation/runs/{run_id}",
        headers=second_headers,
    )
    assert second_result.status_code == 200
    assert second_result.json()["student_id"] == second["user"]["id"]
    assert "input_snapshot" not in second_result.json()
    assert client.get(
        f"/api/university/allocation-runs/{run_id}",
        headers=first_headers,
    ).status_code == 403
    assert client.get(
        f"/api/university/allocation-runs/{run_id}",
        headers=university_headers,
    ).status_code == 200
    snapshot_ids = {
        item["student_id"]
        for item in store.get_allocation_run(run_id)["input_snapshot"]["students"]
    }
    assert snapshot_ids == {first["user"]["id"], second["user"]["id"]}
    winner = next(item for item in batch_run["results"] if item["waitlist_status"] == "allocated")
    loser = next(item for item in batch_run["results"] if item["waitlist_status"] != "allocated")

    duplicate_student_run = client.post(
        "/api/university/allocation-runs",
        json={
            "cycle_id": "synthetic-cycle-2026",
            "students": [
                {"student_id": winner["student_id"], "preferences": ["private-program"]}
            ],
        },
        headers=university_headers,
    )
    assert duplicate_student_run.status_code == 200
    assert duplicate_student_run.json()["results"][0]["waitlist_status"] == "unallocated"
    assert "already has an allocation" in duplicate_student_run.json()["results"][0]["unallocated_reason"]

    full_cycle_run = client.post(
        "/api/university/allocation-runs",
        json={
            "cycle_id": "synthetic-cycle-2026",
            "students": [
                {"student_id": loser["student_id"], "preferences": ["private-program"]}
            ],
        },
        headers=university_headers,
    )
    assert full_cycle_run.status_code == 200
    assert full_cycle_run.json()["results"][0]["waitlist_status"] == "unallocated"
    assert store.get_allocation_cycle_state("synthetic-cycle-2026")["used_seats"] == {
        "private-program": 1
    }

    independent_cycle = client.post(
        "/api/university/allocation-runs",
        json={
            "cycle_id": "synthetic-cycle-2027",
            "students": [
                {"student_id": loser["student_id"], "preferences": ["private-program"]}
            ],
        },
        headers=university_headers,
    )
    assert independent_cycle.status_code == 200
    assert independent_cycle.json()["results"][0]["waitlist_status"] == "allocated"

    store.replace_program_criteria([program("private-program", seat_capacity=2)])
    changed_criteria = client.post(
        "/api/university/allocation-runs",
        json={
            "cycle_id": "synthetic-cycle-2026",
            "students": [
                {"student_id": loser["student_id"], "preferences": ["private-program"]}
            ],
        },
        headers=university_headers,
    )
    assert changed_criteria.status_code == 409

    duplicate_student = client.post(
        "/api/university/allocation-runs",
        json={
            "cycle_id": "duplicate-student-cycle",
            "students": [
                {"student_id": first["user"]["id"], "preferences": ["private-program"]},
                {"student_id": first["user"]["id"], "preferences": ["private-program"]},
            ]
        },
        headers=university_headers,
    )
    assert duplicate_student.status_code == 422
    duplicate_preference = client.post(
        "/api/allocation/simulate",
        json={
            "student_id": first["user"]["id"],
            "preferences": ["private-program", "private-program"],
        },
        headers=first_headers,
    )
    assert duplicate_preference.status_code == 422


def test_stale_cycle_revision_cannot_overallocate_seats():
    store = DemoStore()
    criteria = program("single-seat-program")
    programs = [criteria]
    config_hash = program_catalog_hash(programs)
    students_a = [{"student_id": "student-a", "preferences": ["single-seat-program"]}]
    students_b = [{"student_id": "student-b", "preferences": ["single-seat-program"]}]
    profiles = {
        "student-a": {"student_id": "student-a", "academic_score": 90},
        "student-b": {"student_id": "student-b", "academic_score": 90},
    }
    initial = store.get_allocation_cycle_state("concurrent-cycle")
    first_run = create_allocation_run(
        students_a,
        programs,
        profiles,
        cycle_id="concurrent-cycle",
        program_config_hash=config_hash,
    )
    second_run = create_allocation_run(
        students_b,
        programs,
        profiles,
        cycle_id="concurrent-cycle",
        program_config_hash=config_hash,
    )

    store.save_cycle_allocation_run(first_run, initial["revision"], config_hash)
    with pytest.raises(AllocationConflict, match="cycle changed"):
        store.save_cycle_allocation_run(second_run, initial["revision"], config_hash)
    assert store.get_allocation_cycle_state("concurrent-cycle")["used_seats"] == {
        "single-seat-program": 1
    }
