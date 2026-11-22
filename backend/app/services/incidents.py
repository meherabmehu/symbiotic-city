"""Incident lifecycle: validated transitions, duplicate prevention, events."""
from __future__ import annotations

import json

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.responses import ApiError
from app.core.types import utcnow
from app.models.infrastructure import InfrastructureAsset
from app.models.operations import (
    INCIDENT_TRANSITIONS,
    Incident,
    IncidentAsset,
    IncidentEvent,
    IncidentStatus,
    RepairTask,
    TaskStatus,
)
from app.schemas.operations import IncidentCreate, IncidentTransition, IncidentUpdate
from app.services import notifications as notify
from app.services.infrastructure import ACTIVE_INCIDENT_STATES

SEVERITY_RANK = {"low": 1, "medium": 2, "high": 3, "critical": 4}


def next_incident_code(db: Session) -> str:
    # Derive from the highest existing numeric suffix so deletions never cause
    # a code collision (unique constraint on incidents.code).
    rows = db.scalars(select(Incident.code)).all()
    highest = 0
    for code in rows:
        try:
            highest = max(highest, int(code.split("-")[-1]))
        except ValueError:
            continue
    return f"INC-{highest + 1:04d}"


def list_incidents(
    db: Session,
    *,
    search: str | None = None,
    status: str | None = None,
    severity: str | None = None,
    asset_id: int | None = None,
    category: str | None = None,
    include_closed: bool = True,
    sort: str = "reported_at",
    direction: str = "desc",
    offset: int = 0,
    limit: int = 20,
) -> tuple[list[Incident], int]:
    stmt = select(Incident)
    count_stmt = select(func.count()).select_from(Incident)
    filters = []
    if search:
        needle = f"%{search.lower()}%"
        filters.append(
            or_(
                func.lower(Incident.title).like(needle),
                func.lower(Incident.code).like(needle),
                func.lower(Incident.description).like(needle),
            )
        )
    if status:
        filters.append(Incident.status == status)
    if severity:
        filters.append(Incident.severity == severity)
    if asset_id:
        filters.append(Incident.primary_asset_id == asset_id)
    if category:
        filters.append(Incident.category == category)
    if not include_closed:
        filters.append(Incident.status.in_(ACTIVE_INCIDENT_STATES))
    for f in filters:
        stmt = stmt.where(f)
        count_stmt = count_stmt.where(f)
    columns = {
        "reported_at": Incident.reported_at,
        "severity": Incident.severity,
        "status": Incident.status,
        "code": Incident.code,
        "title": Incident.title,
    }
    col = columns.get(sort, Incident.reported_at)
    stmt = stmt.order_by(col.desc() if direction == "desc" else col.asc())
    total = db.scalar(count_stmt) or 0
    return list(db.scalars(stmt.offset(offset).limit(limit)).all()), total


def get_incident(db: Session, incident_id: int) -> Incident:
    incident = db.get(Incident, incident_id)
    if incident is None:
        raise ApiError("Incident not found.", status_code=404, code="not_found")
    return incident


def create_incident(db: Session, payload: IncidentCreate, *, actor_id: int | None) -> Incident:
    asset = db.get(InfrastructureAsset, payload.primary_asset_id)
    if asset is None or asset.is_archived:
        raise ApiError(
            "The selected primary asset does not exist.",
            status_code=422,
            code="invalid_asset",
        )
    duplicate = db.scalar(
        select(Incident).where(
            Incident.primary_asset_id == payload.primary_asset_id,
            Incident.category == payload.category,
            Incident.status.in_(ACTIVE_INCIDENT_STATES),
        )
    )
    if duplicate:
        raise ApiError(
            f"{duplicate.code} is already open for this asset and category. "
            "Update the existing incident instead of creating a duplicate.",
            status_code=409,
            code="duplicate_incident",
            details={"incident_id": duplicate.id, "incident_code": duplicate.code},
        )
    affected_population = 0
    if payload.simulation_run_id:
        from app.models.simulation import SimulationRun

        run = db.get(SimulationRun, payload.simulation_run_id)
        if run is None:
            raise ApiError(
                "The referenced simulation does not exist.", status_code=422, code="invalid_simulation"
            )
        summary = json.loads(run.summary_json or "{}")
        affected_population = int(summary.get("affected_population", 0))

    incident = Incident(
        code=next_incident_code(db),
        title=payload.title.strip(),
        description=payload.description,
        category=payload.category,
        severity=payload.severity,
        status=IncidentStatus.REPORTED,
        primary_asset_id=payload.primary_asset_id,
        reported_by_id=actor_id,
        assigned_operator_id=actor_id,
        affected_population=affected_population,
        simulation_run_id=payload.simulation_run_id,
        reported_at=utcnow(),
    )
    db.add(incident)
    db.flush()
    asset_ids = {payload.primary_asset_id, *payload.affected_asset_ids}
    for asset_id in asset_ids:
        if db.get(InfrastructureAsset, asset_id) is None:
            continue
        db.add(
            IncidentAsset(
                incident_id=incident.id,
                asset_id=asset_id,
                impact_level="failed" if asset_id == payload.primary_asset_id else "affected",
                impact_score=1.0 if asset_id == payload.primary_asset_id else 0.4,
            )
        )
    add_event(
        db,
        incident,
        event_type="created",
        from_status=None,
        to_status=IncidentStatus.REPORTED,
        message=f"Incident {incident.code} reported by operations.",
        actor_id=actor_id,
    )
    notify.push_to_roles(
        db,
        ["super_admin", "city_operator"],
        title=f"New {payload.severity} incident: {incident.code}",
        body=incident.title,
        category="incident",
        severity="warning" if payload.severity in ("high", "critical") else "info",
        link=f"/incidents/{incident.id}",
        entity_type="incident",
        entity_id=incident.id,
    )
    db.flush()
    return incident


