"""User account management (admin + self service)."""
from __future__ import annotations

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.responses import ApiError
from app.core.security import hash_password, verify_password
from app.core.types import utcnow
from app.models.identity import Role, SessionToken, User
from app.schemas.auth import AdminUserCreate, AdminUserUpdate, UpdateProfileRequest


def list_users(
    db: Session,
    *,
    search: str | None = None,
    role: str | None = None,
    is_active: bool | None = None,
    offset: int = 0,
    limit: int = 20,
    sort: str = "full_name",
    direction: str = "asc",
) -> tuple[list[User], int]:
    stmt = select(User)
    count_stmt = select(func.count()).select_from(User)
    filters = []
    if search:
        needle = f"%{search.lower()}%"
        filters.append(
            or_(func.lower(User.full_name).like(needle), func.lower(User.email).like(needle))
        )
    if is_active is not None:
        filters.append(User.is_active.is_(is_active))
    if role:
        stmt = stmt.join(User.roles).where(Role.key == role)
        count_stmt = count_stmt.join(User.roles).where(Role.key == role)
    for f in filters:
        stmt = stmt.where(f)
        count_stmt = count_stmt.where(f)
    columns = {
        "full_name": User.full_name,
        "email": User.email,
        "created_at": User.created_at,
        "last_login_at": User.last_login_at,
    }
    col = columns.get(sort, User.full_name)
    stmt = stmt.order_by(col.desc() if direction == "desc" else col.asc())
    total = db.scalar(count_stmt) or 0
    return list(db.scalars(stmt.offset(offset).limit(limit)).unique().all()), total


def get_user(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise ApiError("User not found.", status_code=404, code="not_found")
    return user


def create_user(db: Session, payload: AdminUserCreate) -> User:
    email = payload.email.lower()
    if db.scalar(select(User).where(func.lower(User.email) == email)):
        raise ApiError("That email address is already registered.", status_code=409, code="duplicate_email")
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
    return user


def update_user(db: Session, user: User, payload: AdminUserUpdate, *, actor: User) -> User:
    data = payload.model_dump(exclude_unset=True)
    role_key = data.pop("role", None)
    if role_key:
        if user.id == actor.id and role_key != user.primary_role:
            raise ApiError(
                "You cannot change your own role.", status_code=409, code="self_role_change"
            )
        role = db.scalar(select(Role).where(Role.key == role_key))
        if role is None:
            raise ApiError("Unknown role.", status_code=422, code="invalid_role")
        _guard_last_super_admin(db, user, new_role=role_key, new_active=data.get("is_active"))
        user.roles = [role]
    if data.get("is_active") is False:
        _guard_last_super_admin(db, user, new_role=None, new_active=False)
        if user.id == actor.id:
            raise ApiError("You cannot deactivate your own account.", status_code=409, code="self_deactivate")
        revoke_sessions(db, user, reason="account deactivated")
    for key, value in data.items():
        if value is None:
            continue
        setattr(user, key, value)
    user.updated_at = utcnow()
    db.flush()
    return user


def _guard_last_super_admin(db: Session, user: User, *, new_role: str | None, new_active: bool | None) -> None:
    if "super_admin" not in user.role_keys:
        return
    will_stay_admin = (new_role in (None, "super_admin")) and (new_active is not False)
    if will_stay_admin:
        return
    remaining = db.scalar(
        select(func.count())
        .select_from(User)
        .join(User.roles)
        .where(Role.key == "super_admin", User.is_active.is_(True), User.id != user.id)
    )
    if not remaining:
        raise ApiError(
            "This is the last active Super Admin. Promote another administrator first.",
            status_code=409,
            code="last_super_admin",
        )


def reset_password(db: Session, user: User, new_password: str) -> None:
    user.password_hash = hash_password(new_password)
    user.updated_at = utcnow()
    revoke_sessions(db, user, reason="password reset by administrator")
    db.flush()


def revoke_sessions(db: Session, user: User, *, reason: str) -> int:
    sessions = db.scalars(
        select(SessionToken).where(SessionToken.user_id == user.id, SessionToken.revoked_at.is_(None))
    ).all()
    for session in sessions:
        session.revoked_at = utcnow()
    return len(sessions)


def update_profile(db: Session, user: User, payload: UpdateProfileRequest) -> User:
    for key, value in payload.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(user, key, value)
    user.updated_at = utcnow()
    db.flush()
    return user


def change_password(db: Session, user: User, current: str, new: str, *, keep_session_id: str | None) -> None:
    if not verify_password(current, user.password_hash):
        raise ApiError(
            "Your current password is incorrect.", status_code=422, code="invalid_password"
        )
    if verify_password(new, user.password_hash):
        raise ApiError(
            "The new password must be different from the current one.",
            status_code=422,
            code="password_reused",
        )
    user.password_hash = hash_password(new)
    user.updated_at = utcnow()
    sessions = db.scalars(
        select(SessionToken).where(SessionToken.user_id == user.id, SessionToken.revoked_at.is_(None))
    ).all()
    for session in sessions:
        if session.session_id != keep_session_id:
            session.revoked_at = utcnow()
    db.flush()
