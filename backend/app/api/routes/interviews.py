from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, status

from app.agents.interview_agent import InterviewAgent
from app.api.routes.dependencies import get_current_user, require_roles
from app.database.store import get_store
from app.llm.provider import LLMModelNotFoundError, LLMProviderUnavailableError, LLMResponseError
from app.schemas.interview import (
    InterviewAnswerRequest,
    InterviewCreateRequest,
    InterviewSessionResponse,
)

router = APIRouter(prefix="/interviews", tags=["interviews"])


def get_interview_agent() -> InterviewAgent:
    return InterviewAgent()


def _session_or_404(interview_id: str, student_id: str) -> dict[str, Any]:
    session = get_store().get_interview_session(interview_id, student_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview session not found.")
    return session


def _combined_generation_mode(existing: str, current: str) -> str:
    if existing == "pending" or existing == current:
        return current
    return "mixed"


def _generation_notice(existing: str, current: str, notice: str) -> str:
    combined = _combined_generation_mode(existing, current)
    if combined == "mixed":
        if existing in {"ollama", "openai"} or current in {"ollama", "openai"}:
            return "This session used configured AI and deterministic fallback practice content."
        return "This session used mixed deterministic fallback practice content."
    return notice


def _interview_ai_error(error: Exception) -> HTTPException:
    if isinstance(error, LLMModelNotFoundError):
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "status": "model_missing",
                "message": "The configured Ollama model is missing. Pull it with `ollama pull <model>`.",
            },
        )
    if isinstance(error, LLMProviderUnavailableError):
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "status": "ollama_unavailable",
                "message": "Local Ollama is unavailable. Start it with `ollama serve`.",
            },
        )
    if isinstance(error, httpx.TimeoutException):
        return HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail={
                "status": "inference_timeout",
                "message": "Local Ollama inference timed out. Retry after checking the model service.",
            },
        )
    if isinstance(error, httpx.HTTPError):
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "status": "ollama_unavailable",
                "message": "The local Ollama request failed. Check the service and retry.",
            },
        )
    if isinstance(error, LLMResponseError):
        return HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "status": "inference_failed",
                "message": "Local Ollama did not return valid interview content. Retry the request.",
            },
        )
    raise error


def _persist_transition(
    session: dict[str, Any],
    updates: dict[str, Any],
) -> InterviewSessionResponse:
    updated = get_store().update_interview_session(
        session["interview_id"],
        session["student_id"],
        session["updated_at"],
        updates,
    )
    if updated is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The interview session changed. Reload it before continuing.",
        )
    return InterviewSessionResponse.model_validate(updated)


@router.post("", response_model=InterviewSessionResponse)
def create_interview(
    payload: InterviewCreateRequest,
    current_user: dict = Depends(require_roles("student")),
):
    if payload.student_id and payload.student_id != current_user["id"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot create an interview for another student.",
        )
    session = get_store().create_interview_session(
        current_user["id"],
        payload.program,
        payload.interview_type,
        payload.question_count,
        payload.mode,
    )
    return InterviewSessionResponse.model_validate(session)


@router.get("", response_model=list[InterviewSessionResponse])
def list_interviews(current_user: dict = Depends(require_roles("student"))):
    return [
        InterviewSessionResponse.model_validate(session)
        for session in get_store().list_interview_sessions(current_user["id"])
    ]


@router.get("/{interview_id}", response_model=InterviewSessionResponse)
def get_interview(
    interview_id: str,
    current_user: dict = Depends(require_roles("student")),
):
    return InterviewSessionResponse.model_validate(
        _session_or_404(interview_id, current_user["id"])
    )


@router.post("/{interview_id}/start", response_model=InterviewSessionResponse)
def start_interview(
    interview_id: str,
    current_user: dict = Depends(require_roles("student")),
    agent: InterviewAgent = Depends(get_interview_agent),
):
    session = _session_or_404(interview_id, current_user["id"])
    if session["status"] != "created":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only a newly created interview session can be started.",
        )
    profile = get_store().get_profile(current_user["id"]) or {}
    try:
        generated = agent.generate_question(
            session["program"],
            session["interview_type"],
            profile,
            [],
        )
    except (LLMResponseError, httpx.HTTPError) as exc:
        raise _interview_ai_error(exc) from exc
    now = datetime.now(timezone.utc).isoformat()
    turn = {
        "question": generated.question,
        "answer": None,
        "asked_at": now,
        "answered_at": None,
        "generation_mode": generated.generation_mode,
    }
    return _persist_transition(
        session,
        {
            "status": "in_progress",
            "turns": [turn],
            "questions": [generated.question],
            "generation_mode": generated.generation_mode,
            "generation_notice": generated.notice,
            "updated_at": now,
        },
    )


@router.post("/{interview_id}/answers", response_model=InterviewSessionResponse)
def submit_answer(
    interview_id: str,
    payload: InterviewAnswerRequest,
    current_user: dict = Depends(require_roles("student")),
    agent: InterviewAgent = Depends(get_interview_agent),
):
    session = _session_or_404(interview_id, current_user["id"])
    if session["status"] != "in_progress":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Answers can only be submitted to an in-progress interview session.",
        )
    turns = list(session["turns"])
    if not turns or turns[-1].get("answer") is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="There is no unanswered question in this session.",
        )

    now = datetime.now(timezone.utc).isoformat()
    turns[-1] = {
        **turns[-1],
        "answer": payload.answer,
        "answered_at": now,
    }
    questions = list(session["questions"])
    profile = get_store().get_profile(current_user["id"]) or {}
    if len(turns) >= session["question_count"]:
        try:
            generated = agent.generate_feedback(
                session["program"],
                session["interview_type"],
                turns,
            )
        except (LLMResponseError, httpx.HTTPError) as exc:
            raise _interview_ai_error(exc) from exc
        generation_mode = _combined_generation_mode(
            session["generation_mode"],
            generated.generation_mode,
        )
        return _persist_transition(
            session,
            {
                "status": "completed",
                "turns": turns,
                "generation_mode": generation_mode,
                "generation_notice": _generation_notice(
                    session["generation_mode"],
                    generated.generation_mode,
                    generated.notice,
                ),
                "feedback": generated.feedback,
                "completed_at": now,
                "updated_at": now,
            },
        )

    try:
        generated_question = agent.generate_question(
            session["program"],
            session["interview_type"],
            profile,
            turns,
        )
    except (LLMResponseError, httpx.HTTPError) as exc:
        raise _interview_ai_error(exc) from exc
    turns.append(
        {
            "question": generated_question.question,
            "answer": None,
            "asked_at": now,
            "answered_at": None,
            "generation_mode": generated_question.generation_mode,
        }
    )
    questions.append(generated_question.question)
    generation_mode = _combined_generation_mode(
        session["generation_mode"],
        generated_question.generation_mode,
    )
    return _persist_transition(
        session,
        {
            "status": "in_progress",
            "turns": turns,
            "questions": questions,
            "generation_mode": generation_mode,
            "generation_notice": _generation_notice(
                session["generation_mode"],
                generated_question.generation_mode,
                generated_question.notice,
            ),
            "updated_at": now,
        },
    )
