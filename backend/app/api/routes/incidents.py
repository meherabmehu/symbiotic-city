"""Incident endpoints with validated transitions."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, status

from app.api.deps import CurrentUser, DbSession, Pagination, require_permissions
from app.core.responses import ApiError, ok, paginated
from app.core.types import utcnow
from app.models.operations import Incident, IncidentStatus
from app.schemas.operations import IncidentCreate, IncidentTransition, IncidentUpdate
from app.services import audit
from app.services import incidents as service

router = APIRouter(tags=["incidents"])


@router.get("/incidents")
def list_incidents(
    db: DbSession,
    user: CurrentUser,
    page: Pagination,
    search: str | None = Query(None, max_length=120),
    status_filter: str | None = Query(None, alias="status"),
    severity: str | None = None,
    asset_id: int | None = None,
    category: str | None = None,
    include_closed: bool = True,
    sort: str = "reported_at",
    direction: str = Query("desc", pattern="^(asc|desc)$"),
):
    items, total = service.list_incidents(
        db,
        search=search,
        status=status_filter,
        severity=severity,
        asset_id=asset_id,
        category=category,
        include_closed=include_closed,
        sort=sort,
        direction=direction,
        offset=page.offset,
        limit=page.limit,
    )
    return paginated(
        [service.incident_to_dict(db, i) for i in items],
        total=total,
        page=page.page,
        page_size=page.page_size,
    )


@router.get("/incidents/summary")
def incident_summary(db: DbSession, user: CurrentUser):
    from sqlalchemy import func, select

    from app.services.infrastructure import ACTIVE_INCIDENT_STATES

    rows = db.execute(
        select(Incident.status, func.count()).group_by(Incident.status)
    ).all()
    counts = {s.value: 0 for s in IncidentStatus}
    for key, value in rows:
        counts[key] = value
    return ok(
        {
            "counts": counts,
            "active": sum(counts.get(s, 0) for s in ACTIVE_INCIDENT_STATES),
            "total": sum(counts.values()),
        }
    )


@router.post(
    "/incidents",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permissions("incident:write"))],
)
def create_incident(payload: IncidentCreate, request: Request, db: DbSession, user: CurrentUser):
    incident = service.create_incident(db, payload, actor_id=user.id)
    audit.record(
        db, action="incident.create", actor=user, resource_type="incident", resource_id=incident.id,
        message=f"{incident.code} created ({incident.severity}) — {incident.title}", request=request,
    )
    db.commit()
    return ok(service.incident_to_dict(db, incident, detail=True))


@router.get("/incidents/{incident_id}")
def get_incident(incident_id: int, db: DbSession, user: CurrentUser):
    incident = service.get_incident(db, incident_id)
    return ok(service.incident_to_dict(db, incident, detail=True))


@router.patch("/incidents/{incident_id}", dependencies=[Depends(require_permissions("incident:write"))])
def update_incident(
    incident_id: int, payload: IncidentUpdate, request: Request, db: DbSession, user: CurrentUser
):
    incident = service.get_incident(db, incident_id)
    service.update_incident(db, incident, payload, actor_id=user.id)
    audit.record(
        db, action="incident.update", actor=user, resource_type="incident", resource_id=incident.id,
        message=f"{incident.code} updated", metadata=payload.model_dump(exclude_unset=True), request=request,
    )
    db.commit()
    return ok(service.incident_to_dict(db, incident, detail=True))


@router.post("/incidents/{incident_id}/transition", dependencies=[Depends(require_permissions("incident:read"))])
def transition_incident(
    incident_id: int, payload: IncidentTransition, request: Request, db: DbSession, user: CurrentUser
):
    incident = service.get_incident(db, incident_id)
    previous = incident.status
    service.transition(
        db, incident, payload, actor_id=user.id, actor_permissions=user.permission_keys
    )
    audit.record(
        db, action="incident.transition", actor=user, resource_type="incident", resource_id=incident.id,
        message=f"{incident.code}: {previous} → {incident.status}",
        metadata={"note": payload.note}, request=request,
    )
    db.commit()
    return ok(service.incident_to_dict(db, incident, detail=True))


@router.post("/incidents/{incident_id}/reopen", dependencies=[Depends(require_permissions("incident:write"))])
def reopen_incident(incident_id: int, request: Request, db: DbSession, user: CurrentUser):
    incident = service.get_incident(db, incident_id)
    if incident.status != IncidentStatus.RESOLVED:
        raise ApiError(
            "Only a resolved incident can be reopened.", status_code=409, code="invalid_transition"
        )
    service.transition(
        db,
        incident,
        IncidentTransition(status=IncidentStatus.VERIFIED, note="Reopened after post-repair fault report."),
        actor_id=user.id,
        actor_permissions=user.permission_keys,
    )
    audit.record(
        db, action="incident.reopen", actor=user, resource_type="incident", resource_id=incident.id,
        message=f"{incident.code} reopened", request=request,
    )
    db.commit()
    return ok(service.incident_to_dict(db, incident, detail=True))
