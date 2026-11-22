from fastapi import APIRouter, Depends, HTTPException, status

from app.api.routes.dependencies import get_current_user
from app.database.store import get_store
from app.schemas.auth import LoginRequest, RegisterRequest, TokenResponse
from app.security.auth import create_token

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/me")
def get_authenticated_user(current_user: dict = Depends(get_current_user)):
    return current_user


@router.post("/register", response_model=TokenResponse)
def register_user(payload: RegisterRequest):
    store = get_store()
    try:
        user = store.create_user(payload.full_name, payload.email, payload.password, payload.role)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    token = create_token(user["email"], user["role"])
    return {"token": token, "user": user}


@router.post("/login", response_model=TokenResponse)
def login_user(payload: LoginRequest):
    store = get_store()
    try:
        user = store.authenticate(payload.email, payload.password)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    token = create_token(user["email"], user["role"])
    return {"token": token, "user": user}
