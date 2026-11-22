"""Analytics aggregated from stored records — never hardcoded."""
from __future__ import annotations

import csv
import io
import json
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.types import utcnow
from app.models.infrastructure import (
    CATEGORY_LABELS,
    AssetStatus,
    InfrastructureAsset,
    InfrastructureDependency,
)
from app.models.operations import (
    Incident,
    IncidentStatus,
    RepairTask,
    ReservationStatus,
    Resource,
    ResourceReservation,
    TaskStatus,
)
from app.models.optimization import OptimizationPlan
from app.models.simulation import SimulationRun
from app.services.infrastructure import ACTIVE_INCIDENT_STATES


def _since(days: int):
    return utcnow() - timedelta(days=days)


def overview(db: Session, days: int = 30) -> dict:
    assets = db.scalars(
        select(InfrastructureAsset).where(InfrastructureAsset.is_archived.is_(False))
    ).all()
    status_counts = {s.value: 0 for s in AssetStatus}
    for asset in assets:
        status_counts[asset.status] = status_counts.get(asset.status, 0) + 1
    total = max(1, len(assets))
    operational = status_counts.get(AssetStatus.OPERATIONAL, 0)
    health_index = round(100.0 * operational / total, 1)
    avg_load = round(sum(a.load_percent for a in assets) / total, 1)

    incident_counts = {s.value: 0 for s in IncidentStatus}
    for row in db.execute(
        select(Incident.status, func.count()).group_by(Incident.status)
    ).all():
        incident_counts[row[0]] = row[1]
    active_incidents = sum(incident_counts.get(s, 0) for s in ACTIVE_INCIDENT_STATES)

    recent_incidents = (
        db.scalar(
            select(func.count()).select_from(Incident).where(Incident.reported_at >= _since(days))
        )
        or 0
    )
    resolved_recent = (
        db.scalar(
            select(func.count())
            .select_from(Incident)
            .where(Incident.resolved_at.is_not(None), Incident.resolved_at >= _since(days))
        )
        or 0
    )
    open_tasks = (
        db.scalar(
            select(func.count())
            .select_from(RepairTask)
            .where(
                RepairTask.status.in_(
                    [
                        TaskStatus.PENDING,
                        TaskStatus.ASSIGNED,
                        TaskStatus.ACCEPTED,
                        TaskStatus.IN_PROGRESS,
                    ]
                )
            )
        )
        or 0
    )
    completed_tasks = (
        db.scalar(
            select(func.count())
            .select_from(RepairTask)
            .where(RepairTask.status.in_([TaskStatus.COMPLETED, TaskStatus.VERIFIED]))
        )
        or 0
    )
    resource_capacity = float(
        db.scalar(
            select(func.coalesce(func.sum(Resource.capacity), 0)).where(
                Resource.is_archived.is_(False)
            )
        )
        or 0
    )
    reserved = float(
        db.scalar(
            select(func.coalesce(func.sum(ResourceReservation.quantity), 0)).where(
                ResourceReservation.status == ReservationStatus.RESERVED
            )
        )
        or 0
    )
    mttr_rows = db.scalars(
        select(Incident)
        .where(Incident.resolved_at.is_not(None), Incident.reported_at >= _since(days))
        .limit(200)
    ).all()
    mttr_hours = 0.0
    if mttr_rows:
        mttr_hours = round(
            sum((i.resolved_at - i.reported_at).total_seconds() for i in mttr_rows)
            / 3600
            / len(mttr_rows),
            2,
        )
    population_at_risk = sum(
        i.affected_population for i in db.scalars(
            select(Incident).where(Incident.status.in_(ACTIVE_INCIDENT_STATES))
        ).all()
    )
    return {
        "window_days": days,
        "assets_total": len(assets),
        "asset_status_counts": status_counts,
        "health_index": health_index,
        "avg_load_percent": avg_load,
        "active_incidents": active_incidents,
        "incident_status_counts": incident_counts,
        "incidents_reported": recent_incidents,
        "incidents_resolved": resolved_recent,
        "open_tasks": open_tasks,
        "completed_tasks": completed_tasks,
        "resource_capacity": round(resource_capacity, 1),
        "resource_reserved": round(reserved, 1),
        "resource_utilisation_percent": round(100.0 * reserved / resource_capacity, 1)
        if resource_capacity
        else 0.0,
        "mean_time_to_repair_hours": mttr_hours,
        "population_at_risk": population_at_risk,
        "dependencies_total": db.scalar(select(func.count()).select_from(InfrastructureDependency))
        or 0,
        "simulations_total": db.scalar(select(func.count()).select_from(SimulationRun)) or 0,
        "plans_total": db.scalar(select(func.count()).select_from(OptimizationPlan)) or 0,
        "generated_at": utcnow(),
    }


def category_breakdown(db: Session) -> list[dict]:
    rows = db.execute(
        select(
            InfrastructureAsset.category,
            InfrastructureAsset.status,
            func.count(),
        )
        .where(InfrastructureAsset.is_archived.is_(False))
        .group_by(InfrastructureAsset.category, InfrastructureAsset.status)
    ).all()
    by_category: dict[str, dict] = {}
    for category, status, count in rows:
        entry = by_category.setdefault(
            category,
            {
                "category": category,
                "label": CATEGORY_LABELS.get(category, category.replace("_", " ").title()),
                "total": 0,
                "operational": 0,
                "degraded": 0,
                "offline": 0,
                "maintenance": 0,
            },
        )
        entry["total"] += count
        if status in entry:
            entry[status] += count
    out = []
    for entry in by_category.values():
        entry["availability_percent"] = round(100.0 * entry["operational"] / max(1, entry["total"]), 1)
        out.append(entry)
    return sorted(out, key=lambda e: e["total"], reverse=True)


