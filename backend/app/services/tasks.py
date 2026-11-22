"""Repair task lifecycle with object level authorisation."""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.responses import ApiError
from app.core.types import utcnow
from app.models.identity import User
from app.models.infrastructure import InfrastructureAsset
from app.models.operations import (
    TASK_TRANSITIONS,
    Incident,
    RepairTask,
    ReservationStatus,
    ResourceReservation,
    TaskStatus,
    TaskStatusHistory,
)
from app.schemas.operations import TaskCreate, TaskTransition
from app.services import notifications as notify

OPEN_STATES = (
    TaskStatus.PENDING,
    TaskStatus.ASSIGNED,
    TaskStatus.ACCEPTED,
    TaskStatus.IN_PROGRESS,
    TaskStatus.COMPLETED,
)


def next_task_code(db: Session) -> str:
    rows = db.scalars(select(RepairTask.code)).all()
    highest = 1000
    for code in rows:
        try:
            highest = max(highest, int(code.split("-")[-1]))
        except ValueError:
            continue
    return f"TASK-{highest + 1}"


def create_task(db: Session, payload: TaskCreate, *, actor_id: int | None) -> RepairTask:
    asset = db.get(InfrastructureAsset, payload.asset_id)
    if asset is None or asset.is_archived:
        raise ApiError("The selected asset does not exist.", status_code=422, code="invalid_asset")
    if payload.incident_id:
        incident = db.get(Incident, payload.incident_id)
        if incident is None:
            raise ApiError("The referenced incident does not exist.", status_code=422, code="invalid_incident")
        if incident.status in ("resolved", "cancelled"):
            raise ApiError(
                "Closed incidents cannot receive new repair tasks.",
                status_code=409,
                code="incident_closed",
            )
    if payload.assignee_id:
        _assert_assignable(db, payload.assignee_id)
    task = RepairTask(
        code=next_task_code(db),
        title=payload.title.strip(),
        description=payload.description,
        status=TaskStatus.ASSIGNED if payload.assignee_id else TaskStatus.PENDING,
        priority=payload.priority,
        incident_id=payload.incident_id,
        asset_id=payload.asset_id,
        assignee_id=payload.assignee_id,
        created_by_id=actor_id,
        estimated_hours=payload.estimated_hours,
        due_at=payload.due_at or utcnow() + timedelta(hours=payload.estimated_hours * 2),
        assigned_at=utcnow() if payload.assignee_id else None,
    )
    db.add(task)
    db.flush()
    _history(db, task, None, task.status, "Task created", actor_id)
    if payload.assignee_id:
        _notify_assignee(db, task)
    db.flush()
    return task


