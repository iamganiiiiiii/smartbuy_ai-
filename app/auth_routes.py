import re
import secrets
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator

from app import db, email
from app.auth import get_current_user, hash_password, hash_token, issue_token, verify_password
from app.billing import cancel_subscription_for_user
from app.config import settings

router = APIRouter(prefix="/api/auth")

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_RESET_TOKEN_TTL_SECONDS = 3600


def _valid_password(v: str) -> str:
    if len(v) < 8:
        raise ValueError("Password must be at least 8 characters")
    return v


class SignupRequest(BaseModel):
    email: str
    password: str

    @field_validator("email")
    @classmethod
    def _valid_email(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("Enter a valid email address")
        return v

    @field_validator("password")
    @classmethod
    def _password(cls, v: str) -> str:
        return _valid_password(v)


class LoginRequest(BaseModel):
    email: str
    password: str


class ForgotPasswordRequest(BaseModel):
    email: str


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def _password(cls, v: str) -> str:
        return _valid_password(v)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def _password(cls, v: str) -> str:
        return _valid_password(v)


@router.post("/signup")
async def signup(req: SignupRequest):
    if db.get_user_by_email(req.email) is not None:
        raise HTTPException(409, "An account with this email already exists")

    user_id = db.create_user(req.email, hash_password(req.password))
    token = issue_token(user_id)
    await email.send_welcome_email(req.email)
    return {"token": token}


@router.post("/login")
def login(req: LoginRequest):
    user = db.get_user_by_email(req.email.strip().lower())
    if user is None or not verify_password(req.password, user["password_hash"]):
        raise HTTPException(401, "Invalid email or password")

    token = issue_token(user["id"])
    return {"token": token}


@router.get("/me")
def me(user=Depends(get_current_user)):
    current_end = user["subscription_current_end"]
    return {
        "email": user["email"],
        "member_since": user["created_at"],
        "trial_searches_used": user["trial_searches_used"],
        "free_trial_limit": settings.free_trial_limit,
        "subscription_status": user["subscription_status"],
        "subscription_renews_at": datetime.fromtimestamp(current_end, tz=timezone.utc).isoformat() if current_end else None,
        "price_label": settings.subscription_price_label,
    }


@router.post("/logout")
def logout(user=Depends(get_current_user)):
    db.clear_auth_token(user["id"])
    return {"ok": True}


@router.post("/forgot-password")
async def forgot_password(req: ForgotPasswordRequest):
    user = db.get_user_by_email(req.email.strip().lower())
    # Always return the same response whether or not the email is registered -
    # otherwise this endpoint becomes a way to check who has an account.
    if user is not None:
        raw_token = secrets.token_urlsafe(32)
        db.set_reset_token(user["id"], hash_token(raw_token), int(time.time()) + _RESET_TOKEN_TTL_SECONDS)
        reset_url = f"{settings.frontend_url}?reset_token={raw_token}"
        await email.send_password_reset_email(user["email"], reset_url)
    return {"ok": True}


@router.post("/reset-password")
def reset_password(req: ResetPasswordRequest):
    user = db.get_user_by_reset_token_hash(hash_token(req.token))
    if user is None or not user["reset_token_expires_at"] or user["reset_token_expires_at"] < time.time():
        raise HTTPException(400, "This reset link is invalid or has expired")

    db.consume_reset_token(user["id"], hash_password(req.new_password))
    return {"ok": True}


@router.post("/change-password")
def change_password(req: ChangePasswordRequest, user=Depends(get_current_user)):
    if not verify_password(req.current_password, user["password_hash"]):
        raise HTTPException(401, "Current password is incorrect")
    db.update_password(user["id"], hash_password(req.new_password))
    return {"ok": True}


@router.delete("/account")
async def delete_account(user=Depends(get_current_user)):
    await cancel_subscription_for_user(user)
    db.delete_user(user["id"])
    return {"ok": True}
