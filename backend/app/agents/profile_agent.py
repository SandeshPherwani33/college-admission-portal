from __future__ import annotations

from typing import Any, Dict

from app.llm.provider import LLMProviderUnavailableError, LLMResponseError, OllamaLLMProvider, get_llm_provider


class ProfileAgent:
    def __init__(self) -> None:
        self.provider = get_llm_provider()

    def extract(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        profile = {
            "student_id": raw.get("student_id"),
            "full_name": raw.get("full_name", "Student"),
            "email": raw.get("email"),
            "phone": raw.get("phone"),
            "location": raw.get("location"),
            "stream": raw.get("stream", "Science"),
            "board": raw.get("board", "CBSE"),
            "academic_score": raw.get("academic_score"),
            "exam_scores": raw.get("exam_scores", {}),
            "budget": raw.get("budget"),
            "career_goal": raw.get("career_goal"),
            "interests": raw.get("interests", []),
            "preferred_fields": raw.get("preferred_fields", []),
            "reservation_category": raw.get("reservation_category"),
            "domicile": raw.get("domicile"),
            "notes": raw.get("notes", []),
        }
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
        missing = [field for field in required if not profile.get(field)]
        profile["completion_percent"] = int(round((len(required) - len(missing)) / len(required) * 100))
        profile["missing_fields"] = missing

        if not self.provider.is_available:
            if isinstance(self.provider, OllamaLLMProvider):
                raise LLMProviderUnavailableError("Local Ollama is unavailable for profile extraction.")
            return profile

        prompt = (
            "Extract a structured student profile JSON from the provided data. "
            "Return only valid JSON with the keys: full_name, email, location, stream, board, "
            "academic_score, budget, career_goal, interests, preferred_fields, reservation_category, domicile."
        )
        try:
            payload = self.provider.generate_json(
                prompt,
                fallback=profile,
                schema={"required": ["full_name", "email", "stream", "board", "academic_score", "budget", "career_goal"]},
                system_prompt="Return a valid JSON object for the student intake profile. Do not add commentary.",
            )
            if isinstance(payload, dict):
                merged = profile.copy()
                merged.update({key: value for key, value in payload.items() if value is not None})
                if merged.get("missing_fields") is None:
                    merged["missing_fields"] = [field for field in required if not merged.get(field)]
                return merged
        except (TypeError, ValueError, LLMResponseError):
            if isinstance(self.provider, OllamaLLMProvider):
                raise
            return profile

        return profile
