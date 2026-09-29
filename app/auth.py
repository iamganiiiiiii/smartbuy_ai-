"""Password hashing and Bearer-token session auth.

Sessions use an opaque random token (not JWT) so revocation is a single DB
write. Only the token's sha256 hash is ever persisted - the raw token is
handed to the client once, at signup/login, and never stored server-side.
"""

import hashlib
import secrets

import bcrypt
from fastapi import Header, HTTPException

from app import db


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))


def hash_token(raw_token: str) -> str:
    """Shared by session tokens and password-reset tokens - same reasoning
    for both: only the hash is ever persisted, the raw value is single-use
    and handed to the client (or embedded in an email link) exactly once."""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def issue_token(user_id: int) -> str:
    raw_token = secrets.token_urlsafe(32)
    db.set_auth_token_hash(user_id, hash_token(raw_token))
    return raw_token


def get_current_user(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Not authenticated")

    raw_token = authorization.removeprefix("Bearer ").strip()
    user = db.get_user_by_token_hash(hash_token(raw_token))
    if user is None:
        raise HTTPException(401, "Invalid or expired session")
    return user
