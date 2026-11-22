"""Authentication, registration, password reset and session endpoints."""
from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import CurrentUser, DbSession, resolve_session
from app.core.config import settings
from app.core.ratelimit import enforce_auth_limit
from app.core.responses import ApiError, ok
from app.core.security import (
    create_session_token,
    new_csrf_token,
    new_session_id,
    new_url_token,
    hash_url_token,
    hash_password,
    session_expiry,
    verify_password,
)
from app.core.types import utcnow
from app.models.identity import PasswordResetToken, Role, SessionToken, User
from app.schemas.auth import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    ForgotPasswordResponse,
    LoginRequest,
    MeResponse,
    RegisterRequest,
    ResetPasswordRequest,
    UpdateProfileRequest,
)
from app.services import audit
from app.services.users import revoke_sessions, update_profile

router = APIRouter(prefix="/auth", tags=["auth"])

GENERIC_RESET_MESSAGE = (
    "If an account exists for that address, a password reset link has been issued."
)


def _set_session_cookies(response: Response, token: str, csrf: str, expires_at) -> None:
    max_age = max(60, int((expires_at - utcnow()).total_seconds()))
    response.set_cookie(
        settings.session_cookie_name,
        token,
        max_age=max_age,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
        domain=settings.cookie_domain or None,
    )
    # readable by JS on purpose: double submit cookie for CSRF
    response.set_cookie(
        settings.csrf_cookie_name,
        csrf,
        max_age=max_age,
        httponly=False,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
        domain=settings.cookie_domain or None,
    )


def _clear_cookies(response: Response) -> None:
    response.delete_cookie(settings.session_cookie_name, path="/")
    response.delete_cookie(settings.csrf_cookie_name, path="/")


def _user_payload(user: User) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "full_name": user.full_name,
        "job_title": user.job_title,
        "phone": user.phone,
        "avatar_color": user.avatar_color,
        "is_active": user.is_active,
        "last_login_at": user.last_login_at,
        "created_at": user.created_at,
        "roles": [
            {"key": r.key, "name": r.name, "description": r.description} for r in user.roles
        ],
    }


@router.post("/register", status_code=status.HTTP_201_CREATED)
def register(
    payload: RegisterRequest,
    request: Request,
    response: Response,
    db: DbSession,
    _: None = Depends(enforce_auth_limit),
):
    email = payload.email.lower()
    if db.scalar(select(User).where(func.lower(User.email) == email)):
        raise ApiError(
            "An account with that email already exists. Try signing in instead.",
            status_code=409,
            code="duplicate_email",
        )
    role = db.scalar(select(Role).where(Role.key == payload.role))
    if role is None:
        raise ApiError("Unknown role.", status_code=422, code="invalid_role")
    user = User(
        email=email,
        full_name=payload.full_name,
        password_hash=hash_password(payload.password),
        job_title=payload.job_title,
        phone=payload.phone,
        roles=[role],
    )
    db.add(user)
    db.flush()
    issue_session(db, request, response, user)
    audit.record(
        db,
        action="auth.register",
        actor=user,
        resource_type="user",
        resource_id=user.id,
        message=f"Registered as {role.name}",
        request=request,
    )
    db.commit()
    return ok({"user": _user_payload(user), "message": "Account created."}, meta={"status": 201})


def issue_session(db: Session, request: Request, response: Response, user: User) -> SessionToken:
    session_id = new_session_id()
    expires_at = session_expiry()
    session = SessionToken(
        session_id=session_id,
        user_id=user.id,
        expires_at=expires_at,
        ip_address=audit.client_ip(request),
        user_agent=(request.headers.get("user-agent") or "")[:255],
    )
    db.add(session)
    token = create_session_token(user_id=user.id, session_id=session_id, expires_at=expires_at)
    _set_session_cookies(response, token, new_csrf_token(), expires_at)
    user.last_login_at = utcnow()
    db.flush()
    return session


@router.post("/login")
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: DbSession,
    _: None = Depends(enforce_auth_limit),
):
    user = db.scalar(select(User).where(func.lower(User.email) == payload.email.lower()))
    if user is None or not verify_password(payload.password, user.password_hash):
        audit.record(
            db,
            action="auth.login",
            outcome="failure",
            resource_type="user",
            message=f"Invalid credentials for {payload.email.lower()}",
            request=request,
            actor_email=payload.email.lower(),
        )
        db.commit()
        raise ApiError(
            "Email or password is incorrect.", status_code=401, code="invalid_credentials"
        )
    if not user.is_active:
        audit.record(
            db,
            action="auth.login",
            actor=user,
            outcome="failure",
            resource_type="user",
            resource_id=user.id,
            message="Inactive account attempted to sign in",
            request=request,
        )
        db.commit()
        raise ApiError(
            "This account has been deactivated. Contact an administrator.",
            status_code=403,
            code="account_inactive",
        )
    issue_session(db, request, response, user)
    audit.record(
        db,
        action="auth.login",
        actor=user,
        resource_type="user",
        resource_id=user.id,
        message=f"Signed in as {user.primary_role}",
        request=request,
    )
    db.commit()
    return ok({"user": _user_payload(user), "permissions": sorted(user.permission_keys)})