def incident_trends(db: Session, days: int = 30) -> list[dict]:
    from app.services.incidents import timeline_counts

    return timeline_counts(db, days=days)


def severity_breakdown(db: Session, days: int = 90) -> list[dict]:
    rows = db.execute(
        select(Incident.severity, func.count())
        .where(Incident.reported_at >= _since(days))
        .group_by(Incident.severity)
    ).all()
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    data = {severity: count for severity, count in rows}
    return [
        {"severity": sev, "count": data.get(sev, 0)}
        for sev in sorted(order, key=lambda s: order[s])
    ]


def resource_utilisation(db: Session) -> list[dict]:
    from app.services.resources import utilisation_summary

    return utilisation_summary(db)


def simulation_comparison(db: Session, limit: int = 8) -> list[dict]:
    runs = db.scalars(
        select(SimulationRun).order_by(SimulationRun.started_at.desc()).limit(limit)
    ).all()
    out = []
    for run in runs:
        summary = json.loads(run.summary_json or "{}")
        out.append(
            {
                "id": run.id,
                "code": run.code,
                "name": run.name,
                "started_at": run.started_at,
                "severity_index": summary.get("severity_index", 0),
                "assets_failed": summary.get("assets_failed", 0),
                "affected_population": summary.get("affected_population", 0),
                "max_depth_reached": summary.get("max_depth_reached", 0),
                "status": run.status,
            }
        )
    return out


def recovery_performance(db: Session, days: int = 90) -> dict:
    since = _since(days)
    verified = db.scalars(
        select(RepairTask).where(
            RepairTask.status == TaskStatus.VERIFIED, RepairTask.verified_at >= since
        )
    ).all()
    durations = [
        (t.verified_at - t.assigned_at).total_seconds() / 3600
        for t in verified
        if t.verified_at and t.assigned_at
    ]
    by_priority: dict[int, list[float]] = {}
    for task in verified:
        if task.verified_at and task.assigned_at:
            by_priority.setdefault(task.priority, []).append(
                (task.verified_at - task.assigned_at).total_seconds() / 3600
            )
    return {
        "verified_tasks": len(verified),
        "avg_hours_to_verify": round(sum(durations) / len(durations), 2) if durations else 0.0,
        "by_priority": [
            {
                "priority": priority,
                "tasks": len(values),
                "avg_hours": round(sum(values) / len(values), 2),
            }
            for priority, values in sorted(by_priority.items())
        ],
        "on_time_percent": round(
            100.0
            * len([t for t in verified if t.due_at and t.verified_at and t.verified_at <= t.due_at])
            / max(1, len(verified)),
            1,
        ),
    }


def failure_impact_summary(db: Session, limit: int = 5) -> list[dict]:
    runs = db.scalars(
        select(SimulationRun)
        .where(SimulationRun.status == "completed")
        .order_by(SimulationRun.started_at.desc())
        .limit(limit)
    ).all()
    return [
        {
            "code": run.code,
            "name": run.name,
            "summary": json.loads(run.summary_json or "{}"),
            "started_at": run.started_at,
        }
        for run in runs
    ]


def role_appropriate_scope(db: Session, permissions: set[str]) -> dict:
    """Which analytics blocks this role may see."""
    allow = {"overview": True, "categories": True, "incidents": "analytics:read" in permissions}
    return {
        "overview": allow["overview"],
        "categories": allow["categories"],
        "incidents": allow["incidents"],
        "resources": "resource:read" in permissions,
        "simulations": "simulation:read" in permissions,
        "recovery": "task:read" in permissions,
        "export": "analytics:export" in permissions,
    }


def export_csv(kind: str, rows: list[dict]) -> str:
    buffer = io.StringIO()
    if not rows:
        buffer.write("no data\n")
        return buffer.getvalue()
    writer = csv.DictWriter(buffer, fieldnames=list(rows[0].keys()), extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow({k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in row.items()})
    return buffer.getvalue()


def dashboard_bundle(db: Session, permissions: set[str], days: int = 30) -> dict:
    scope = role_appropriate_scope(db, permissions)
    bundle: dict = {
        "overview": overview(db, days),
        "category_breakdown": category_breakdown(db),
        "scope": scope,
        "generated_at": utcnow(),
    }
    if scope["incidents"]:
        bundle["incident_trends"] = incident_trends(db, days)
        bundle["severity_breakdown"] = severity_breakdown(db)
    if scope["resources"]:
        bundle["resource_utilisation"] = resource_utilisation(db)
    if scope["simulations"]:
        bundle["simulation_comparison"] = simulation_comparison(db)
        bundle["failure_impact"] = failure_impact_summary(db)
    if scope["recovery"]:
        bundle["recovery_performance"] = recovery_performance(db)
    active = db.scalars(
        select(Incident)
        .where(Incident.status.in_(ACTIVE_INCIDENT_STATES))
        .order_by(Incident.reported_at.desc())
        .limit(5)
    ).all()
    bundle["active_incident_list"] = [
        {
            "id": i.id,
            "code": i.code,
            "title": i.title,
            "severity": i.severity,
            "status": i.status,
            "reported_at": i.reported_at,
            "affected_population": i.affected_population,
        }
        for i in active
    ]
    return bundle
