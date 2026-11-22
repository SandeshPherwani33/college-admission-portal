from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict, Optional
from urllib.parse import urlsplit

import httpx

from app.core.config import get_settings


logger = logging.getLogger("uniapply.llm")


class LLMResponseError(ValueError):
    """Raised when the configured provider returns an invalid or unusable response."""


class LLMProviderUnavailableError(LLMResponseError):
    """Raised when the configured provider cannot be reached."""


class LLMModelNotFoundError(LLMResponseError):
    """Raised when the configured Ollama model is not installed."""


class LLMInferenceError(LLMResponseError):
    """Raised when the configured provider cannot produce usable output."""


class BaseLLMProvider:
    name = "base"
    mode = "demo"

    def __init__(self, *, provider_name: str, model: str, timeout: float, max_retries: int) -> None:
        self.provider_name = provider_name
        self.model = model
        self.timeout = timeout
        self.max_retries = max_retries

    @property
    def is_available(self) -> bool:
        return False

    def generate_text(self, prompt: str, *, fallback: str, system_prompt: Optional[str] = None) -> str:
        return fallback

    def generate_json(self, prompt: str, *, fallback: Any, schema: Optional[Dict[str, Any]] = None, system_prompt: Optional[str] = None) -> Any:
        return fallback

    def generate_json_strict(self, prompt: str, *, schema: Optional[Dict[str, Any]] = None, system_prompt: Optional[str] = None) -> Any:
        raise LLMResponseError("Strict JSON generation is not supported by this provider.")

    def close(self) -> None:
        return None

    @staticmethod
    def _validate_json_payload(payload: Any, *, schema: Optional[Dict[str, Any]] = None) -> Any:
        if not isinstance(payload, (dict, list)):
            raise LLMResponseError("LLM response must be a JSON object or array.")

        if isinstance(payload, dict) and schema:
            required = schema.get("required", [])
            missing = [field for field in required if field not in payload]
            if missing:
                raise LLMResponseError(f"LLM response missing required fields: {', '.join(missing)}")

        return payload

    @staticmethod
    def _load_json_content(content: Optional[str]) -> Any:
        if content is None or not str(content).strip():
            raise LLMResponseError("LLM returned empty content.")
        try:
            return json.loads(content)
        except json.JSONDecodeError as exc:  # pragma: no cover - tested under invalid response path
            raise LLMResponseError("LLM response was not valid JSON.") from exc


class DemoLLMProvider(BaseLLMProvider):
    name = "demo"
    mode = "demo"

    def __init__(self, *, provider_name: str = "demo", model: str = "demo", timeout: float = 30.0, max_retries: int = 2) -> None:
        super().__init__(provider_name=provider_name, model=model, timeout=timeout, max_retries=max_retries)

    @property
    def is_available(self) -> bool:
        return False

    def generate_text(self, prompt: str, *, fallback: str, system_prompt: Optional[str] = None) -> str:
        return fallback

    def generate_json(self, prompt: str, *, fallback: Any, schema: Optional[Dict[str, Any]] = None, system_prompt: Optional[str] = None) -> Any:
        if isinstance(fallback, dict) and isinstance(schema, dict):
            required = schema.get("required", [])
            if isinstance(required, list):
                for field in required:
                    fallback.setdefault(field, None)
        return fallback