@router.post("/logout")
def logout(request: Request, response: Response, db: DbSession):
    resolved = resolve_session(request, db)
    if resolved:
        user, session = resolved
        session.revoked_at = utcnow()
        audit.record(
            db,
            action="auth.logout",
            actor=user,
            resource_type="session",
            resource_id=session.session_id,
            message="Signed out",
            request=request,
        )
        db.commit()
    _clear_cookies(response)
    return ok({"message": "Signed out."})


@router.get("/me")
def me(user: CurrentUser, response: Response):
    csrf = new_csrf_token()
    response.set_cookie(
        settings.csrf_cookie_name,
        csrf,
        max_age=settings.access_token_expire_minutes * 60,
        httponly=False,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
        domain=settings.cookie_domain or None,
    )
    return ok(
        {
            "user": _user_payload(user),
            "permissions": sorted(user.permission_keys),
            "roles": user.role_keys,
        }
    )


@router.post("/forgot-password", response_model=None)
def forgot_password(
    payload: ForgotPasswordRequest,
    request: Request,
    db: DbSession,
    _: None = Depends(enforce_auth_limit),
):
    user = db.scalar(select(User).where(func.lower(User.email) == payload.email.lower()))
    token_out: str | None = None
    if user and user.is_active:
        raw = new_url_token()
        db.add(
            PasswordResetToken(
                user_id=user.id,
                token_hash=hash_url_token(raw),
                expires_at=utcnow() + timedelta(minutes=settings.reset_token_ttl_minutes),
            )
        )
        audit.record(
            db,
            action="auth.password_reset_requested",
            actor=user,
            resource_type="user",
            resource_id=user.id,
            message="Password reset requested",
            request=request,
        )
        # No SMTP in the demo sandbox: outside production the token is returned
        # so the flow is fully exercisable. In production this is email only.
        if not settings.is_production:
            token_out = raw
    db.commit()
    body = {"message": GENERIC_RESET_MESSAGE, "reset_token": token_out}
    return ok(body)


@router.post("/reset-password")
def reset_password(
    payload: ResetPasswordRequest,
    request: Request,
    db: DbSession,
    _: None = Depends(enforce_auth_limit),
):
    token_hash = hash_url_token(payload.token)
    record = db.scalar(
        select(PasswordResetToken).where(PasswordResetToken.token_hash == token_hash)
    )
    if record is None or record.used_at is not None or record.expires_at <= utcnow():
        raise ApiError(
            "This reset link is invalid or has expired. Request a new one.",
            status_code=400,
            code="invalid_reset_token",
        )
    user = db.get(User, record.user_id)
    if user is None or not user.is_active:
        raise ApiError("Account unavailable.", status_code=400, code="invalid_reset_token")
    user.password_hash = hash_password(payload.password)
    record.used_at = utcnow()
    revoked = revoke_sessions(db, user, reason="password reset")
    audit.record(
        db,
        action="auth.password_reset_completed",
        actor=user,
        resource_type="user",
        resource_id=user.id,
        message=f"Password reset completed, {revoked} session(s) revoked",
        request=request,
    )
    db.commit()
    return ok({"message": "Password updated. Please sign in with the new password."})


@router.patch("/profile")
def patch_profile(payload: UpdateProfileRequest, request: Request, db: DbSession, user: CurrentUser):
    update_profile(db, user, payload)
    audit.record(
        db,
        action="profile.update",
        actor=user,
        resource_type="user",
        resource_id=user.id,
        message="Profile updated",
        metadata=payload.model_dump(exclude_unset=True),
        request=request,
    )
    db.commit()
    return ok({"user": _user_payload(user)})


@router.post("/change-password")
def change_password(
    payload: ChangePasswordRequest, request: Request, db: DbSession, user: CurrentUser
):
    from app.services import users as user_service

    resolved = resolve_session(request, db)
    current_session_id = resolved[1].session_id if resolved else None
    user_service.change_password(
        db, user, payload.current_password, payload.new_password, keep_session_id=current_session_id
    )
    audit.record(
        db,
        action="auth.password_changed",
        actor=user,
        resource_type="user",
        resource_id=user.id,
        message="Password changed",
        request=request,
    )
    db.commit()
    return ok({"message": "Password changed. Other sessions were signed out."})


@router.get("/sessions")
def list_sessions(db: DbSession, user: CurrentUser):
    rows = db.scalars(
        select(SessionToken)
        .where(SessionToken.user_id == user.id, SessionToken.revoked_at.is_(None))
        .order_by(SessionToken.issued_at.desc())
    ).all()
    return ok(
        [
            {
                "session_id": row.session_id[:8] + "…",
                "issued_at": row.issued_at,
                "expires_at": row.expires_at,
                "ip_address": row.ip_address,
                "user_agent": row.user_agent,
            }
            for row in rows
        ]
    )


@router.post("/sessions/revoke-all")
def revoke_all(request: Request, db: DbSession, user: CurrentUser):
    count = revoke_sessions(db, user, reason="revoked by user")
    audit.record(
        db,
        action="auth.sessions_revoked",
        actor=user,
        resource_type="user",
        resource_id=user.id,
        message=f"{count} session(s) revoked",
        request=request,
    )
    db.commit()
    return ok({"message": f"{count} session(s) revoked. Please sign in again."})


@router.get("/roles")
def roles(db: DbSession):
    rows = db.scalars(select(Role).order_by(Role.name)).all()
    return ok(
        [
            {
                "key": r.key,
                "name": r.name,
                "description": r.description,
                "permissions": sorted(p.key for p in r.permissions),
            }
            for r in rows
        ]
    )
