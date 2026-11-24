"""Administration: users, roles, settings, health and demo utilities."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy import func, select

from app.api.deps import CurrentUser, DbSession, Pagination, require_permissions
from app.core.config import settings as app_settings
from app.core.permissions import PERMISSIONS, ROLE_PERMISSIONS, ROLE_LABELS, Role
from app.core.responses import ApiError, ok, paginated
from app.core.types import utcnow
from app.models.identity import Permission, Role as RoleModel, SystemSetting, User
from app.schemas.auth import AdminUserCreate, AdminUserUpdate, PasswordResetAdminRequest
from app.services import audit
from app.services import users as user_service

router = APIRouter(tags=["admin"])


def _user_dict(user: User) -> dict:
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
        "roles": [{"key": r.key, "name": r.name, "description": r.description} for r in user.roles],
        "permissions": sorted(user.permission_keys),
    }


@router.get("/users")
def list_users(
    db: DbSession,
    user: CurrentUser,
    page: Pagination,
    _: None = Depends(require_permissions("user:read")),
    search: str | None = Query(None, max_length=120),
    role: str | None = None,
    is_active: bool | None = None,
    sort: str = "full_name",
    direction: str = Query("asc", pattern="^(asc|desc)$"),
):
    items, total = user_service.list_users(
        db,
        search=search,
        role=role,
        is_active=is_active,
        offset=page.offset,
        limit=page.limit,
        sort=sort,
        direction=direction,
    )
    return paginated(
        [_user_dict(u) for u in items], total=total, page=page.page, page_size=page.page_size
    )


@router.post(
    "/users",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permissions("user:manage"))],
)
def create_user(payload: AdminUserCreate, request: Request, db: DbSession, user: CurrentUser):
    created = user_service.create_user(db, payload)
    audit.record(
        db, action="user.create", actor=user, resource_type="user", resource_id=created.id,
        message=f"Created {created.email} as {payload.role.value}", request=request,
    )
    db.commit()
    return ok(_user_dict(created))


@router.patch("/users/{user_id}", dependencies=[Depends(require_permissions("user:manage"))])
def update_user(
    user_id: int, payload: AdminUserUpdate, request: Request, db: DbSession, user: CurrentUser
):
    target = user_service.get_user(db, user_id)
    before = {"role": target.primary_role, "is_active": target.is_active}
    user_service.update_user(db, target, payload, actor=user)
    audit.record(
        db, action="user.update", actor=user, resource_type="user", resource_id=target.id,
        message=f"Updated {target.email}", metadata={"before": before, "after": payload.model_dump(exclude_unset=True)},
        request=request,
    )
    db.commit()
    return ok(_user_dict(target))


@router.post(
    "/users/{user_id}/reset-password",
    dependencies=[Depends(require_permissions("user:manage"))],
)
def reset_password(
    user_id: int, payload: PasswordResetAdminRequest, request: Request, db: DbSession, user: CurrentUser
):
    target = user_service.get_user(db, user_id)
    user_service.reset_password(db, target, payload.new_password)
    audit.record(
        db, action="user.password_reset", actor=user, resource_type="user", resource_id=target.id,
        message=f"Administrator reset the password for {target.email}", request=request,
    )
    db.commit()
    return ok({"message": f"Password reset for {target.email}. All their sessions were signed out."})


@router.get("/roles")
def roles(db: DbSession, user: CurrentUser, _: None = Depends(require_permissions("user:read"))):
    rows = db.scalars(select(RoleModel).order_by(RoleModel.name)).all()
    counts = dict(
        db.execute(
            select(RoleModel.id, func.count(User.id))
            .join(User.roles, isouter=True)
            .group_by(RoleModel.id)
        ).all()
    )
    return ok(
        [
            {
                "id": r.id,
                "key": r.key,
                "name": r.name,
                "description": r.description,
                "is_system": r.is_system,
                "user_count": counts.get(r.id, 0),
                "permissions": sorted(p.key for p in r.permissions),
            }
            for r in rows
        ]
    )


@router.get("/permissions")
def permissions(user: CurrentUser, _: None = Depends(require_permissions("user:read"))):
    return ok([{"key": k, "description": v} for k, v in sorted(PERMISSIONS.items())])


# Reading settings is user:read-level administration; changing them needs
# settings:manage. Gating the read on the write permission locked out the
# administrator screens that only display them.
@router.get("/settings")
def get_settings(
    db: DbSession, user: CurrentUser, _: None = Depends(require_permissions("user:read"))
):
    rows = db.scalars(select(SystemSetting).order_by(SystemSetting.section, SystemSetting.key)).all()
    return ok(
        [
            {
                "id": s.id, "key": s.key, "value": s.value, "label": s.label,
                "description": s.description, "section": s.section, "value_type": s.value_type,
                "updated_at": s.updated_at,
            }
            for s in rows
        ]
    )


@router.patch("/settings/{key}", dependencies=[Depends(require_permissions("settings:manage"))])
def update_setting(key: str, value: str, request: Request, db: DbSession, user: CurrentUser):
    setting = db.scalar(select(SystemSetting).where(SystemSetting.key == key))
    if setting is None:
        raise ApiError("Unknown setting.", status_code=404, code="not_found")
    if setting.value_type == "number":
        try:
            float(value)
        except ValueError as exc:
            raise ApiError("This setting must be a number.", status_code=422, code="invalid_value") from exc
    if setting.value_type == "boolean" and value.lower() not in ("true", "false"):
        raise ApiError("This setting must be true or false.", status_code=422, code="invalid_value")
    previous = setting.value
    setting.value = value
    setting.updated_at = utcnow()
    setting.updated_by_id = user.id
    audit.record(
        db, action="settings.update", actor=user, resource_type="system_setting", resource_id=key,
        message=f"{key}: {previous} → {value}", request=request,
    )
    db.commit()
    return ok({"key": setting.key, "value": setting.value})


@router.get("/system/health")
def system_health(db: DbSession):
    db_ok = True
    try:
        db.execute(select(1))
    except Exception:  # pragma: no cover
        db_ok = False
    counts = {}
    for model, name in (
        (User, "users"),
        (__import__("app.models.infrastructure", fromlist=["InfrastructureAsset"]).InfrastructureAsset, "assets"),
        (__import__("app.models.operations", fromlist=["Incident"]).Incident, "incidents"),
        (__import__("app.models.operations", fromlist=["RepairTask"]).RepairTask, "tasks"),
        (__import__("app.models.workflow", fromlist=["WorkflowInstance"]).WorkflowInstance, "workflows"),
    ):
        counts[name] = db.scalar(select(func.count()).select_from(model)) or 0
    return ok(
        {
            "status": "ok" if db_ok else "degraded",
            "database": "connected" if db_ok else "unavailable",
            "environment": app_settings.environment,
            "counts": counts,
            "server_time": utcnow(),
            "version": "1.0.0",
        }
    )


@router.get(
    "/system/demo-info",
    dependencies=[Depends(require_permissions("infrastructure:read"))],
)
def demo_info(db: DbSession, user: CurrentUser):
    from app.models.infrastructure import InfrastructureAsset
    from app.models.operations import Incident, RepairTask, Resource
    from app.models.workflow import WorkflowInstance

    return ok(
        {
            "city": "Aurora Vale (synthetic)",
            "note": "All infrastructure, incidents and people in this application are fictional.",
            "counts": {
                "assets": db.scalar(select(func.count()).select_from(InfrastructureAsset)) or 0,
                "resources": db.scalar(select(func.count()).select_from(Resource)) or 0,
                "incidents": db.scalar(select(func.count()).select_from(Incident)) or 0,
                "tasks": db.scalar(select(func.count()).select_from(RepairTask)) or 0,
                "workflows": db.scalar(select(func.count()).select_from(WorkflowInstance)) or 0,
            },
            "roles": [
                {"key": k, "label": ROLE_LABELS[k], "permissions": sorted(v)}
                for k, v in ROLE_PERMISSIONS.items()
            ],
        }
    )