class OpenAILLMProvider(BaseLLMProvider):
    name = "openai"
    mode = "provider"

    def __init__(self, *, api_key: Optional[str], model: str, timeout: float, max_retries: int, base_url: Optional[str] = None) -> None:
        super().__init__(provider_name="openai", model=model, timeout=timeout, max_retries=max_retries)
        self.api_key = api_key
        self.base_url = base_url
        self.client = None
        if api_key:
            try:
                from openai import OpenAI

                self.client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout)
            except Exception:  # pragma: no cover - import errors are handled by the env fallback path
                self.client = None

    @property
    def is_available(self) -> bool:
        return self.client is not None

    def close(self) -> None:
        if self.client is not None:
            close = getattr(self.client, "close", None)
            if callable(close):
                close()

    def generate_text(self, prompt: str, *, fallback: str, system_prompt: Optional[str] = None) -> str:
        if not self.is_available:
            return fallback

        for attempt in range(self.max_retries + 1):
            try:
                response = self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": system_prompt or "Return plain text only."},
                        {"role": "user", "content": prompt},
                    ],
                    temperature=0.2,
                    timeout=self.timeout,
                )
                content = response.choices[0].message.content
                if not content:
                    return fallback
                return content
            except Exception:
                if attempt >= self.max_retries:
                    return fallback
                time.sleep(0.5 * (attempt + 1))
        return fallback

    def generate_json(self, prompt: str, *, fallback: Any, schema: Optional[Dict[str, Any]] = None, system_prompt: Optional[str] = None) -> Any:
        if not self.is_available:
            raise LLMResponseError("OpenAI provider is not configured.")

        last_exc: Optional[Exception] = None
        for attempt in range(self.max_retries + 1):
            try:
                response = self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": (system_prompt or "Return valid JSON only. Do not add commentary.")},
                        {"role": "user", "content": prompt},
                    ],
                    response_format={"type": "json_object"},
                    temperature=0.2,
                    timeout=self.timeout,
                )
                content = response.choices[0].message.content
                payload = self._load_json_content(content)
                validated = self._validate_json_payload(payload, schema=schema)
                return validated
            except Exception as exc:
                last_exc = exc
                if attempt >= self.max_retries:
                    break
                time.sleep(0.5 * (attempt + 1))

        if isinstance(fallback, (dict, list)):
            return self._validate_json_payload(fallback, schema=schema)

        raise LLMResponseError("Provider response validation failed.") from last_exc

    def generate_json_strict(self, prompt: str, *, schema: Optional[Dict[str, Any]] = None, system_prompt: Optional[str] = None) -> Any:
        if not self.is_available:
            raise LLMResponseError("OpenAI provider is not configured.")

        last_exc: Optional[Exception] = None
        for attempt in range(self.max_retries + 1):
            try:
                response = self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": (system_prompt or "Return valid JSON only. Do not add commentary.")},
                        {"role": "user", "content": prompt},
                    ],
                    response_format={"type": "json_object"},
                    temperature=0.2,
                    timeout=self.timeout,
                )
                content = response.choices[0].message.content
                payload = self._load_json_content(content)
                return self._validate_json_payload(payload, schema=schema)
            except Exception as exc:
                last_exc = exc
                if attempt >= self.max_retries:
                    break
                time.sleep(0.5 * (attempt + 1))
        raise LLMResponseError("Provider response validation failed.") from last_exc


