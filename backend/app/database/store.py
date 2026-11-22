from __future__ import annotations

import uuid
from copy import deepcopy
from datetime import datetime, timezone
from threading import RLock
from typing import Any, Dict, List

from app.eligibility.demo_criteria import SYNTHETIC_PROGRAM_CRITERIA
from app.security.auth import hash_password


class AllocationConflict(RuntimeError):
    pass


class DuplicateApplicationError(RuntimeError):
    pass


class _UnsupportedMongoTransactionTopology(RuntimeError):
    pass


def _next_allocation_cycle_state(
    current: Dict[str, Any],
    run: Dict[str, Any],
    expected_revision: int,
    program_config_hash: str,
) -> Dict[str, Any]:
    if current["revision"] != expected_revision:
        raise AllocationConflict("The allocation cycle changed during this run. Retry with current cycle state.")
    if (
        current["program_config_hash"] is not None
        and current["program_config_hash"] != program_config_hash
    ):
        raise AllocationConflict("Program criteria cannot change during an allocation cycle.")

    programs = {
        program["program_id"]: program
        for program in run["input_snapshot"]["programs"]
    }
    used_seats = dict(current["used_seats"])
    allocated_students = dict(current["allocated_students"])
    new_seats: Dict[str, int] = {}
    new_students: Dict[str, str] = {}
    for result in run["results"]:
        program_id = result.get("allocated_program_id")
        if program_id is None:
            continue
        student_id = result["student_id"]
        if student_id in allocated_students or student_id in new_students:
            raise AllocationConflict("A student already has an allocation in this cycle.")
        program = programs.get(program_id)
        if program is None or program.get("seat_capacity") is None:
            raise AllocationConflict("An allocation cannot reserve an unconfigured seat capacity.")
        new_students[student_id] = program_id
        new_seats[program_id] = new_seats.get(program_id, 0) + 1

    for program_id, count in new_seats.items():
        capacity = programs[program_id]["seat_capacity"]
        if used_seats.get(program_id, 0) + count > capacity:
            raise AllocationConflict("The allocation exceeds configured capacity for this cycle.")
        used_seats[program_id] = used_seats.get(program_id, 0) + count
    allocated_students.update(new_students)
    return {
        "cycle_id": run["cycle_id"],
        "revision": expected_revision + 1,
        "program_config_hash": program_config_hash,
        "used_seats": used_seats,
        "allocated_students": allocated_students,
    }


def _new_interview_session(
    student_id: str,
    program: str,
    interview_type: str,
    question_count: int,
    mode: str,
) -> Dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "interview_id": f"interview-{uuid.uuid4().hex}",
        "student_id": student_id,
        "program": program,
        "stream": program,
        "interview_type": interview_type,
        "question_count": question_count,
        "mode": mode,
        "status": "created",
        "turns": [],
        "questions": [],
        "generation_mode": "pending",
        "generation_notice": "Session created. Start it when you are ready.",
        "feedback": None,
        "created_at": now,
        "updated_at": now,
        "completed_at": None,
    }


