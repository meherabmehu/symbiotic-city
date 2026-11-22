"""Security primitives: password hashing, signed session tokens, CSRF.

Sessions are stateless signed tokens stored in an httpOnly cookie and mirrored
in a *server side* session row so that logout, account deactivation and
password resets can revoke tokens before their natural expiry.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import settings

ALGORITHM = "HS256"
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=12)


# --------------------------------------------------------------------------- #
# passwords
# --------------------------------------------------------------------------- #
def hash_password(password: str) -> str:
    # bcrypt truncates at 72 bytes; pre-hash long inputs so nothing is silently
    # dropped (and to keep the API honest about password length validation).
    return pwd_context.hash(_normalise_password(password))


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return pwd_context.verify(_normalise_password(plain), hashed)
    except ValueError:
        return False


def _normalise_password(password: str) -> str:
    if len(password.encode("utf-8")) > 72:
        return hashlib.sha256(password.encode("utf-8")).hexdigest()
    return password


# --------------------------------------------------------------------------- #
# session tokens
# --------------------------------------------------------------------------- #
def create_session_token(*, user_id: int, session_id: str, expires_at: datetime) -> str:
    payload = {
        "sub": str(user_id),
        "sid": session_id,
        "exp": int(expires_at.timestamp()),
        "iat": int(datetime.now(UTC).timestamp()),
        "typ": "session",
    }
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def decode_session_token(token: str) -> dict[str, Any] | None:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except JWTError:
        return None
    if payload.get("typ") != "session":
        return None
    return payload


def new_session_id() -> str:
    return secrets.token_urlsafe(24)


def session_expiry(minutes: int | None = None) -> datetime:
    return datetime.now(UTC) + timedelta(minutes=minutes or settings.access_token_expire_minutes)


# --------------------------------------------------------------------------- #
# csrf (double submit cookie)
# --------------------------------------------------------------------------- #
def new_csrf_token() -> str:
    return secrets.token_urlsafe(32)


def csrf_matches(cookie_value: str | None, header_value: str | None) -> bool:
    if not cookie_value or not header_value:
        return False
    return hmac.compare_digest(cookie_value, header_value)


# --------------------------------------------------------------------------- #
# one-time tokens (password reset)
# --------------------------------------------------------------------------- #
def new_url_token() -> str:
    return secrets.token_urlsafe(32)


def hash_url_token(token: str) -> str:
    return hashlib.sha256(f"{settings.secret_key}:{token}".encode()).hexdigest()
