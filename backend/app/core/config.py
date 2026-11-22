from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


DEFAULT_JWT_SECRET_KEY = "development-only-secret-key-" + ("x" * 32)


class Settings(BaseSettings):
    app_name: str = "UniApply-AI"
    app_version: str = "0.1.0"
    app_env: Literal["development", "production"] = "development"
    api_prefix: str = "/api"
    cors_origins: str = "*"
    storage_backend: Literal["auto", "demo"] = "auto"
    jwt_secret_key: str = DEFAULT_JWT_SECRET_KEY
    jwt_algorithm: str = "HS256"
    mongodb_uri: str = ""
    mongodb_database: str = "uniapply_ai"
    redis_url: str = "redis://localhost:6379/0"
    llm_provider: str = "ollama"
    llm_model: str = "gpt-4o-mini"
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.2:3b"
    ollama_timeout_ms: int = Field(
        default=60000,
        ge=1000,
        le=300000,
        validation_alias="OLLAMA_TIMEOUT",
    )
    openai_api_key: str | None = None
    openai_base_url: str | None = None
    llm_timeout_seconds: float = 30.0
    llm_max_retries: int = 2
    document_storage_dir: Path | None = None
    document_max_bytes: int = Field(default=10 * 1024 * 1024, gt=0, le=100 * 1024 * 1024)
    document_allowed_mime_types: str = "application/pdf,image/jpeg,image/png"

    @field_validator("document_allowed_mime_types")
    @classmethod
    def validate_document_allowed_mime_types(cls, value: str) -> str:
        allowed_types = {"application/pdf", "image/jpeg", "image/png"}
        configured_types = {item.strip().lower() for item in value.split(",") if item.strip()}
        if not configured_types or not configured_types.issubset(allowed_types):
            raise ValueError("DOCUMENT_ALLOWED_MIME_TYPES must contain supported MIME types.")
        return ",".join(sorted(configured_types))

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