def _assert_assignable(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise ApiError("Assignee not found or inactive.", status_code=422, code="invalid_assignee")
    if "field_engineer" not in user.role_keys:
        raise ApiError(
            "Repair tasks can only be assigned to a field engineer.",
            status_code=422,
            code="invalid_assignee_role",
        )
    return user


def _history(
    db: Session,
    task: RepairTask,
    from_status: str | None,
    to_status: str,
    note: str,
    actor_id: int | None,
) -> None:
    db.add(
        TaskStatusHistory(
            task_id=task.id,
            from_status=from_status,
            to_status=to_status,
            note=note[:400],
            actor_id=actor_id,
            changed_at=utcnow(),
        )
    )


def _notify_assignee(db: Session, task: RepairTask) -> None:
    if not task.assignee_id:
        return
    notify.push(
        db,
        user_id=task.assignee_id,
        title=f"New task {task.code} assigned",
        body=f"{task.title} — priority P{task.priority}.",
        category="task",
        severity="warning" if task.priority <= 2 else "info",
        link="/my-tasks",
        entity_type="task",
        entity_id=task.id,
    )


def list_tasks(
    db: Session,
    *,
    search: str | None = None,
    status: str | None = None,
    assignee_id: int | None = None,
    incident_id: int | None = None,
    asset_id: int | None = None,
    unassigned: bool = False,
    only_open: bool = False,
    sort: str = "created_at",
    direction: str = "desc",
    offset: int = 0,
    limit: int = 20,
) -> tuple[list[RepairTask], int]:
    stmt = select(RepairTask)
    count_stmt = select(func.count()).select_from(RepairTask)
    filters = []
    if search:
        needle = f"%{search.lower()}%"
        filters.append(
            or_(
                func.lower(RepairTask.title).like(needle),
                func.lower(RepairTask.code).like(needle),
            )
        )
    if status:
        filters.append(RepairTask.status == status)
    if assignee_id:
        filters.append(RepairTask.assignee_id == assignee_id)
    if incident_id:
        filters.append(RepairTask.incident_id == incident_id)
    if asset_id:
        filters.append(RepairTask.asset_id == asset_id)
    if unassigned:
        filters.append(RepairTask.assignee_id.is_(None))
    if only_open:
        filters.append(RepairTask.status.in_(OPEN_STATES))
    for f in filters:
        stmt = stmt.where(f)
        count_stmt = count_stmt.where(f)
    columns = {
        "created_at": RepairTask.created_at,
        "priority": RepairTask.priority,
        "status": RepairTask.status,
        "due_at": RepairTask.due_at,
        "code": RepairTask.code,
    }
    col = columns.get(sort, RepairTask.created_at)
    stmt = stmt.order_by(col.desc() if direction == "desc" else col.asc())
    total = db.scalar(count_stmt) or 0
    return list(db.scalars(stmt.offset(offset).limit(limit)).all()), total


def get_task(db: Session, task_id: int) -> RepairTask:
    task = db.get(RepairTask, task_id)
    if task is None:
        raise ApiError("Repair task not found.", status_code=404, code="not_found")
    return task


def assert_task_access(task: RepairTask, user: User) -> None:
    """Object level authorisation for engineers.

    Engineers may only see/act on tasks assigned to them. Other roles with
    ``task:read`` may see every task; ``task:write`` is enforced separately.
    """
    permissions = user.permission_keys
    if "task:write" in permissions or "task:verify" in permissions:
        return
    if "task:execute" in permissions and task.assignee_id == user.id:
        return
    raise ApiError(
        "You can only access repair tasks assigned to you.",
        status_code=403,
        code="task_not_owned",
    )


def assign(db: Session, task: RepairTask, assignee_id: int, *, actor_id: int | None, note: str | None) -> RepairTask:
    if task.status not in (TaskStatus.PENDING, TaskStatus.REJECTED):
        raise ApiError(
            f"Task {task.code} is {task.status} and cannot be reassigned.",
            status_code=409,
            code="invalid_transition",
        )
    _assert_assignable(db, assignee_id)
    previous = task.status
    task.assignee_id = assignee_id
    task.status = TaskStatus.ASSIGNED
    task.assigned_at = utcnow()
    task.rejection_reason = None
    _history(db, task, previous, TaskStatus.ASSIGNED, note or "Assigned by dispatcher", actor_id)
    _notify_assignee(db, task)
    db.flush()
    return task


def transition(
    db: Session,
    task: RepairTask,
    payload: TaskTransition,
    *,
    actor: User,
) -> RepairTask:
    target = payload.status.value if isinstance(payload.status, TaskStatus) else payload.status
    current = task.status
    permissions = actor.permission_keys
    is_assignee = task.assignee_id == actor.id

    if target == current:
        raise ApiError(f"Task is already {current}.", status_code=409, code="no_status_change")
    allowed = TASK_TRANSITIONS.get(current, set())
    if target not in allowed:
        raise ApiError(
            f"Cannot move a task from {current.replace('_', ' ')} to {target.replace('_', ' ')}.",
            status_code=409,
            code="invalid_transition",
            details={"allowed": sorted(allowed)},
        )

    # role/resource gates
    engineer_actions = {
        TaskStatus.ACCEPTED,
        TaskStatus.REJECTED,
        TaskStatus.IN_PROGRESS,
        TaskStatus.COMPLETED,
    }
    if target in engineer_actions:
        if not is_assignee:
            raise ApiError(
                "Only the assigned engineer can accept, progress or complete this task.",
                status_code=403,
                code="task_not_owned",
            )
        if "task:execute" not in permissions:
            raise ApiError("Your role cannot execute repair tasks.", status_code=403, code="forbidden")
        if target == TaskStatus.REJECTED and not (payload.rejection_reason or "").strip():
            raise ApiError(
                "A reason is required when rejecting an assignment.",
                status_code=422,
                code="reason_required",
            )
    if target == TaskStatus.VERIFIED:
        if "task:verify" not in permissions:
            raise ApiError(
                "Only an operator can verify completed work.", status_code=403, code="forbidden"
            )
        if current != TaskStatus.COMPLETED:
            raise ApiError(
                "Only completed work can be verified.", status_code=409, code="invalid_transition"
            )
    if target == TaskStatus.CANCELLED and "task:write" not in permissions:
        raise ApiError("Your role cannot cancel tasks.", status_code=403, code="forbidden")
    if target == TaskStatus.ASSIGNED and "task:write" not in permissions:
        raise ApiError("Your role cannot assign tasks.", status_code=403, code="forbidden")

    now = utcnow()
    task.status = target
    if target == TaskStatus.ACCEPTED:
        task.accepted_at = now
    elif target == TaskStatus.REJECTED:
        task.rejection_reason = (payload.rejection_reason or "")[:400]
        task.assignee_id = None
        task.assigned_at = None
    elif target == TaskStatus.IN_PROGRESS:
        task.started_at = now
    elif target == TaskStatus.COMPLETED:
        task.completed_at = now
        task.completion_notes = payload.note or task.completion_notes
        if payload.actual_hours is not None:
            task.actual_hours = payload.actual_hours
    elif target == TaskStatus.VERIFIED:
        task.verified_at = now
        task.verification_by_id = actor.id
        _consume_reservations(db, task)
    elif target == TaskStatus.CANCELLED:
        _release_reservations(db, task, reason=f"Task {task.code} cancelled")
    _history(db, task, current, target, payload.note or "", actor.id)
    task.updated_at = now

    _notify_task_progress(db, task, current, target)
    _sync_workflow_after_transition(db, task, current=current, target=target, actor_id=actor.id)
    db.flush()
    return task


def _sync_workflow_after_transition(
    db: Session,
    task: RepairTask,
    *,
    current: str,
    target: str,
    actor_id: int | None,
) -> None:
    """Advance the incident's recovery workflow when a field step completes.

    This is what joins the field workspace to the orchestration layer: the first
    acceptance records ``engineer_accepted``, and verifying the last open task
    records ``repair_verified`` and then lets the workflow resolve the incident.
    Signals are idempotent, so replaying one is harmless.
    """
    from app.models.workflow import WorkflowInstance
    from app.workflows.engine import sync_workflow_step

    if task.incident_id is None:
        return
    if target == TaskStatus.ACCEPTED:
        sync_workflow_step(
            db, incident_id=task.incident_id, step="engineer_accepted", actor_id=actor_id
        )
    if target != TaskStatus.VERIFIED:
        return
    # The session runs with autoflush disabled, so the row just changed above is
    # still dirty: without this flush the count below sees the task as open and
    # the workflow never learns that the field work is finished.
    db.flush()
    open_tasks = db.scalar(
        select(func.count())
        .select_from(RepairTask)
        .where(
            RepairTask.incident_id == task.incident_id,
            RepairTask.status.notin_([TaskStatus.VERIFIED, TaskStatus.CANCELLED]),
        )
    )
    if open_tasks:
        return
    sync_workflow_step(
        db, incident_id=task.incident_id, step="repair_verified", actor_id=actor_id
    )
    # Between dispatch and the last verification the workflow is parked at
    # "awaiting_field", not "running"; only a terminal or failed workflow means
    # this incident has nothing left to advance.
    workflow = db.scalar(
        select(WorkflowInstance).where(
            WorkflowInstance.incident_id == task.incident_id,
            WorkflowInstance.status.in_(["running", "awaiting_field"]),
        )
    )
    if workflow is None:
        return
    from app.workflows import engine as workflow_engine

    try:
        workflow_engine.advance_workflow(
            db,
            workflow_id=workflow.id,
            step="incident_resolved",
            actor_id=actor_id,
            payload={"note": f"All repair tasks verified (last: {task.code})."},
        )
    except ApiError:
        # Resolution still requires an operator; the workflow stays parked with
        # the verified state recorded rather than claiming success.
        workflow.status = "awaiting_field"


def _notify_task_progress(db: Session, task: RepairTask, previous: str, target: str) -> None:
    title = f"{task.code} {target.replace('_', ' ')}"
    body = task.title
    if target == TaskStatus.REJECTED:
        body = f"{task.title} — rejected: {task.rejection_reason}"
    notify.push_to_roles(
        db,
        ["city_operator", "super_admin"],
        title=title,
        body=body,
        category="task",
        severity="warning" if target == TaskStatus.REJECTED else "info",
        link=f"/tasks/{task.id}",
        entity_type="task",
        entity_id=task.id,
    )
    if task.assignee_id and target == TaskStatus.VERIFIED:
        notify.push(
            db,
            user_id=task.assignee_id,
            title=f"{task.code} verified",
            body="Your repair was verified by operations. Thank you.",
            category="task",
            severity="success",
            link="/my-tasks",
            entity_type="task",
            entity_id=task.id,
        )


def _consume_reservations(db: Session, task: RepairTask) -> None:
    rows = db.scalars(
        select(ResourceReservation).where(
            ResourceReservation.repair_task_id == task.id,
            ResourceReservation.status == ReservationStatus.RESERVED,
        )
    ).all()
    for row in rows:
        row.status = ReservationStatus.CONSUMED
        row.released_at = utcnow()
        row.release_reason = "Consumed by completed repair"


def _release_reservations(db: Session, task: RepairTask, *, reason: str) -> None:
    rows = db.scalars(
        select(ResourceReservation).where(
            ResourceReservation.repair_task_id == task.id,
            ResourceReservation.status == ReservationStatus.RESERVED,
        )
    ).all()
    for row in rows:
        row.status = ReservationStatus.RELEASED
        row.released_at = utcnow()
        row.release_reason = reason[:240]


def task_to_dict(db: Session, task: RepairTask, *, detail: bool = False) -> dict:
    asset = db.get(InfrastructureAsset, task.asset_id)
    incident = db.get(Incident, task.incident_id) if task.incident_id else None
    assignee = db.get(User, task.assignee_id) if task.assignee_id else None
    reservations = db.scalars(
        select(ResourceReservation).where(ResourceReservation.repair_task_id == task.id)
    ).all()
    base = {
        "id": task.id,
        "code": task.code,
        "title": task.title,
        "description": task.description,
        "status": task.status,
        "priority": task.priority,
        "incident_id": task.incident_id,
        "asset_id": task.asset_id,
        "assignee_id": task.assignee_id,
        "estimated_hours": task.estimated_hours,
        "actual_hours": task.actual_hours,
        "due_at": task.due_at,
        "assigned_at": task.assigned_at,
        "accepted_at": task.accepted_at,
        "started_at": task.started_at,
        "completed_at": task.completed_at,
        "verified_at": task.verified_at,
        "completion_notes": task.completion_notes,
        "rejection_reason": task.rejection_reason,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
        "asset_code": asset.code if asset else None,
        "asset_name": asset.name if asset else None,
        "incident_code": incident.code if incident else None,
        "assignee_name": assignee.full_name if assignee else None,
        "reservations": [
            {
                "id": r.id,
                "resource_id": r.resource_id,
                "repair_task_id": r.repair_task_id,
                "plan_id": r.plan_id,
                "workflow_id": r.workflow_id,
                "quantity": float(r.quantity),
                "status": r.status,
                "reserved_at": r.reserved_at,
                "released_at": r.released_at,
                "release_reason": r.release_reason,
            }
            for r in reservations
        ],
    }
    if detail:
        history = db.scalars(
            select(TaskStatusHistory)
            .where(TaskStatusHistory.task_id == task.id)
            .order_by(TaskStatusHistory.changed_at)
        ).all()
        base["history"] = [
            {
                "id": h.id,
                "from_status": h.from_status,
                "to_status": h.to_status,
                "note": h.note,
                "actor_id": h.actor_id,
                "changed_at": h.changed_at,
            }
            for h in history
        ]
        base["allowed_transitions"] = sorted(TASK_TRANSITIONS.get(task.status, set()))
    return base


def engineer_queue(db: Session, engineer_id: int) -> dict:
    tasks = db.scalars(
        select(RepairTask)
        .where(RepairTask.assignee_id == engineer_id)
        .order_by(RepairTask.priority, RepairTask.created_at.desc())
    ).all()
    counts = {
        "pending_acceptance": 0,
        "in_progress": 0,
        "completed": 0,
        "verified": 0,
    }
    for task in tasks:
        if task.status == TaskStatus.ASSIGNED:
            counts["pending_acceptance"] += 1
        elif task.status in (TaskStatus.ACCEPTED, TaskStatus.IN_PROGRESS):
            counts["in_progress"] += 1
        elif task.status == TaskStatus.COMPLETED:
            counts["completed"] += 1
        elif task.status == TaskStatus.VERIFIED:
            counts["verified"] += 1
    return {"counts": counts, "total": len(tasks)}