class OllamaLLMProvider(BaseLLMProvider):
    name = "ollama"
    mode = "provider"

    def __init__(self, *, base_url: str, model: str, timeout: float, max_retries: int) -> None:
        super().__init__(provider_name="ollama", model=model, timeout=timeout, max_retries=max_retries)
        self.base_url = base_url.rstrip("/")
        self.client = httpx.Client(timeout=timeout)

    @property
    def is_local(self) -> bool:
        try:
            return urlsplit(self.base_url).hostname in {"localhost", "127.0.0.1", "::1"}
        except ValueError:
            return False

    def close(self) -> None:
        self.client.close()

    @property
    def is_available(self) -> bool:
        try:
            response = self.client.get(f"{self.base_url}/api/tags", timeout=self.timeout)
            return response.status_code == 200
        except httpx.HTTPError:
            return False

    def model_status(self) -> dict[str, Any]:
        try:
            response = self.client.get(f"{self.base_url}/api/tags", timeout=self.timeout)
        except httpx.HTTPError as exc:
            logger.warning("Ollama model-list check failed (%s).", type(exc).__name__)
            return {
                "service_reachable": False,
                "model_available": False,
                "mode": "ollama_unavailable",
                "error_code": "ollama_unavailable",
            }

        if response.status_code != 200:
            logger.warning("Ollama model-list check returned HTTP %s.", response.status_code)
            return {
                "service_reachable": False,
                "model_available": False,
                "mode": "ollama_unavailable",
                "error_code": "ollama_unavailable",
            }

        try:
            body = response.json()
        except ValueError:
            logger.warning("Ollama model-list check returned malformed JSON.")
            return {
                "service_reachable": True,
                "model_available": False,
                "mode": "inference_failed",
                "error_code": "invalid_status_response",
            }

        models = body.get("models") if isinstance(body, dict) else None
        if not isinstance(models, list):
            logger.warning("Ollama model-list check returned an invalid payload.")
            return {
                "service_reachable": True,
                "model_available": False,
                "mode": "inference_failed",
                "error_code": "invalid_status_response",
            }

        model_available = any(
            isinstance(item, dict)
            and self.model in {item.get("name"), item.get("model")}
            for item in models
        )
        return {
            "service_reachable": True,
            "model_available": model_available,
            "mode": "provider" if model_available else "model_missing",
            "error_code": None if model_available else "model_missing",
        }

    def inference_status(self) -> dict[str, Any]:
        result = self.model_status()
        result["inference_verified"] = False
        if not result["service_reachable"] or not result["model_available"]:
            result["connected"] = False
            return result

        payload = {
            "model": self.model,
            "messages": [
                {"role": "user", "content": "Reply with exactly: OLLAMA_STATUS_OK"}
            ],
            "stream": False,
            "options": {"temperature": 0, "num_predict": 12},
        }
        try:
            response = self.client.post(
                f"{self.base_url}/api/chat",
                json=payload,
                timeout=self.timeout,
            )
        except httpx.TimeoutException:
            logger.warning("Ollama inference status check timed out.")
            result.update(mode="inference_failed", error_code="inference_timeout", connected=False)
            return result
        except httpx.HTTPError as exc:
            logger.warning("Ollama inference status check failed (%s).", type(exc).__name__)
            result.update(mode="inference_failed", error_code="inference_failed", connected=False)
            return result

        if response.status_code == 404:
            logger.warning("Ollama inference status check reported a missing model.")
            result.update(
                mode="model_missing",
                model_available=False,
                error_code="model_missing",
                connected=False,
            )
            return result
        if response.status_code >= 400:
            logger.warning("Ollama inference status check returned HTTP %s.", response.status_code)
            result.update(mode="inference_failed", error_code="inference_failed", connected=False)
            return result

        try:
            body = response.json()
        except ValueError:
            logger.warning("Ollama inference status check returned malformed JSON.")
            result.update(mode="inference_failed", error_code="invalid_inference_response", connected=False)
            return result

        error_message = body.get("error") if isinstance(body, dict) else None
        if isinstance(error_message, str) and error_message.strip():
            if "model" in error_message.casefold() and "not found" in error_message.casefold():
                logger.warning("Ollama inference status check reported a missing model.")
                result.update(
                    mode="model_missing",
                    model_available=False,
                    error_code="model_missing",
                    connected=False,
                )
                return result
            logger.warning("Ollama inference status check returned an error response.")
            result.update(mode="inference_failed", error_code="inference_failed", connected=False)
            return result

        message = body.get("message") if isinstance(body, dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        response_model = body.get("model") if isinstance(body, dict) else None
        if (
            not isinstance(content, str)
            or not content.strip()
            or body.get("done") is not True
            or response_model != self.model
        ):
            logger.warning("Ollama inference status check returned an empty or invalid response.")
            result.update(mode="inference_failed", error_code="invalid_inference_response", connected=False)
            return result

        result.update(
            mode="real_ai",
            error_code=None,
            inference_verified=True,
            connected=True,
        )
        return result

    def _request_chat(
        self,
        *,
        messages: list[dict[str, str]],
        format_json: bool | Dict[str, Any] = False,
        max_retries: int | None = None,
    ) -> str:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "stream": False,
        }
        if format_json:
            payload["format"] = format_json if isinstance(format_json, dict) else "json"

        retry_limit = self.max_retries if max_retries is None else max_retries
        for attempt in range(retry_limit + 1):
            try:
                response = self.client.post(f"{self.base_url}/api/chat", json=payload)
                if response.status_code == 404:
                    raise LLMModelNotFoundError(f"Ollama model '{self.model}' was not found.")
                if response.status_code >= 400:
                    raise LLMInferenceError(f"Ollama request failed with status {response.status_code}.")
                body = response.json()
                if not isinstance(body, dict):
                    raise LLMInferenceError("Ollama returned an invalid response.")
                if body.get("error"):
                    error_message = str(body["error"]).casefold()
                    if "model" in error_message and "not found" in error_message:
                        raise LLMModelNotFoundError(f"Ollama model '{self.model}' was not found.")
                    raise LLMInferenceError("Ollama returned an inference error.")
                message = body.get("message")
                content = message.get("content") if isinstance(message, dict) else None
                if not isinstance(content, str) or not content.strip():
                    raise LLMInferenceError("Ollama returned empty or invalid content.")
                return content
            except (LLMResponseError, httpx.HTTPError, ValueError) as exc:
                if attempt >= retry_limit:
                    logger.warning("Ollama chat request failed (%s).", type(exc).__name__)
                    raise
                time.sleep(0.5 * (attempt + 1))
        raise LLMResponseError("Ollama request failed after retries.")

    def chat(self, messages: list[dict[str, str]]) -> str:
        if not messages or any(
            item.get("role") not in {"system", "user", "assistant"}
            or not isinstance(item.get("content"), str)
            or not item["content"].strip()
            for item in messages
        ):
            raise LLMResponseError("Ollama chat messages are invalid.")
        return self._request_chat(messages=messages, max_retries=0)

    def generate_text(self, prompt: str, *, fallback: str, system_prompt: Optional[str] = None) -> str:
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})
        return self._request_chat(messages=messages, format_json=False)

    def generate_json(self, prompt: str, *, fallback: Any, schema: Optional[Dict[str, Any]] = None, system_prompt: Optional[str] = None) -> Any:
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})
        content = self._request_chat(messages=messages, format_json=True)
        payload = self._load_json_content(content)
        return self._validate_json_payload(payload, schema=schema)

    def generate_json_strict(
        self,
        prompt: str,
        *,
        schema: Optional[Dict[str, Any]] = None,
        system_prompt: Optional[str] = None,
    ) -> Any:
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})
        content = self._request_chat(messages=messages, format_json=schema or True)
        payload = self._load_json_content(content)
        return self._validate_json_payload(payload, schema=schema)


