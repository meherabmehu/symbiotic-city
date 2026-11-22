"""Analytics, notifications, audit and dashboard endpoints."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy import func, select

from app.api.deps import CurrentUser, DbSession, Pagination, require_permissions
from app.core.responses import ApiError, ok, paginated
from app.core.types import utcnow
from app.models.operations import (
    Incident,
    RepairTask,
    Resource,
    ResourceReservation,
    TaskStatus,
)
from app.models.system import AuditLog, Notification
from app.services import analytics, audit
from app.services.infrastructure import ACTIVE_INCIDENT_STATES
from app.optimization import engine as optimization_engine

router = APIRouter(tags=["analytics"])


@router.get("/dashboard")
def dashboard(db: DbSession, user: CurrentUser, days: int = Query(30, ge=1, le=365)):
    bundle = analytics.dashboard_bundle(db, user.permission_keys, days=days)
    latest_simulation = db.scalars(
        select(__import__("app.models.simulation", fromlist=["SimulationRun"]).SimulationRun)
        .order_by(
            __import__("app.models.simulation", fromlist=["SimulationRun"]).SimulationRun.started_at.desc()
        )
        .limit(1)
    ).first()
    bundle["latest_simulation"] = (
        {
            "id": latest_simulation.id,
            "code": latest_simulation.code,
            "name": latest_simulation.name,
            "status": latest_simulation.status,
            "started_at": latest_simulation.started_at,
            "summary": json.loads(latest_simulation.summary_json or "{}"),
        }
        if latest_simulation
        else None
    )
    pending_plans = db.scalar(
        select(func.count())
        .select_from(__import__("app.models.optimization", fromlist=["OptimizationPlan"]).OptimizationPlan)
        .where(
            __import__("app.models.optimization", fromlist=["OptimizationPlan"]).OptimizationPlan.status
            == "proposed"
        )
    )
    bundle["pending_plan_approvals"] = pending_plans or 0
    pending_tasks = db.scalars(
        select(RepairTask)
        .where(RepairTask.status.in_([TaskStatus.ASSIGNED, TaskStatus.ACCEPTED, TaskStatus.IN_PROGRESS]))
        .order_by(RepairTask.due_at)
        .limit(6)
    ).all()
    bundle["task_board"] = [
        {
            "id": t.id,
            "code": t.code,
            "title": t.title,
            "status": t.status,
            "priority": t.priority,
            "due_at": t.due_at,
            "assignee_id": t.assignee_id,
        }
        for t in pending_tasks
    ]
    res_rows = db.scalars(select(Resource).where(Resource.is_archived.is_(False)).limit(4)).all()
    bundle["resource_spotlight"] = [
        {
            "id": r.id,
            "code": r.code,
            "name": r.name,
            "capacity": float(r.capacity),
            "capacity_unit": r.capacity_unit,
            "status": r.status,
        }
        for r in res_rows
    ]
    bundle["my_open_tasks"] = (
        db.scalar(
            select(func.count())
            .select_from(RepairTask)
            .where(
                RepairTask.assignee_id == user.id,
                RepairTask.status.notin_([TaskStatus.VERIFIED, TaskStatus.CANCELLED]),
            )
        )
        or 0
    )
    bundle["unread_notifications"] = (
        db.scalar(
            select(func.count())
            .select_from(Notification)
            .where(Notification.user_id == user.id, Notification.is_read.is_(False))
        )
        or 0
    )
    return ok(bundle)


@router.get("/analytics/overview")
def overview(
    db: DbSession,
    user: CurrentUser,
    _: None = Depends(require_permissions("analytics:read")),
    days: int = Query(30, ge=1, le=365),
):
    return ok(analytics.overview(db, days))


@router.get("/analytics/categories")
def categories(db: DbSession, user: CurrentUser):
    return ok(analytics.category_breakdown(db))


@router.get("/analytics/incidents")
def incidents_trend(
    db: DbSession,
    user: CurrentUser,
    _: None = Depends(require_permissions("analytics:read")),
    days: int = Query(30, ge=1, le=365),
):
    return ok(
        {
            "trend": analytics.incident_trends(db, days),
            "severity": analytics.severity_breakdown(db),
        }
    )


@router.get("/analytics/resources")
def resource_analytics(db: DbSession, user: CurrentUser):
    return ok(analytics.resource_utilisation(db))


@router.get("/analytics/simulations")
def simulation_analytics(db: DbSession, user: CurrentUser):
    return ok(
        {
            "comparison": analytics.simulation_comparison(db),
            "impact": analytics.failure_impact_summary(db),
        }
    )


@router.get("/analytics/recovery")
def recovery_analytics(
    db: DbSession,
    user: CurrentUser,
    _: None = Depends(require_permissions("task:read")),
    days: int = Query(90, ge=1, le=365),
):
    return ok(analytics.recovery_performance(db, days))


@router.get("/analytics/export")
def export(
    kind: str,
    request: Request,
    db: DbSession,
    user: CurrentUser,
    _: None = Depends(require_permissions("analytics:export")),
    days: int = Query(90, ge=1, le=365),
):
    if kind == "overview":
        rows = [analytics.overview(db, days)]
    elif kind == "categories":
        rows = analytics.category_breakdown(db)
    elif kind == "incidents":
        # Flat rows built in one query: a CSV export must not fan out into a
        # per-incident lookup for assets and task counts.
        rows = [
            {
                "code": i.code,
                "title": i.title,
                "category": i.category,
                "severity": i.severity,
                "status": i.status,
                "affected_population": i.affected_population,
                "reported_at": i.reported_at,
                "resolved_at": i.resolved_at,
                "resolution_notes": i.resolution_notes,
            }
            for i in db.scalars(
                select(Incident).order_by(Incident.reported_at.desc()).limit(500)
            ).all()
        ]
    elif kind == "tasks":
        rows = [
            {
                "code": t.code,
                "title": t.title,
                "status": t.status,
                "priority": t.priority,
                "estimated_hours": t.estimated_hours,
                "actual_hours": t.actual_hours,
                "assigned_at": t.assigned_at,
                "verified_at": t.verified_at,
            }
            for t in db.scalars(select(RepairTask).order_by(RepairTask.created_at.desc())).all()
        ]
    elif kind == "resources":
        rows = analytics.resource_utilisation(db)
    elif kind == "recovery":
        rows = [analytics.recovery_performance(db, days)]
    elif kind == "simulations":
        rows = analytics.simulation_comparison(db, limit=50)
    else:
        raise ApiError(
            "Unknown export type.", status_code=422, code="invalid_export",
            details={"allowed": ["overview", "categories", "incidents", "tasks", "resources", "recovery", "simulations"]},
        )
    body = analytics.export_csv(kind, rows)
    audit.record(
        db, action="analytics.export", actor=user, resource_type="report", resource_id=kind,
        message=f"Exported {kind} report ({len(rows)} rows)", request=request,
    )
    db.commit()
    filename = f"symbiotic-city-{kind}-{utcnow().date().isoformat()}.csv"
    return Response(
        content=body,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --------------------------------------------------------------------------- #
# notifications
# --------------------------------------------------------------------------- #
@router.get("/notifications")
def list_notifications(
    db: DbSession,
    user: CurrentUser,
    page: Pagination,
    unread_only: bool = False,
    category: str | None = None,
):
    stmt = select(Notification).where(Notification.user_id == user.id)
    count_stmt = select(func.count()).select_from(Notification).where(Notification.user_id == user.id)
    if unread_only:
        stmt = stmt.where(Notification.is_read.is_(False))
        count_stmt = count_stmt.where(Notification.is_read.is_(False))
    if category:
        stmt = stmt.where(Notification.category == category)
        count_stmt = count_stmt.where(Notification.category == category)
    total = db.scalar(count_stmt) or 0
    rows = db.scalars(
        stmt.order_by(Notification.created_at.desc()).offset(page.offset).limit(page.limit)
    ).all()
    unread = (
        db.scalar(
            select(func.count())
            .select_from(Notification)
            .where(Notification.user_id == user.id, Notification.is_read.is_(False))
        )
        or 0
    )
    return paginated(
        [
            {
                "id": n.id, "title": n.title, "body": n.body, "category": n.category,
                "severity": n.severity, "link": n.link, "entity_type": n.entity_type,
                "entity_id": n.entity_id, "is_read": n.is_read, "read_at": n.read_at,
                "created_at": n.created_at,
            }
            for n in rows
        ],
        total=total,
        page=page.page,
        page_size=page.page_size,
    ) | {"unread_count": unread}


@router.post("/notifications/{notification_id}/read")
def mark_read(notification_id: int, db: DbSession, user: CurrentUser):
    note = db.get(Notification, notification_id)
    if note is None or note.user_id != user.id:
        raise ApiError("Notification not found.", status_code=404, code="not_found")
    if not note.is_read:
        note.is_read = True
        note.read_at = utcnow()
        db.commit()
    return ok({"id": note.id, "is_read": True})


@router.post("/notifications/read-all")
def mark_all_read(db: DbSession, user: CurrentUser):
    rows = db.scalars(
        select(Notification).where(Notification.user_id == user.id, Notification.is_read.is_(False))
    ).all()
    for note in rows:
        note.is_read = True
        note.read_at = utcnow()
    db.commit()
    return ok({"updated": len(rows)})


# --------------------------------------------------------------------------- #
# audit log
# --------------------------------------------------------------------------- #
@router.get("/audit-logs")
def audit_logs(
    db: DbSession,
    user: CurrentUser,
    page: Pagination,
    _: None = Depends(require_permissions("audit:read")),
    search: str | None = Query(None, max_length=120),
    action: str | None = None,
    outcome: str | None = None,
    actor_id: int | None = None,
):
    stmt = select(AuditLog)
    count_stmt = select(func.count()).select_from(AuditLog)
    if search:
        needle = f"%{search.lower()}%"
        cond = (
            func.lower(AuditLog.actor_email).like(needle)
            | func.lower(AuditLog.action).like(needle)
            | func.lower(AuditLog.message).like(needle)
        )
        stmt = stmt.where(cond)
        count_stmt = count_stmt.where(cond)
    if action:
        stmt = stmt.where(AuditLog.action == action)
        count_stmt = count_stmt.where(AuditLog.action == action)
    if outcome:
        stmt = stmt.where(AuditLog.outcome == outcome)
        count_stmt = count_stmt.where(AuditLog.outcome == outcome)
    if actor_id:
        stmt = stmt.where(AuditLog.actor_id == actor_id)
        count_stmt = count_stmt.where(AuditLog.actor_id == actor_id)
    total = db.scalar(count_stmt) or 0
    rows = db.scalars(
        stmt.order_by(AuditLog.created_at.desc()).offset(page.offset).limit(page.limit)
    ).all()
    return paginated(
        [
            {
                "id": a.id, "actor_id": a.actor_id, "actor_email": a.actor_email,
                "actor_role": a.actor_role, "action": a.action, "resource_type": a.resource_type,
                "resource_id": a.resource_id, "outcome": a.outcome, "message": a.message,
                "metadata": json.loads(a.metadata_json or "{}"), "ip_address": a.ip_address,
                "created_at": a.created_at,
            }
            for a in rows
        ],
        total=total,
        page=page.page,
        page_size=page.page_size,
    )


@router.get("/audit-logs/actions")
def audit_actions(db: DbSession, user: CurrentUser, _: None = Depends(require_permissions("audit:read"))):
    rows = db.execute(select(AuditLog.action, func.count()).group_by(AuditLog.action)).all()
    return ok([{"action": action, "count": count} for action, count in sorted(rows)])


@router.get("/optimization/engine-info")
def engine_info(user: CurrentUser):
    return ok(
        {
            "solver": "Google OR-Tools CP-SAT",
            "priority_weights": optimization_engine.PRIORITY_WEIGHTS,
            "statuses": [
                optimization_engine.OPTIMAL,
                optimization_engine.FEASIBLE,
                optimization_engine.INFEASIBLE,
                optimization_engine.MODEL_INVALID,
            ],
        }
    )