class DemoStore:
    def __init__(self) -> None:
        self.users: Dict[str, Dict[str, Any]] = {}
        self.profiles: Dict[str, Dict[str, Any]] = {}
        self.documents: Dict[str, Dict[str, Any]] = {}
        self.interviews: Dict[str, Dict[str, Any]] = {}
        self.applications: Dict[str, Dict[str, Any]] = {}
        self.allocation_runs: Dict[str, Dict[str, Any]] = {}
        self.allocation_cycles: Dict[str, Dict[str, Any]] = {}
        self.ai_recommendations: Dict[str, List[Dict[str, Any]]] = {}
        self.chat_sessions: Dict[str, Dict[str, Any]] = {}
        self.saved_colleges: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self._allocation_lock = RLock()
        self._application_lock = RLock()
        self._ai_data_lock = RLock()
        self.program_criteria = deepcopy(SYNTHETIC_PROGRAM_CRITERIA)
        self.university_criteria = {
            "minimum_aggregate": 75.0,
            "reservation_policy": "General, OBC-NCL, SC, ST, EWS",
            "manual_review_triggers": ["document mismatch", "budget gap", "missing entrance result"],
            "ranking_weights": {
                "academic_score": 0.4,
                "exam_score": 0.3,
                "budget_fit": 0.2,
                "interest_alignment": 0.1,
            },
        }
        self.seed_demo_user()

    def seed_demo_user(self) -> None:
        student_id = "demo-student-1"
        password_hash = hash_password("StrongPassword123!")
        self.users["aanya@example.com"] = {
            "id": student_id,
            "full_name": "Aanya Sharma",
            "email": "aanya@example.com",
            "password_hash": password_hash,
            "role": "student",
            "created_at": "2026-11-17T00:00:00Z",
        }
        self.users["admin@uniapply.ai"] = {
            "id": "university-admin-1",
            "full_name": "UniApply Admin",
            "email": "admin@uniapply.ai",
            "password_hash": hash_password("AdminPass123!"),
            "role": "university",
            "institution_id": "synthetic-institute",
            "created_at": "2026-11-17T00:00:00Z",
        }
        self.profiles[student_id] = {
            "student_id": student_id,
            "full_name": "Aanya Sharma",
            "email": "aanya@example.com",
            "phone": "+91 98765 43210",
            "location": "Pune",
            "stream": "Science",
            "board": "CBSE",
            "academic_score": 92.4,
            "exam_scores": {"JEE Main": 96.5, "MHT-CET": 97.2},
            "exam_ranks": {},
            "subject_scores": {},
            "admission_year": None,
            "budget": 450000,
            "career_goal": "Computer Science and AI research",
            "interests": ["AI", "Robotics", "Research"],
            "preferred_fields": ["Computer Science", "AI", "Data Science"],
            "reservation_category": "General",
            "domicile": "Maharashtra",
            "completion_percent": 88,
            "missing_fields": ["Portfolio"],
            "notes": ["Strong interest in research and entrepreneurship."],
            "academic_documents": [],
        }

    def create_user(self, full_name: str, email: str, password: str, role: str = "student") -> Dict[str, Any]:
        if email in self.users:
            raise ValueError("User already exists")
        student_id = f"user-{uuid.uuid4().hex[:8]}"
        user = {
            "id": student_id,
            "full_name": full_name,
            "email": email,
            "password_hash": hash_password(password),
            "role": role,
        }
        self.users[email] = user

        self.profiles[student_id] = {
            "student_id": student_id,
            "full_name": full_name,
            "email": email,
            "phone": None,
            "location": None,
            "stream": None,
            "board": None,
            "academic_score": None,
            "exam_scores": {},
            "exam_ranks": {},
            "subject_scores": {},
            "admission_year": None,
            "budget": None,
            "career_goal": None,
            "interests": [],
            "preferred_fields": [],
            "reservation_category": None,
            "domicile": None,
            "completion_percent": 10,
            "missing_fields": ["location", "stream", "academic_score", "career_goal"],
            "notes": [],
            "academic_documents": [],
        }
        return {"id": student_id, "full_name": full_name, "email": email, "role": role}

    def authenticate(self, email: str, password: str) -> Dict[str, Any]:
        user = self.users.get(email)
        if not user:
            raise ValueError("Invalid credentials")
        from app.security.auth import verify_password

        if not verify_password(password, user["password_hash"]):
            raise ValueError("Invalid credentials")
        return {
            "id": user["id"],
            "full_name": user["full_name"],
            "email": user["email"],
            "role": user["role"],
            "institution_id": user.get("institution_id"),
        }

    def get_user(self, email: str) -> Dict[str, Any] | None:
        return self.users.get(email)

    def delete_student_account(self, student_id: str) -> bool:
        user = next(
            (item for item in self.users.values() if item["id"] == student_id),
            None,
        )
        if user is None or user.get("role") != "student":
            return False
        self.users.pop(user["email"], None)
        self.profiles.pop(student_id, None)
        self.documents = {
            key: value
            for key, value in self.documents.items()
            if value.get("student_id") != student_id
        }
        self.interviews = {
            key: value
            for key, value in self.interviews.items()
            if value.get("student_id") != student_id
        }
        self.applications = {
            key: value
            for key, value in self.applications.items()
            if value.get("student_id") != student_id
        }
        self.ai_recommendations.pop(student_id, None)
        self.chat_sessions = {
            key: value
            for key, value in self.chat_sessions.items()
            if value.get("student_id") != student_id
        }
        self.saved_colleges.pop(student_id, None)
        self.allocation_runs = {
            key: value
            for key, value in self.allocation_runs.items()
            if value.get("student_id") != student_id
        }
        return True

    def get_profile(self, student_id: str) -> Dict[str, Any]:
        profile = self.profiles.get(student_id)
        if not profile:
            raise ValueError("Profile not found")
        return profile

    def update_profile(self, student_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        profile = self.profiles.setdefault(student_id, {"student_id": student_id})
        for key, value in payload.items():
            if value is not None or key in {
                "academic_score",
                "admission_year",
                "reservation_category",
                "domicile",
            }:
                profile[key] = value
        profile["completion_percent"] = self._profile_completion(profile)
        profile["missing_fields"] = self._missing_fields(profile)
        return profile

    def _missing_fields(self, profile: Dict[str, Any]) -> List[str]:
        required = [
            "full_name",
            "email",
            "location",
            "stream",
            "board",
            "academic_score",
            "career_goal",
            "budget",
        ]
        missing = []
        for field in required:
            value = profile.get(field)
            if value in (None, "", [], {}):
                missing.append(field)
        return missing

    def _profile_completion(self, profile: Dict[str, Any]) -> int:
        required = [
            "full_name",
            "email",
            "location",
            "stream",
            "board",
            "academic_score",
            "career_goal",
            "budget",
        ]
        total = len(required)
        filled = 0
        for field in required:
            value = profile.get(field)
            if value not in (None, "", [], {}):
                filled += 1
        return int(round((filled / total) * 100))

    def add_document(self, record: Dict[str, Any]) -> Dict[str, Any]:
        document = dict(record)
        self.documents[document["document_id"]] = document
        return document

    def list_documents(self, student_id: str) -> List[Dict[str, Any]]:
        return [item for item in self.documents.values() if item["student_id"] == student_id]

    def get_document(self, document_id: str, student_id: str) -> Dict[str, Any] | None:
        document = self.documents.get(document_id)
        if document is None or document["student_id"] != student_id:
            return None
        return document

    def update_document_processing(
        self,
        document_id: str,
        student_id: str,
        processing: Dict[str, Any],
        updated_at: str,
    ) -> Dict[str, Any] | None:
        document = self.get_document(document_id, student_id)
        if document is None or document.get("status") == "reviewed":
            return None
        document.update(processing)
        document["updated_at"] = updated_at
        return document

    def mark_document_reviewed(
        self,
        document_id: str,
        student_id: str,
        reviewed_fields: Dict[str, Any],
        reviewed_at: str,
    ) -> Dict[str, Any] | None:
        document = self.get_document(document_id, student_id)
        if document is None:
            return None
        document.update(
            {
                "status": "reviewed",
                "processing_status": "reviewed",
                "reviewed_fields": reviewed_fields,
                "reviewed_at": reviewed_at,
                "updated_at": reviewed_at,
            }
        )
        return document

    def get_program_criteria(self, institution_id: str | None = None) -> List[Dict[str, Any]]:
        programs = self.program_criteria
        if institution_id is not None:
            programs = [item for item in programs if item.get("institution_id") == institution_id]
        return deepcopy(programs)

    def replace_program_criteria(self, programs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        self.program_criteria = deepcopy(programs)
        return self.get_program_criteria()

    def replace_program_criteria_for_institution(
        self,
        institution_id: str,
        programs: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        if any(item.get("institution_id") != institution_id for item in programs):
            raise ValueError("Program criteria must belong to the authenticated institution.")
        other_programs = [
            item for item in self.program_criteria
            if item.get("institution_id") != institution_id
        ]
        if {
            item.get("program_id") for item in other_programs
        } & {item.get("program_id") for item in programs}:
            raise ValueError("Program IDs must be unique across institutions.")
        self.program_criteria = deepcopy([*other_programs, *programs])
        return self.get_program_criteria(institution_id)

    def create_application(self, application: Dict[str, Any]) -> Dict[str, Any]:
        with self._application_lock:
            duplicate = next(
                (
                    item
                    for item in self.applications.values()
                    if item.get("student_id") == application["student_id"]
                    and item.get("program_id") == application["program_id"]
                    and item.get("admission_cycle") == application["admission_cycle"]
                ),
                None,
            )
            if duplicate is not None:
                raise DuplicateApplicationError("An application already exists for this program and admission cycle.")
            self.applications[application["application_id"]] = deepcopy(application)
            return deepcopy(application)

    def list_student_applications(self, student_id: str) -> List[Dict[str, Any]]:
        return sorted(
            (
                deepcopy(item)
                for item in self.applications.values()
                if item.get("student_id") == student_id
            ),
            key=lambda item: item["created_at"],
            reverse=True,
        )

    def list_institution_applications(self, institution_id: str) -> List[Dict[str, Any]]:
        return sorted(
            (
                deepcopy(item)
                for item in self.applications.values()
                if item.get("institution_id") == institution_id
                and item.get("status") != "draft"
            ),
            key=lambda item: item["created_at"],
            reverse=True,
        )

    def get_application(
        self,
        application_id: str,
        *,
        student_id: str | None = None,
        institution_id: str | None = None,
    ) -> Dict[str, Any] | None:
        application = self.applications.get(application_id)
        if (
            application is None
            or (student_id is not None and application.get("student_id") != student_id)
            or (institution_id is not None and application.get("institution_id") != institution_id)
            or (institution_id is not None and application.get("status") == "draft")
        ):
            return None
        return deepcopy(application)

    def update_application(
        self,
        application_id: str,
        expected_updated_at: str,
        updates: Dict[str, Any],
    ) -> Dict[str, Any] | None:
        with self._application_lock:
            application = self.applications.get(application_id)
            if application is None or application.get("updated_at") != expected_updated_at:
                return None
            application.update(deepcopy(updates))
            return deepcopy(application)

    def update_document_verification(
        self,
        document_id: str,
        student_id: str,
        verification_status: str,
        note: str,
        institution_id: str,
        verified_at: str,
    ) -> Dict[str, Any] | None:
        document = self.get_document(document_id, student_id)
        if document is None:
            return None
        document.update(
            {
                "verification_status": verification_status,
                "verification_note": note,
                "verified_by_institution_id": institution_id,
                "verified_at": verified_at,
                "updated_at": verified_at,
            }
        )
        return deepcopy(document)

    def create_interview_session(
        self,
        student_id: str,
        program: str,
        interview_type: str,
        question_count: int,
        mode: str,
    ) -> Dict[str, Any]:
        session = _new_interview_session(student_id, program, interview_type, question_count, mode)
        self.interviews[session["interview_id"]] = deepcopy(session)
        return session

    def create_interview(self, student_id: str, stream: str, question_count: int, mode: str) -> Dict[str, Any]:
        return self.create_interview_session(student_id, stream, "general", question_count, mode)

    def get_interview_session(self, interview_id: str, student_id: str) -> Dict[str, Any] | None:
        session = self.interviews.get(interview_id)
        if session is None or session.get("student_id") != student_id:
            return None
        return deepcopy(session)

    def list_interview_sessions(self, student_id: str) -> List[Dict[str, Any]]:
        sessions = [
            deepcopy(item)
            for item in self.interviews.values()
            if item.get("student_id") == student_id
        ]
        return sorted(sessions, key=lambda item: item["created_at"], reverse=True)

    def update_interview_session(
        self,
        interview_id: str,
        student_id: str,
        expected_updated_at: str,
        updates: Dict[str, Any],
    ) -> Dict[str, Any] | None:
        session = self.interviews.get(interview_id)
        if (
            session is None
            or session.get("student_id") != student_id
            or session.get("updated_at") != expected_updated_at
        ):
            return None
        session.update(deepcopy(updates))
        return deepcopy(session)

    def save_ai_recommendation(self, record: Dict[str, Any]) -> Dict[str, Any]:
        student_id = record["student_id"]
        with self._ai_data_lock:
            history = self.ai_recommendations.setdefault(student_id, [])
            history.append(deepcopy(record))
            del history[:-20]
        return deepcopy(record)

    def get_latest_ai_recommendation(self, student_id: str) -> Dict[str, Any] | None:
        with self._ai_data_lock:
            history = self.ai_recommendations.get(student_id, [])
            return deepcopy(history[-1]) if history else None

    def list_ai_recommendations(self, student_id: str) -> List[Dict[str, Any]]:
        with self._ai_data_lock:
            history = self.ai_recommendations.get(student_id, [])
            return sorted(deepcopy(history), key=lambda item: item["created_at"], reverse=True)

    def create_chat_session(self, student_id: str, title: str = "New conversation") -> Dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        session = {
            "session_id": f"chat-{uuid.uuid4().hex}",
            "student_id": student_id,
            "title": title,
            "created_at": now,
            "updated_at": now,
            "messages": [],
        }
        with self._ai_data_lock:
            self.chat_sessions[session["session_id"]] = deepcopy(session)
        return deepcopy(session)

    def list_chat_sessions(self, student_id: str) -> List[Dict[str, Any]]:
        with self._ai_data_lock:
            sessions = [
                deepcopy(item)
                for item in self.chat_sessions.values()
                if item.get("student_id") == student_id
            ]
        return sorted(sessions, key=lambda item: item["updated_at"], reverse=True)

    def get_chat_session(self, session_id: str, student_id: str) -> Dict[str, Any] | None:
        with self._ai_data_lock:
            session = self.chat_sessions.get(session_id)
            if session is None or session.get("student_id") != student_id:
                return None
            return deepcopy(session)

    def append_chat_messages(
        self,
        session_id: str,
        student_id: str,
        messages: List[Dict[str, Any]],
        *,
        title: str | None = None,
    ) -> Dict[str, Any] | None:
        with self._ai_data_lock:
            session = self.chat_sessions.get(session_id)
            if session is None or session.get("student_id") != student_id:
                return None
            session["messages"].extend(deepcopy(messages))
            session["updated_at"] = datetime.now(timezone.utc).isoformat()
            if title and session["title"] == "New conversation":
                session["title"] = title
            return deepcopy(session)

    def delete_chat_session(self, session_id: str, student_id: str) -> bool:
        with self._ai_data_lock:
            session = self.chat_sessions.get(session_id)
            if session is None or session.get("student_id") != student_id:
                return False
            del self.chat_sessions[session_id]
            return True

    def list_saved_colleges(self, student_id: str) -> List[Dict[str, Any]]:
        with self._ai_data_lock:
            records = list(self.saved_colleges.get(student_id, {}).values())
        return sorted(deepcopy(records), key=lambda item: item["saved_at"], reverse=True)

    def save_college(self, student_id: str, college_id: str) -> Dict[str, Any]:
        with self._ai_data_lock:
            records = self.saved_colleges.setdefault(student_id, {})
            record = records.setdefault(
                college_id,
                {
                    "student_id": student_id,
                    "college_id": college_id,
                    "saved_at": datetime.now(timezone.utc).isoformat(),
                },
            )
            return deepcopy(record)

    def delete_saved_college(self, student_id: str, college_id: str) -> bool:
        with self._ai_data_lock:
            records = self.saved_colleges.get(student_id, {})
            return records.pop(college_id, None) is not None

    def save_allocation_run(self, run: Dict[str, Any]) -> Dict[str, Any]:
        self.allocation_runs[run["run_id"]] = deepcopy(run)
        return deepcopy(run)

    def get_allocation_run(self, run_id: str) -> Dict[str, Any] | None:
        run = self.allocation_runs.get(run_id)
        return deepcopy(run) if run is not None else None

    def get_allocation_run_by_submission(
        self,
        cycle_id: str,
        submission_hash: str,
    ) -> Dict[str, Any] | None:
        for run in self.allocation_runs.values():
            if run.get("cycle_id") == cycle_id and run.get("submission_hash") == submission_hash:
                return deepcopy(run)
        return None

    def get_allocation_cycle_state(self, cycle_id: str) -> Dict[str, Any]:
        state = self.allocation_cycles.get(cycle_id)
        if state is None:
            return {
                "cycle_id": cycle_id,
                "revision": 0,
                "program_config_hash": None,
                "used_seats": {},
                "allocated_students": {},
            }
        return deepcopy(state)

    def save_cycle_allocation_run(
        self,
        run: Dict[str, Any],
        expected_revision: int,
        program_config_hash: str,
    ) -> Dict[str, Any]:
        with self._allocation_lock:
            existing = self.get_allocation_run_by_submission(
                run["cycle_id"],
                run["submission_hash"],
            )
            if existing is not None:
                return existing
            current = self.get_allocation_cycle_state(run["cycle_id"])
            next_state = _next_allocation_cycle_state(
                current,
                run,
                expected_revision,
                program_config_hash,
            )
            stored_run = deepcopy(run)
            stored_run["cycle_revision"] = next_state["revision"]
            self.allocation_runs[stored_run["run_id"]] = deepcopy(stored_run)
            self.allocation_cycles[run["cycle_id"]] = next_state
            return deepcopy(stored_run)

    def get_university_dashboard(self, institution_id: str | None = None) -> Dict[str, Any]:
        applications = (
            self.list_institution_applications(institution_id)
            if institution_id is not None
            else []
        )
        applicants = []
        for application in applications:
            profile = self.profiles.get(application["student_id"], {})
            applicants.append(
                {
                    "student_id": application["student_id"],
                    "application_id": application["application_id"],
                    "reference_id": application.get("reference_id"),
                    "program_id": application["program_id"],
                    "program": application["program"],
                    "full_name": profile.get("full_name"),
                    "location": profile.get("location"),
                    "stream": profile.get("stream"),
                    "academic_score": profile.get("academic_score"),
                    "budget": profile.get("budget"),
                    "status": application["status"],
                }
            )
        institution_criteria = self.university_criteria.get(institution_id, {}) if institution_id else {}
        application_student_ids = {item["student_id"] for item in applications}
        return {
            "total_applicants": len(applicants),
            "pending_reviews": sum(
                item["status"] in {"submitted", "under_review", "documents_requested"}
                for item in applications
            ),
            "verified_documents": sum(
                item.get("student_id") in application_student_ids
                and item.get("verification_status") == "verified"
                for item in self.documents.values()
            ),
            "criteria": institution_criteria,
            "program_criteria": self.get_program_criteria(institution_id),
            "applicants": applicants[:10],
        }

    def update_university_criteria(
        self,
        criteria: Dict[str, Any],
        institution_id: str | None = None,
    ) -> Dict[str, Any]:
        if institution_id is None:
            self.university_criteria.update(criteria)
            return self.university_criteria
        self.university_criteria[institution_id] = {
            **self.university_criteria.get(institution_id, {}),
            **criteria,
        }
        return deepcopy(self.university_criteria[institution_id])


class MongoStore:
    backend_name = "mongodb"

    def __init__(self, uri: str | None = None, database_name: str | None = None) -> None:
        from app.core.config import get_settings

        settings = get_settings()
        self.uri = uri if uri is not None else settings.mongodb_uri
        self.database_name = database_name or settings.mongodb_database
        self.client = None
        self.db = None
        self.connected = False
        self.connection_error: str | None = None
        self.users = {}
        self.profiles = {}
        self.documents = {}
        self.interviews = {}
        self.applications = {}
        self.allocation_runs = {}
        self.allocation_cycles = {}
        self.allocation_runs = {}
        self.program_criteria: List[Dict[str, Any]] = []
        self.university_criteria = {
            "minimum_aggregate": 75.0,
            "reservation_policy": "General, OBC-NCL, SC, ST, EWS",
            "manual_review_triggers": ["document mismatch", "budget gap", "missing entrance result"],
            "ranking_weights": {
                "academic_score": 0.4,
                "exam_score": 0.3,
                "budget_fit": 0.2,
                "interest_alignment": 0.1,
            },
        }
        self._connect()

    def _connect(self) -> None:
        if not self.uri:
            self.connection_error = "MONGODB_URI is not configured."
            self.connected = False
            return

        try:
            from pymongo import MongoClient

            self.client = MongoClient(
                self.uri,
                serverSelectionTimeoutMS=5000,
                connectTimeoutMS=5000,
                socketTimeoutMS=5000,
                uuidRepresentation="standard",
            )
            self.client.admin.command("ping")
            topology = self.client.admin.command("hello")
            if not topology.get("setName") and topology.get("msg") != "isdbgrid":
                raise _UnsupportedMongoTransactionTopology(
                    "MongoDB must be a replica set or sharded cluster to support allocation transactions."
                )
            self.db = self.client[self.database_name]
            self.connected = True
            self.connection_error = None
            self._ensure_indexes()
            self._load_seed_state()
        except _UnsupportedMongoTransactionTopology as exc:
            if self.client is not None:
                self.client.close()
            self.client = None
            self.db = None
            self.connected = False
            self.connection_error = str(exc)
        except Exception as exc:  # pragma: no cover - exercises fallback path in integration tests
            if self.client is not None:
                self.client.close()
            self.client = None
            self.db = None
            self.connected = False
            self.connection_error = f"MongoDB connection failed ({type(exc).__name__})."

    def _ensure_indexes(self) -> None:
        if self.db is None:
            return
        self.db.users.create_index("email", unique=True)
        self.db.profiles.create_index("student_id", unique=True)
        self.db.documents.create_index("student_id")
        self.db.documents.create_index("document_id", unique=True)
        self.db.interviews.create_index("student_id")
        self.db.interviews.create_index("interview_id", unique=True)
        self.db.chat_sessions.create_index([("student_id", 1), ("updated_at", -1)])
        self.db.chat_sessions.create_index("session_id", unique=True)
        self.db.saved_colleges.create_index(
            [("student_id", 1), ("college_id", 1)],
            unique=True,
        )
        self.db.saved_colleges.create_index([("student_id", 1), ("saved_at", -1)])
        self.db.applications.create_index("application_id", unique=True)
        self.db.applications.create_index(
            "reference_id",
            unique=True,
            partialFilterExpression={"reference_id": {"$type": "string"}},
        )
        self.db.applications.create_index(
            [("student_id", 1), ("program_id", 1), ("admission_cycle", 1)],
            unique=True,
        )
        self.db.applications.create_index([("institution_id", 1), ("created_at", -1)])
        self.db.recommendations.create_index("student_id", unique=True)
        self.db.recommendations.create_index([("student_id", 1), ("latest.created_at", -1)])
        self.db.allocations.create_index([("student_id", 1), ("created_at", -1)])
        self.db.allocations.create_index("allocation_id", unique=True)
        self.db.allocations.create_index(
            [("cycle_id", 1), ("submission_hash", 1)],
            unique=True,
            partialFilterExpression={
                "cycle_id": {"$type": "string"},
                "submission_hash": {"$type": "string"},
            },
        )
        self.db.allocation_cycles.create_index("cycle_id", unique=True)

    def _load_seed_state(self) -> None:
        if self.db is None:
            return
        criteria = self.db.settings.find_one({"key": "university_criteria"})
        if criteria:
            self.university_criteria = criteria["value"]
        program_criteria = self.db.settings.find_one({"key": "program_criteria"})
        if program_criteria and isinstance(program_criteria.get("value"), list):
            self.program_criteria = program_criteria["value"]

    @staticmethod
    def _deserialize(document: Dict[str, Any] | None) -> Dict[str, Any] | None:
        if document is None:
            return None
        result = dict(document)
        result.pop("_id", None)
        return result

    def close(self) -> None:
        if self.client is not None:
            self.client.close()
        self.client = None
        self.db = None
        self.connected = False

    def ping(self) -> bool:
        if self.client is None or self.db is None:
            return False
        from pymongo.errors import PyMongoError

        try:
            self.client.admin.command("ping")
        except PyMongoError as exc:
            self.connection_error = f"MongoDB health check failed ({type(exc).__name__})."
            self.connected = False
            return False
        self.connection_error = None
        self.connected = True
        return True

    @property
    def is_available(self) -> bool:
        return self.connected and self.db is not None

    def create_user(self, full_name: str, email: str, password: str, role: str = "student") -> Dict[str, Any]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        student_id = f"user-{uuid.uuid4().hex[:8]}"
        password_hash = hash_password(password)
        user = {
            "id": student_id,
            "full_name": full_name,
            "email": email,
            "password_hash": password_hash,
            "role": role,
            "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        from pymongo.errors import DuplicateKeyError

        try:
            self.db.users.insert_one(user)
        except DuplicateKeyError as exc:
            raise ValueError("User already exists") from exc
        profile = {
            "student_id": student_id,
            "full_name": full_name,
            "email": email,
            "phone": None,
            "location": None,
            "stream": None,
            "board": None,
            "academic_score": None,
            "exam_scores": {},
            "exam_ranks": {},
            "subject_scores": {},
            "admission_year": None,
            "budget": None,
            "career_goal": None,
            "interests": [],
            "preferred_fields": [],
            "reservation_category": None,
            "domicile": None,
            "completion_percent": 10,
            "missing_fields": ["location", "stream", "academic_score", "career_goal"],
            "notes": [],
            "academic_documents": [],
        }
        self.db.profiles.insert_one(profile)
        self.users[email] = user
        self.profiles[student_id] = profile
        return {"id": student_id, "full_name": full_name, "email": email, "role": role}

    def get_user(self, email: str) -> Dict[str, Any] | None:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        return self._deserialize(self.db.users.find_one({"email": email}))

    def delete_student_account(self, student_id: str) -> bool:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        def delete_account(session):
            user = self._deserialize(
                self.db.users.find_one(
                    {"id": student_id, "role": "student"},
                    session=session,
                )
            )
            if user is None:
                return None

            for collection in (
                self.db.documents,
                self.db.interviews,
                self.db.applications,
                self.db.recommendations,
                self.db.chat_sessions,
                self.db.saved_colleges,
                self.db.allocations,
                self.db.profiles,
            ):
                collection.delete_many({"student_id": student_id}, session=session)

            deletion = self.db.users.delete_one(
                {"id": student_id, "role": "student"},
                session=session,
            )
            if deletion.deleted_count != 1:
                raise RuntimeError("Student account changed during account deletion.")
            return user

        with self.client.start_session() as session:
            user = session.with_transaction(delete_account)
        if user is None:
            return False
        self.users.pop(user["email"], None)
        self.profiles.pop(student_id, None)
        return True

    def authenticate(self, email: str, password: str) -> Dict[str, Any]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        user = self.get_user(email)
        if not user:
            raise ValueError("Invalid credentials")
        from app.security.auth import verify_password

        if not verify_password(password, user["password_hash"]):
            raise ValueError("Invalid credentials")
        return {
            "id": user["id"],
            "full_name": user["full_name"],
            "email": user["email"],
            "role": user["role"],
            "institution_id": user.get("institution_id"),
        }

    def get_profile(self, student_id: str) -> Dict[str, Any]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        profile = self._deserialize(self.db.profiles.find_one({"student_id": student_id}))
        if not profile:
            raise ValueError("Profile not found")
        return profile

    def update_profile(self, student_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        profile = self._deserialize(self.db.profiles.find_one({"student_id": student_id})) or {"student_id": student_id}
        profile.update(
            {
                key: value
                for key, value in payload.items()
                if value is not None
                or key in {
                    "academic_score",
                    "admission_year",
                    "reservation_category",
                    "domicile",
                }
            }
        )
        profile["completion_percent"] = self._profile_completion(profile)
        profile["missing_fields"] = self._missing_fields(profile)
        self.db.profiles.update_one({"student_id": student_id}, {"$set": profile}, upsert=True)
        self.profiles[student_id] = profile
        return profile

    def _missing_fields(self, profile: Dict[str, Any]) -> list[str]:
        required = [
            "full_name",
            "email",
            "location",
            "stream",
            "board",
            "academic_score",
            "career_goal",
            "budget",
        ]
        missing = []
        for field in required:
            value = profile.get(field)
            if value in (None, "", [], {}):
                missing.append(field)
        return missing

    def _profile_completion(self, profile: Dict[str, Any]) -> int:
        required = [
            "full_name",
            "email",
            "location",
            "stream",
            "board",
            "academic_score",
            "career_goal",
            "budget",
        ]
        total = len(required)
        filled = 0
        for field in required:
            value = profile.get(field)
            if value not in (None, "", [], {}):
                filled += 1
        return int(round((filled / total) * 100))

    def add_document(self, record: Dict[str, Any]) -> Dict[str, Any]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        document = dict(record)
        self.db.documents.insert_one(document)
        self.documents[document["document_id"]] = document
        return document

    def list_documents(self, student_id: str) -> list[Dict[str, Any]]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        documents = []
        for item in self.db.documents.find({"student_id": student_id}):
            document = self._deserialize(item)
            if document is not None:
                documents.append(document)
        return documents

    def get_document(self, document_id: str, student_id: str) -> Dict[str, Any] | None:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        return self._deserialize(
            self.db.documents.find_one(
                {"document_id": document_id, "student_id": student_id}
            )
        )

    def update_document_processing(
        self,
        document_id: str,
        student_id: str,
        processing: Dict[str, Any],
        updated_at: str,
    ) -> Dict[str, Any] | None:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        result = self.db.documents.update_one(
            {
                "document_id": document_id,
                "student_id": student_id,
                "status": {"$ne": "reviewed"},
            },
            {"$set": {**processing, "updated_at": updated_at}},
        )
        if result.matched_count == 0:
            return None
        return self.get_document(document_id, student_id)

    def mark_document_reviewed(
        self,
        document_id: str,
        student_id: str,
        reviewed_fields: Dict[str, Any],
        reviewed_at: str,
    ) -> Dict[str, Any] | None:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        self.db.documents.update_one(
            {"document_id": document_id, "student_id": student_id},
            {
                "$set": {
                    "status": "reviewed",
                    "processing_status": "reviewed",
                    "reviewed_fields": reviewed_fields,
                    "reviewed_at": reviewed_at,
                    "updated_at": reviewed_at,
                }
            },
        )
        return self.get_document(document_id, student_id)

    def update_document_verification(
        self,
        document_id: str,
        student_id: str,
        verification_status: str,
        note: str,
        institution_id: str,
        verified_at: str,
    ) -> Dict[str, Any] | None:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        result = self.db.documents.update_one(
            {"document_id": document_id, "student_id": student_id},
            {
                "$set": {
                    "verification_status": verification_status,
                    "verification_note": note,
                    "verified_by_institution_id": institution_id,
                    "verified_at": verified_at,
                    "updated_at": verified_at,
                }
            },
        )
        if result.matched_count == 0:
            return None
        return self.get_document(document_id, student_id)

    def get_program_criteria(self, institution_id: str | None = None) -> List[Dict[str, Any]]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        programs = self.program_criteria
        if institution_id is not None:
            programs = [item for item in programs if item.get("institution_id") == institution_id]
        return deepcopy(programs)

    def replace_program_criteria(self, programs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        self.program_criteria = deepcopy(programs)
        self.db.settings.update_one(
            {"key": "program_criteria"},
            {"$set": {"key": "program_criteria", "value": self.program_criteria}},
            upsert=True,
        )
        return self.get_program_criteria()

    def replace_program_criteria_for_institution(
        self,
        institution_id: str,
        programs: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        if any(item.get("institution_id") != institution_id for item in programs):
            raise ValueError("Program criteria must belong to the authenticated institution.")
        others = [
            item for item in self.program_criteria
            if item.get("institution_id") != institution_id
        ]
        if {item.get("program_id") for item in others} & {
            item.get("program_id") for item in programs
        }:
            raise ValueError("Program IDs must be unique across institutions.")
        combined = [*others, *programs]
        self.program_criteria = deepcopy(combined)
        self.db.settings.update_one(
            {"key": "program_criteria"},
            {"$set": {"key": "program_criteria", "value": self.program_criteria}},
            upsert=True,
        )
        return self.get_program_criteria(institution_id)

    def create_application(self, application: Dict[str, Any]) -> Dict[str, Any]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        from pymongo.errors import DuplicateKeyError

        try:
            self.db.applications.insert_one(deepcopy(application))
        except DuplicateKeyError as exc:
            raise DuplicateApplicationError(
                "An application already exists for this program and admission cycle."
            ) from exc
        self.applications[application["application_id"]] = deepcopy(application)
        return deepcopy(application)

    def list_student_applications(self, student_id: str) -> List[Dict[str, Any]]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        return sorted(
            (
                self._deserialize(item)
                for item in self.db.applications.find({"student_id": student_id})
            ),
            key=lambda item: item["created_at"],
            reverse=True,
        )

    def list_institution_applications(self, institution_id: str) -> List[Dict[str, Any]]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        return sorted(
            (
                self._deserialize(item)
                for item in self.db.applications.find(
                    {"institution_id": institution_id, "status": {"$ne": "draft"}}
                )
            ),
            key=lambda item: item["created_at"],
            reverse=True,
        )

    def get_application(
        self,
        application_id: str,
        *,
        student_id: str | None = None,
        institution_id: str | None = None,
    ) -> Dict[str, Any] | None:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        query = {"application_id": application_id}
        if student_id is not None:
            query["student_id"] = student_id
        if institution_id is not None:
            query["institution_id"] = institution_id
            query["status"] = {"$ne": "draft"}
        return self._deserialize(self.db.applications.find_one(query))

    def update_application(
        self,
        application_id: str,
        expected_updated_at: str,
        updates: Dict[str, Any],
    ) -> Dict[str, Any] | None:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        result = self.db.applications.update_one(
            {"application_id": application_id, "updated_at": expected_updated_at},
            {"$set": deepcopy(updates)},
        )
        if result.matched_count != 1:
            return None
        return self.get_application(application_id)

    def create_interview_session(
        self,
        student_id: str,
        program: str,
        interview_type: str,
        question_count: int,
        mode: str,
    ) -> Dict[str, Any]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        result = _new_interview_session(
            student_id,
            program,
            interview_type,
            question_count,
            mode,
        )
        self.db.interviews.insert_one(result)
        self.interviews[result["interview_id"]] = deepcopy(result)
        return deepcopy(result)

    def create_interview(self, student_id: str, stream: str, question_count: int, mode: str) -> Dict[str, Any]:
        return self.create_interview_session(student_id, stream, "general", question_count, mode)

    def get_interview_session(self, interview_id: str, student_id: str) -> Dict[str, Any] | None:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        record = self.db.interviews.find_one(
            {"interview_id": interview_id, "student_id": student_id}
        )
        if record is None:
            return None
        record = self._normalize_legacy_interview(record)
        return self._deserialize(record)

    def list_interview_sessions(self, student_id: str) -> List[Dict[str, Any]]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        sessions = [
            self._deserialize(self._normalize_legacy_interview(item))
            for item in self.db.interviews.find({"student_id": student_id})
        ]
        return sorted(
            (item for item in sessions if item is not None),
            key=lambda item: item["created_at"],
            reverse=True,
        )

    def update_interview_session(
        self,
        interview_id: str,
        student_id: str,
        expected_updated_at: str,
        updates: Dict[str, Any],
    ) -> Dict[str, Any] | None:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        selector = {
            "interview_id": interview_id,
            "student_id": student_id,
            "updated_at": expected_updated_at,
        }
        result = self.db.interviews.update_one(selector, {"$set": deepcopy(updates)})
        if result.matched_count != 1:
            return None
        return self.get_interview_session(interview_id, student_id)

    def save_ai_recommendation(self, record: Dict[str, Any]) -> Dict[str, Any]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        stored = deepcopy(record)
        self.db.recommendations.update_one(
            {"student_id": record["student_id"]},
            {
                "$set": {"latest": stored},
                "$push": {"history": {"$each": [stored], "$slice": -20}},
                "$setOnInsert": {"student_id": record["student_id"]},
            },
            upsert=True,
        )
        return deepcopy(record)

    def get_latest_ai_recommendation(self, student_id: str) -> Dict[str, Any] | None:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        document = self._deserialize(
            self.db.recommendations.find_one({"student_id": student_id})
        )
        if not document:
            return None
        latest = document.get("latest")
        if isinstance(latest, dict):
            return latest
        history = document.get("history")
        return history[-1] if isinstance(history, list) and history else None

    def list_ai_recommendations(self, student_id: str) -> List[Dict[str, Any]]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        document = self._deserialize(
            self.db.recommendations.find_one({"student_id": student_id})
        )
        history = document.get("history", []) if document else []
        if not isinstance(history, list):
            return []
        records = [item for item in history if isinstance(item, dict)]
        return sorted(records, key=lambda item: item.get("created_at", ""), reverse=True)

    def create_chat_session(self, student_id: str, title: str = "New conversation") -> Dict[str, Any]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        now = datetime.now(timezone.utc).isoformat()
        session = {
            "session_id": f"chat-{uuid.uuid4().hex}",
            "student_id": student_id,
            "title": title,
            "created_at": now,
            "updated_at": now,
            "messages": [],
        }
        self.db.chat_sessions.insert_one(deepcopy(session))
        return session

    def list_chat_sessions(self, student_id: str) -> List[Dict[str, Any]]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        sessions = [
            self._deserialize(item)
            for item in self.db.chat_sessions.find({"student_id": student_id})
        ]
        return sorted(
            (item for item in sessions if item is not None),
            key=lambda item: item.get("updated_at", ""),
            reverse=True,
        )

    def get_chat_session(self, session_id: str, student_id: str) -> Dict[str, Any] | None:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        return self._deserialize(
            self.db.chat_sessions.find_one(
                {"session_id": session_id, "student_id": student_id}
            )
        )

    def append_chat_messages(
        self,
        session_id: str,
        student_id: str,
        messages: List[Dict[str, Any]],
        *,
        title: str | None = None,
    ) -> Dict[str, Any] | None:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        updates: Dict[str, Any] = {"updated_at": datetime.now(timezone.utc).isoformat()}
        if title:
            updates["title"] = title
        result = self.db.chat_sessions.update_one(
            {"session_id": session_id, "student_id": student_id},
            {
                "$set": updates,
                "$push": {"messages": {"$each": deepcopy(messages)}},
            },
        )
        if result.matched_count != 1:
            return None
        return self.get_chat_session(session_id, student_id)

    def delete_chat_session(self, session_id: str, student_id: str) -> bool:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        result = self.db.chat_sessions.delete_one(
            {"session_id": session_id, "student_id": student_id}
        )
        return result.deleted_count == 1

    def list_saved_colleges(self, student_id: str) -> List[Dict[str, Any]]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        records = [
            self._deserialize(item)
            for item in self.db.saved_colleges.find({"student_id": student_id})
        ]
        return sorted(
            (item for item in records if item is not None),
            key=lambda item: item.get("saved_at", ""),
            reverse=True,
        )

    def save_college(self, student_id: str, college_id: str) -> Dict[str, Any]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        record = {
            "student_id": student_id,
            "college_id": college_id,
            "saved_at": datetime.now(timezone.utc).isoformat(),
        }
        self.db.saved_colleges.update_one(
            {"student_id": student_id, "college_id": college_id},
            {"$setOnInsert": record},
            upsert=True,
        )
        saved = self._deserialize(
            self.db.saved_colleges.find_one(
                {"student_id": student_id, "college_id": college_id}
            )
        )
        if saved is None:
            raise RuntimeError("Saved college could not be loaded after writing.")
        return saved

    def delete_saved_college(self, student_id: str, college_id: str) -> bool:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        result = self.db.saved_colleges.delete_one(
            {"student_id": student_id, "college_id": college_id}
        )
        return result.deleted_count == 1

    def _normalize_legacy_interview(self, record: Dict[str, Any]) -> Dict[str, Any]:
        if "status" in record:
            return record
        now = datetime.now(timezone.utc).isoformat()
        questions = record.get("questions")
        questions = questions if isinstance(questions, list) else []
        created_at = record.get("created_at") or now
        updates = {
            "program": record.get("stream") or "Legacy practice session",
            "interview_type": "general",
            "question_count": max(1, min(10, len(questions) or 5)),
            "mode": "text",
            "status": "created",
            "turns": [],
            "questions": questions,
            "generation_mode": "pending",
            "generation_notice": (
                "This older scripted session has no saved answers. Start it to begin an interactive practice session."
            ),
            "feedback": None,
            "created_at": created_at,
            "updated_at": record.get("updated_at") or created_at,
            "completed_at": None,
        }
        self.db.interviews.update_one(
            {
                "interview_id": record.get("interview_id"),
                "student_id": record.get("student_id"),
            },
            {"$set": updates},
        )
        return {**record, **updates}

    def save_allocation_run(self, run: Dict[str, Any]) -> Dict[str, Any]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        self.db.allocations.insert_one(
            {
                "allocation_id": run["run_id"],
                "created_at": run["created_at"],
                **deepcopy(run),
            }
        )
        return deepcopy(run)

    def get_allocation_run(self, run_id: str) -> Dict[str, Any] | None:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        record = self._deserialize(
            self.db.allocations.find_one({"allocation_id": run_id})
        )
        if record is None:
            return None
        record.pop("allocation_id", None)
        return record

    def get_allocation_run_by_submission(
        self,
        cycle_id: str,
        submission_hash: str,
    ) -> Dict[str, Any] | None:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        record = self._deserialize(
            self.db.allocations.find_one(
                {"cycle_id": cycle_id, "submission_hash": submission_hash}
            )
        )
        if record is None:
            return None
        record.pop("allocation_id", None)
        return record

    def get_allocation_cycle_state(self, cycle_id: str) -> Dict[str, Any]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        record = self._deserialize(
            self.db.allocation_cycles.find_one({"cycle_id": cycle_id})
        )
        if record is None:
            return {
                "cycle_id": cycle_id,
                "revision": 0,
                "program_config_hash": None,
                "used_seats": {},
                "allocated_students": {},
            }
        record["used_seats"] = {
            item["program_id"]: item["used"]
            for item in record.get("used_seats", [])
        }
        record["allocated_students"] = {
            item["student_id"]: item["program_id"]
            for item in record.get("allocated_students", [])
        }
        return record

    def save_cycle_allocation_run(
        self,
        run: Dict[str, Any],
        expected_revision: int,
        program_config_hash: str,
    ) -> Dict[str, Any]:
        if not self.is_available or self.client is None:
            raise RuntimeError("MongoDB is not available.")
        from pymongo.errors import DuplicateKeyError

        def commit(session):
            existing = self.db.allocations.find_one(
                {
                    "cycle_id": run["cycle_id"],
                    "submission_hash": run["submission_hash"],
                },
                session=session,
            )
            if existing is not None:
                existing = self._deserialize(existing)
                existing.pop("allocation_id", None)
                return existing

            record = self._deserialize(
                self.db.allocation_cycles.find_one(
                    {"cycle_id": run["cycle_id"]},
                    session=session,
                )
            )
            if record is None:
                current = {
                    "cycle_id": run["cycle_id"],
                    "revision": 0,
                    "program_config_hash": None,
                    "used_seats": {},
                    "allocated_students": {},
                }
            else:
                current = {
                    **record,
                    "used_seats": {
                        item["program_id"]: item["used"]
                        for item in record.get("used_seats", [])
                    },
                    "allocated_students": {
                        item["student_id"]: item["program_id"]
                        for item in record.get("allocated_students", [])
                    },
                }

            next_state = _next_allocation_cycle_state(
                current,
                run,
                expected_revision,
                program_config_hash,
            )
            stored_run = deepcopy(run)
            stored_run["cycle_revision"] = next_state["revision"]
            self.db.allocations.insert_one(
                {
                    "allocation_id": stored_run["run_id"],
                    "created_at": stored_run["created_at"],
                    **stored_run,
                },
                session=session,
            )
            update = self.db.allocation_cycles.update_one(
                {
                    "cycle_id": run["cycle_id"],
                    "revision": expected_revision,
                },
                {
                    "$set": {
                        "cycle_id": run["cycle_id"],
                        "revision": next_state["revision"],
                        "program_config_hash": program_config_hash,
                        "used_seats": [
                            {"program_id": key, "used": value}
                            for key, value in sorted(next_state["used_seats"].items())
                        ],
                        "allocated_students": [
                            {"student_id": key, "program_id": value}
                            for key, value in sorted(next_state["allocated_students"].items())
                        ],
                    }
                },
                upsert=record is None,
                session=session,
            )
            if update.matched_count != 1 and update.upserted_id is None:
                raise AllocationConflict(
                    "The allocation cycle changed during this run. Retry with current cycle state."
                )
            return stored_run

        try:
            with self.client.start_session() as session:
                return session.with_transaction(commit)
        except DuplicateKeyError as exc:
            existing = self.get_allocation_run_by_submission(
                run["cycle_id"],
                run["submission_hash"],
            )
            if existing is not None:
                return existing
            raise AllocationConflict(
                "A conflicting allocation was submitted for this cycle. Retry with current cycle state."
            ) from exc

    def get_university_dashboard(self, institution_id: str | None = None) -> Dict[str, Any]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        if institution_id is None:
            applications = []
        else:
            applications = self.list_institution_applications(institution_id)
        applicants = []
        for application in applications:
            profile = self._deserialize(
                self.db.profiles.find_one({"student_id": application["student_id"]})
            ) or {}
            applicants.append(
                {
                    "student_id": application["student_id"],
                    "application_id": application["application_id"],
                    "reference_id": application.get("reference_id"),
                    "program_id": application["program_id"],
                    "program": application["program"],
                    "full_name": profile.get("full_name"),
                    "location": profile.get("location"),
                    "stream": profile.get("stream"),
                    "academic_score": profile.get("academic_score"),
                    "budget": profile.get("budget"),
                    "status": application["status"],
                }
            )
        student_ids = {item["student_id"] for item in applications}
        verified_documents = (
            self.db.documents.count_documents(
                {
                    "student_id": {"$in": list(student_ids)},
                    "verification_status": "verified",
                }
            )
            if student_ids
            else 0
        )
        criteria = {}
        if institution_id is not None:
            setting = self.db.settings.find_one(
                {"key": f"university_criteria:{institution_id}"}
            )
            if setting is not None:
                criteria = setting.get("value", {})
        return {
            "total_applicants": len(applicants),
            "pending_reviews": sum(
                item["status"] in {"submitted", "under_review", "documents_requested"}
                for item in applications
            ),
            "verified_documents": verified_documents,
            "criteria": criteria,
            "program_criteria": self.get_program_criteria(institution_id),
            "applicants": applicants[:10],
        }

    def update_university_criteria(
        self,
        criteria: Dict[str, Any],
        institution_id: str | None = None,
    ) -> Dict[str, Any]:
        if not self.is_available:
            raise RuntimeError("MongoDB is not available.")
        if institution_id is not None:
            setting_key = f"university_criteria:{institution_id}"
            setting = self.db.settings.find_one({"key": setting_key})
            current = setting.get("value", {}) if setting is not None else {}
            updated = {**current, **criteria}
            self.db.settings.update_one(
                {"key": setting_key},
                {"$set": {"key": setting_key, "value": updated}},
                upsert=True,
            )
            return updated
        self.university_criteria.update(criteria)
        self.db.settings.update_one({"key": "university_criteria"}, {"$set": {"key": "university_criteria", "value": self.university_criteria}}, upsert=True)
        return self.university_criteria


class StoreManager:
    def __init__(self) -> None:
        from app.core.config import get_settings

        settings = get_settings()
        if getattr(settings, "storage_backend", "auto") == "demo":
            if settings.app_env.lower() == "production":
                raise RuntimeError("Demo storage is not allowed in production.")
            self.mongo_store = None
            self.backend_name = "demo"
            self.demo_store = DemoStore()
            self._active_store = self.demo_store
            return

        self.mongo_store = MongoStore()
        if self.mongo_store.is_available:
            self.backend_name = "mongodb"
            self._active_store = self.mongo_store
        elif settings.app_env.lower() == "production":
            error = self.mongo_store.connection_error or "Connection was not established."
            raise RuntimeError(f"MongoDB is required in production but unavailable: {error}")
        else:
            self.demo_store = DemoStore()
            self.backend_name = "demo"
            self._active_store = self.demo_store

    @property
    def users(self):
        return self._active_store.users

    @property
    def profiles(self):
        return self._active_store.profiles

    @property
    def documents(self):
        return self._active_store.documents

    @property
    def interviews(self):
        return self._active_store.interviews

    @property
    def university_criteria(self):
        return self._active_store.university_criteria

    @property
    def program_criteria(self):
        return self._active_store.program_criteria

    def __getattr__(self, name: str):
        return getattr(self._active_store, name)

    def close(self) -> None:
        if self.mongo_store is not None:
            self.mongo_store.close()

    @property
    def is_healthy(self) -> bool:
        if self.backend_name == "mongodb":
            return self.mongo_store.ping()
        return self.backend_name == "demo"


def get_store() -> StoreManager:
    if not hasattr(get_store, "instance"):
        get_store.instance = StoreManager()  # type: ignore[attr-defined]
    return get_store.instance