def get_llm_provider() -> BaseLLMProvider:
    settings = get_settings()
    provider_name = (settings.llm_provider or "ollama").lower()
    model = settings.ollama_model if provider_name == "ollama" else (settings.llm_model or "gpt-4o-mini")
    timeout = float(settings.llm_timeout_seconds or 30.0)
    max_retries = int(settings.llm_max_retries or 2)

    if provider_name == "demo":
        return DemoLLMProvider(provider_name=provider_name, model=model, timeout=timeout, max_retries=max_retries)

    if provider_name == "ollama":
        base_url = settings.ollama_base_url or os.getenv("OLLAMA_BASE_URL") or "http://localhost:11434"
        ollama_timeout = settings.ollama_timeout_ms / 1000
        return OllamaLLMProvider(
            base_url=base_url,
            model=settings.ollama_model or model,
            timeout=ollama_timeout,
            max_retries=max_retries,
        )

    if provider_name in {"openai", "azure_openai", "provider"}:
        api_key = settings.openai_api_key or os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise LLMResponseError(
                "The configured hosted provider has no credentials; demo mode was not enabled."
            )
        return OpenAILLMProvider(
            api_key=api_key,
            model=model,
            timeout=timeout,
            max_retries=max_retries,
            base_url=(settings.openai_base_url or os.getenv("OPENAI_BASE_URL")),
        )

    raise LLMResponseError(
        f"Unsupported AI provider '{provider_name}'. Configure Ollama or explicitly enable demo mode."
    )
