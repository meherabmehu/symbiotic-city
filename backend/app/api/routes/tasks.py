"""Repair task endpoints, including the field engineer workspace."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, status

from app.api.deps import CurrentUser, DbSession, Pagination, require_permissions
from app.core.responses import ApiError, ok, paginated
from app.models.identity import Role, User
from app.models.operations import TaskStatus
from app.schemas.operations import TaskAssign, TaskCreate, TaskTransition
from app.services import audit
from app.services import tasks as service

router = APIRouter(tags=["tasks"])


@router.get("/tasks")
def list_tasks(
    db: DbSession,
    user: CurrentUser,
    page: Pagination,
    search: str | None = Query(None, max_length=120),
    status_filter: str | None = Query(None, alias="status"),
    assignee_id: int | None = None,
    incident_id: int | None = None,
    asset_id: int | None = None,
    unassigned: bool = False,
    only_open: bool = False,
    sort: str = "created_at",
    direction: str = Query("desc", pattern="^(asc|desc)$"),
):
    permissions = user.permission_keys
    # engineers are hard scoped to their own queue, no matter what they request
    if "task:write" not in permissions and "task:verify" not in permissions:
        assignee_id = user.id
    items, total = service.list_tasks(
        db,
        search=search,
        status=status_filter,
        assignee_id=assignee_id,
        incident_id=incident_id,
        asset_id=asset_id,
        unassigned=unassigned,
        only_open=only_open,
        sort=sort,
        direction=direction,
        offset=page.offset,
        limit=page.limit,
    )
    return paginated(
        [service.task_to_dict(db, t) for t in items],
        total=total,
        page=page.page,
        page_size=page.page_size,
    )


@router.get("/tasks/engineers")
def list_engineers(db: DbSession, user: CurrentUser):
    rows = db.scalars(select_users(db).join(User.roles).where(Role.key == "field_engineer")).unique().all()
    return ok(
        [
            {
                "id": u.id,
                "full_name": u.full_name,
                "email": u.email,
                "job_title": u.job_title,
                "is_active": u.is_active,
            }
            for u in rows
        ]
    )


def select_users(db):
    from sqlalchemy import select

    return select(User)


@router.get("/tasks/my-queue")
def my_queue(db: DbSession, user: CurrentUser):
    if "task:execute" not in user.permission_keys:
        raise ApiError(
            "This workspace is for field engineers.", status_code=403, code="forbidden"
        )
    from sqlalchemy import select

    from app.models.operations import RepairTask

    summary = service.engineer_queue(db, user.id)
    tasks = db.scalars(
        select(RepairTask)
        .where(RepairTask.assignee_id == user.id)
        .order_by(RepairTask.priority, RepairTask.created_at.desc())
    ).all()
    return ok({"summary": summary, "tasks": [service.task_to_dict(db, t) for t in tasks]})


@router.post(
    "/tasks",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permissions("task:write"))],
)
def create_task(payload: TaskCreate, request: Request, db: DbSession, user: CurrentUser):
    task = service.create_task(db, payload, actor_id=user.id)
    audit.record(
        db, action="task.create", actor=user, resource_type="repair_task", resource_id=task.id,
        message=f"{task.code} created for asset {payload.asset_id}", request=request,
    )
    db.commit()
    return ok(service.task_to_dict(db, task, detail=True))


@router.get("/tasks/{task_id}")
def get_task(task_id: int, db: DbSession, user: CurrentUser):
    task = service.get_task(db, task_id)
    service.assert_task_access(task, user)
    return ok(service.task_to_dict(db, task, detail=True))


@router.post("/tasks/{task_id}/assign", dependencies=[Depends(require_permissions("task:write"))])
def assign_task(task_id: int, payload: TaskAssign, request: Request, db: DbSession, user: CurrentUser):
    task = service.get_task(db, task_id)
    service.assign(db, task, payload.assignee_id, actor_id=user.id, note=payload.note)
    audit.record(
        db, action="task.assign", actor=user, resource_type="repair_task", resource_id=task.id,
        message=f"{task.code} assigned to user {payload.assignee_id}", request=request,
    )
    db.commit()
    return ok(service.task_to_dict(db, task, detail=True))


@router.post("/tasks/{task_id}/transition")
def transition_task(
    task_id: int, payload: TaskTransition, request: Request, db: DbSession, user: CurrentUser
):
    task = service.get_task(db, task_id)
    service.assert_task_access(task, user)
    previous = task.status
    service.transition(db, task, payload, actor=user)
    audit.record(
        db, action="task.transition", actor=user, resource_type="repair_task", resource_id=task.id,
        message=f"{task.code}: {previous} → {task.status}",
        metadata={"note": payload.note}, request=request,
    )
    db.commit()
    return ok(service.task_to_dict(db, task, detail=True))
