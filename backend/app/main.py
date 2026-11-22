import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes.ai import router as ai_router
from app.api.routes.allocation import router as allocation_router
from app.api.routes.applications import router as applications_router
from app.api.routes.auth import router as auth_router
from app.api.routes.documents import router as documents_router
from app.api.routes.explore import router as explore_router
from app.api.routes.interviews import router as interviews_router
from app.api.routes.profile import router as profile_router
from app.api.routes.recommendations import eligibility_router, router as recommendations_router
from app.api.routes.university import router as university_router
from app.core.config import DEFAULT_JWT_SECRET_KEY, Settings, get_settings
from app.database.document_storage import get_document_storage
from app.database.store import get_store
from app.middleware import DocumentUploadLimitMiddleware, SecurityHeadersMiddleware

logger = logging.getLogger("uniapply")
settings = get_settings()


def validate_production_settings(runtime_settings: Settings) -> None:
    if runtime_settings.app_env.lower() != "production":
        return
    if getattr(runtime_settings, "storage_backend", "auto") == "demo":
        raise RuntimeError("Demo storage is not allowed in production.")
    if not runtime_settings.mongodb_uri.strip():
        raise RuntimeError("MONGODB_URI is required in production.")
    jwt_secret = runtime_settings.jwt_secret_key.strip()
    if (
        jwt_secret in {"change-me-in-production", DEFAULT_JWT_SECRET_KEY}
        or len(jwt_secret.encode("utf-8")) < 32
    ):
        raise RuntimeError("Production JWT_SECRET_KEY must be configured with at least 32 characters.")
    origins = [origin.strip() for origin in runtime_settings.cors_origins.split(",") if origin.strip()]
    if not origins or "*" in origins:
        raise RuntimeError("Production CORS_ORIGINS must list the frontend origin; wildcard origins are not allowed.")
    normalized_origins = [
        origin if origin.startswith(("http://", "https://")) else f"https://{origin}"
        for origin in origins
    ]
    if any(not origin.startswith("https://") for origin in normalized_origins):
        raise RuntimeError("Production CORS_ORIGINS must use HTTPS.")
    document_storage_dir = getattr(runtime_settings, "document_storage_dir", None)
    if document_storage_dir is None:
        raise RuntimeError("DOCUMENT_STORAGE_DIR is required in production.")
    if not Path(document_storage_dir).is_absolute():
        raise RuntimeError("Production DOCUMENT_STORAGE_DIR must be an absolute path.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    validate_production_settings(settings)
    if settings.app_env == "production":
        get_document_storage().ensure_available()
    store = get_store()
    if store.backend_name == "mongodb":
        logger.info("Storage backend: MongoDB")
    elif settings.storage_backend == "demo":
        logger.info("Storage backend: demo (explicitly configured in-memory store).")
    else:
        logger.warning("Storage backend: demo (in-memory fallback) because MongoDB is unavailable or unconfigured.")
    yield
    if hasattr(store, "close"):
        store.close()


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="AI-native admissions platform for college matching and admission simulation",
    lifespan=lifespan,
)

cors_origins = [
    origin.strip().rstrip("/")
    for origin in settings.cors_origins.split(",")
    if origin.strip()
]
cors_origins = [
    origin if origin == "*" or origin.startswith(("http://", "https://")) else f"https://{origin}"
    for origin in cors_origins
]

app.add_middleware(
    DocumentUploadLimitMiddleware,
    upload_path=f"{settings.api_prefix}/documents/upload",
    max_request_bytes=settings.document_max_bytes + 64 * 1024,
)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get(f"{settings.api_prefix}/health")
def health_check():
    store = get_store()
    if not store.is_healthy:
        return JSONResponse(
            status_code=503,
            content={
                "status": "unavailable",
                "service": settings.app_name,
                "version": settings.app_version,
                "storage_backend": store.backend_name,
            },
        )
    return {
        "status": "ok",
        "service": settings.app_name,
        "version": settings.app_version,
        "storage_backend": store.backend_name,
    }


app.include_router(auth_router, prefix=settings.api_prefix)
app.include_router(ai_router, prefix=settings.api_prefix)
app.include_router(profile_router, prefix=settings.api_prefix)
app.include_router(documents_router, prefix=settings.api_prefix)
app.include_router(explore_router, prefix=settings.api_prefix)
app.include_router(eligibility_router, prefix=settings.api_prefix)
app.include_router(recommendations_router, prefix=settings.api_prefix)
app.include_router(interviews_router, prefix=settings.api_prefix)
app.include_router(allocation_router, prefix=settings.api_prefix)
app.include_router(applications_router, prefix=settings.api_prefix)
app.include_router(university_router, prefix=settings.api_prefix)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