def add_event(
    db: Session,
    incident: Incident,
    *,
    event_type: str,
    from_status: str | None,
    to_status: str | None,
    message: str,
    actor_id: int | None,
    data: dict | None = None,
) -> IncidentEvent:
    event = IncidentEvent(
        incident_id=incident.id,
        event_type=event_type,
        from_status=from_status,
        to_status=to_status,
        message=message[:400],
        actor_id=actor_id,
    )
    db.add(event)
    if data:
        incident.description = incident.description  # touch, keeps intent explicit
    return event


def update_incident(
    db: Session, incident: Incident, payload: IncidentUpdate, *, actor_id: int | None
) -> Incident:
    if incident.status in (IncidentStatus.RESOLVED, IncidentStatus.CANCELLED):
        raise ApiError(
            "Closed incidents are read-only. Reopen the incident to make changes.",
            status_code=409,
            code="incident_closed",
        )
    data = payload.model_dump(exclude_unset=True)
    changes = []
    for key, value in data.items():
        if value is None:
            continue
        if getattr(incident, key) != value:
            changes.append(f"{key}: {getattr(incident, key)!r} → {value!r}")
            setattr(incident, key, value)
    incident.updated_at = utcnow()
    if changes:
        add_event(
            db,
            incident,
            event_type="updated",
            from_status=incident.status,
            to_status=incident.status,
            message="; ".join(changes)[:400],
            actor_id=actor_id,
        )
    db.flush()
    return incident


def transition(
    db: Session,
    incident: Incident,
    payload: IncidentTransition,
    *,
    actor_id: int | None,
    actor_permissions: set[str],
) -> Incident:
    target = (
        payload.status.value if isinstance(payload.status, IncidentStatus) else payload.status
    )
    current = incident.status
    if target == current:
        raise ApiError(
            f"{incident.code} is already {current}.", status_code=409, code="no_status_change"
        )
    allowed = INCIDENT_TRANSITIONS.get(current, set())
    if target not in allowed:
        raise ApiError(
            f"Cannot move an incident from {current.replace('_', ' ')} to "
            f"{target.replace('_', ' ')}. Allowed next states: "
            + (", ".join(sorted(allowed)) or "none") + ".",
            status_code=409,
            code="invalid_transition",
            details={"from": current, "to": target, "allowed": sorted(allowed)},
        )
    # permission gates per target state
    if target == IncidentStatus.APPROVED and "optimization:approve" not in actor_permissions:
        raise ApiError(
            "Only an operator can approve a recovery plan for an incident.",
            status_code=403,
            code="forbidden",
        )
    if target == IncidentStatus.RESOLVED:
        if "incident:resolve" not in actor_permissions:
            raise ApiError(
                "Only an operator can resolve an incident.", status_code=403, code="forbidden"
            )
        verified = db.scalar(
            select(func.count())
            .select_from(RepairTask)
            .where(
                RepairTask.incident_id == incident.id,
                RepairTask.status != TaskStatus.VERIFIED,
                RepairTask.status != TaskStatus.CANCELLED,
            )
        )
        if verified:
            raise ApiError(
                f"{verified} repair task(s) are still open. Verify or cancel them before resolving the incident.",
                status_code=409,
                code="open_tasks",
            )
        incident.resolved_at = utcnow()
        incident.resolution_notes = payload.resolution_notes or payload.note or "Resolved."
        from app.models.infrastructure import AssetStatus
        from app.services.infrastructure import change_status

        asset = db.get(InfrastructureAsset, incident.primary_asset_id)
        if asset and asset.status != AssetStatus.OPERATIONAL and not asset.is_archived:
            change_status(
                db,
                asset,
                AssetStatus.OPERATIONAL,
                reason=f"Incident {incident.code} resolved",
                actor_id=actor_id,
            )
    if target == IncidentStatus.CANCELLED:
        if "incident:write" not in actor_permissions:
            raise ApiError("Not allowed to cancel incidents.", status_code=403, code="forbidden")
        incident.cancelled_at = utcnow()
    if target == IncidentStatus.VERIFIED and current == IncidentStatus.RESOLVED:
        incident.resolved_at = None

    incident.status = target
    incident.updated_at = utcnow()
    add_event(
        db,
        incident,
        event_type="status_change",
        from_status=current,
        to_status=target,
        message=payload.note or f"Status changed to {target.replace('_', ' ')}.",
        actor_id=actor_id,
    )
    if target == IncidentStatus.RESOLVED:
        from app.workflows.engine import sync_workflow_step

        sync_workflow_step(db, incident_id=incident.id, step="repair_verified", actor_id=actor_id)
        sync_workflow_step(db, incident_id=incident.id, step="incident_resolved", actor_id=actor_id)
    notify.push_to_roles(
        db,
        ["super_admin", "city_operator"],
        title=f"{incident.code} → {target.replace('_', ' ')}",
        body=payload.note or incident.title,
        category="incident",
        severity="success" if target == IncidentStatus.RESOLVED else "info",
        link=f"/incidents/{incident.id}",
        entity_type="incident",
        entity_id=incident.id,
    )
    db.flush()
    return incident


