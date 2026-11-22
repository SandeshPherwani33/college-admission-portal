from __future__ import annotations

from typing import Any, Dict

from app.llm.provider import LLMProviderUnavailableError, LLMResponseError, OllamaLLMProvider, get_llm_provider


class DocumentAgent:
    def __init__(self) -> None:
        self.provider = get_llm_provider()

    def normalize(self, filename: str, metadata: Dict[str, Any]) -> Dict[str, Any]:
        fields = {
            "institution": metadata.get("institution") or "Unknown institution",
            "board": metadata.get("board") or "Unknown board",
            "exam": metadata.get("exam") or "Unknown exam",
            "subject_marks": metadata.get("subject_marks", {}),
            "total_marks": metadata.get("total_marks"),
            "percentage": metadata.get("percentage"),
            "cgpa": metadata.get("cgpa"),
            "year": metadata.get("year"),
        }
        warnings = []
        confidence = 0.82
        if not metadata.get("board"):
            warnings.append("Board value could not be confidently extracted")
            confidence -= 0.1
        if not metadata.get("percentage") and not metadata.get("cgpa"):
            warnings.append("No grade conversion was available; percentage may require review")
            confidence -= 0.12

        result = {
            "filename": filename,
            "status": "review_required",
            "extracted_fields": fields,
            "warnings": warnings,
            "confidence": max(0.15, round(confidence, 2)),
        }

        if not self.provider.is_available:
            if isinstance(self.provider, OllamaLLMProvider):
                raise LLMProviderUnavailableError("Local Ollama is unavailable for document normalization.")
            return result

        prompt = (
            "Normalize this student document metadata into a JSON object with institution, board, exam, "
            "percentage, cgpa, year, and subject_marks. If uncertain, preserve uncertainty in warnings."
        )
        try:
            payload = self.provider.generate_json(
                prompt,
                fallback=result,
                schema={"required": ["filename", "status", "extracted_fields"]},
                system_prompt="Return a valid JSON object describing extracted academic metadata. Do not add commentary.",
            )
            if isinstance(payload, dict):
                extracted = payload.get("extracted_fields") if isinstance(payload.get("extracted_fields"), dict) else fields
                result.update({
                    "extracted_fields": extracted,
                    "warnings": payload.get("warnings", warnings),
                    "confidence": payload.get("confidence", result["confidence"]),
                    "status": payload.get("status", result["status"]),
                })
        except (TypeError, ValueError, LLMResponseError):
            if isinstance(self.provider, OllamaLLMProvider):
                raise
            return result

        return result
