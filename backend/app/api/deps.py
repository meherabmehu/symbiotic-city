"""Shared FastAPI dependencies: authentication, authorisation, pagination."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Query, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.responses import ApiError
from app.core.security import decode_session_token
from app.models.identity import SessionToken, User

DbSession = Annotated[Session, Depends(get_db)]


def _unauthenticated(message: str = "Sign in to continue.") -> ApiError:
    return ApiError(message, status_code=status.HTTP_401_UNAUTHORIZED, code="unauthenticated")


def resolve_session(request: Request, db: Session) -> tuple[User, SessionToken] | None:
    """Resolve the httpOnly session cookie into a live user + session row."""
    raw = request.cookies.get(settings.session_cookie_name)
    if not raw:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            raw = auth[7:].strip()
    if not raw:
        return None
    payload = decode_session_token(raw)
    if not payload:
        return None
    session = db.scalar(select(SessionToken).where(SessionToken.session_id == payload.get("sid")))
    if session is None or session.revoked_at is not None:
        return None
    from app.core.types import utcnow

    if session.expires_at <= utcnow():
        return None
    user = db.get(User, int(payload.get("sub", "0")))
    if user is None or not user.is_active:
        return None
    return user, session


def get_current_user(request: Request, db: DbSession) -> User:
    resolved = resolve_session(request, db)
    if resolved is None:
        raise _unauthenticated()
    return resolved[0]


def get_optional_user(request: Request, db: DbSession) -> User | None:
    resolved = resolve_session(request, db)
    return resolved[0] if resolved else None


CurrentUser = Annotated[User, Depends(get_current_user)]
OptionalUser = Annotated[User | None, Depends(get_optional_user)]


def require_permissions(*required: str) -> Callable[..., User]:
    """Dependency factory enforcing that the caller holds every permission."""

    def dependency(user: CurrentUser) -> User:
        held = user.permission_keys
        missing = [p for p in required if p not in held]
        if missing:
            raise ApiError(
                "Your role does not allow this action.",
                status_code=status.HTTP_403_FORBIDDEN,
                code="forbidden",
                details={"missing_permissions": missing},
            )
        return user

    return dependency


def require_any_permission(*required: str) -> Callable[..., User]:
    def dependency(user: CurrentUser) -> User:
        held = user.permission_keys
        if not any(p in held for p in required):
            raise ApiError(
                "Your role does not allow this action.",
                status_code=status.HTTP_403_FORBIDDEN,
                code="forbidden",
                details={"required_any": list(required)},
            )
        return user

    return dependency


def require_roles(*roles: str) -> Callable[..., User]:
    def dependency(user: CurrentUser) -> User:
        if not set(user.role_keys) & set(roles):
            raise ApiError(
                "This area is restricted to other roles.",
                status_code=status.HTTP_403_FORBIDDEN,
                code="forbidden",
                details={"required_roles": list(roles)},
            )
        return user

    return dependency


@dataclass(slots=True)
class PageParams:
    page: int
    page_size: int
    offset: int
    limit: int


def pagination(
    page: int = Query(1, ge=1, le=10_000),
    page_size: int = Query(20, ge=1, le=200),
) -> PageParams:
    return PageParams(page=page, page_size=page_size, offset=(page - 1) * page_size, limit=page_size)


Pagination = Annotated[PageParams, Depends(pagination)]