def allowed_transitions(incident: Incident) -> list[str]:
    return sorted(INCIDENT_TRANSITIONS.get(incident.status, set()))


def incident_to_dict(db: Session, incident: Incident, *, detail: bool = False) -> dict:
    asset = db.get(InfrastructureAsset, incident.primary_asset_id)
    task_count = (
        db.scalar(
            select(func.count()).select_from(RepairTask).where(RepairTask.incident_id == incident.id)
        )
        or 0
    )
    open_tasks = (
        db.scalar(
            select(func.count())
            .select_from(RepairTask)
            .where(
                RepairTask.incident_id == incident.id,
                RepairTask.status.notin_([TaskStatus.VERIFIED, TaskStatus.CANCELLED]),
            )
        )
        or 0
    )
    base = {
        "id": incident.id,
        "code": incident.code,
        "title": incident.title,
        "description": incident.description,
        "category": incident.category,
        "severity": incident.severity,
        "status": incident.status,
        "primary_asset_id": incident.primary_asset_id,
        "reported_by_id": incident.reported_by_id,
        "assigned_operator_id": incident.assigned_operator_id,
        "affected_population": incident.affected_population,
        "simulation_run_id": incident.simulation_run_id,
        "optimization_plan_id": incident.optimization_plan_id,
        "workflow_id": incident.workflow_id,
        "reported_at": incident.reported_at,
        "resolved_at": incident.resolved_at,
        "resolution_notes": incident.resolution_notes,
        "created_at": incident.created_at,
        "updated_at": incident.updated_at,
        "primary_asset_code": asset.code if asset else None,
        "primary_asset_name": asset.name if asset else None,
        "task_count": task_count,
        "open_task_count": open_tasks,
    }
    if detail:
        affected = db.scalars(
            select(IncidentAsset).where(IncidentAsset.incident_id == incident.id)
        ).all()
        events = db.scalars(
            select(IncidentEvent)
            .where(IncidentEvent.incident_id == incident.id)
            .order_by(IncidentEvent.created_at)
        ).all()
        base["affected_assets"] = [
            {
                "id": row.id,
                "asset_id": row.asset_id,
                "impact_level": row.impact_level,
                "impact_score": row.impact_score,
            }
            for row in affected
        ]
        base["events"] = [
            {
                "id": e.id,
                "event_type": e.event_type,
                "from_status": e.from_status,
                "to_status": e.to_status,
                "message": e.message,
                "actor_id": e.actor_id,
                "created_at": e.created_at,
            }
            for e in events
        ]
        base["allowed_transitions"] = allowed_transitions(incident)
    return base


def timeline_counts(db: Session, days: int = 30) -> list[dict]:
    from datetime import timedelta

    since = utcnow() - timedelta(days=days)
    incidents = db.scalars(select(Incident).where(Incident.reported_at >= since)).all()
    buckets: dict[str, dict] = {}
    for i in range(days):
        day = (since + timedelta(days=i)).date().isoformat()
        buckets[day] = {"date": day, "reported": 0, "resolved": 0, "critical": 0}
    for incident in incidents:
        key = incident.reported_at.date().isoformat()
        if key in buckets:
            buckets[key]["reported"] += 1
            if incident.severity == "critical":
                buckets[key]["critical"] += 1
        if incident.resolved_at:
            rkey = incident.resolved_at.date().isoformat()
            if rkey in buckets:
                buckets[rkey]["resolved"] += 1
    return list(buckets.values())
