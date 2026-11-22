"""Resource inventory, reservation and release endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, status

from app.api.deps import CurrentUser, DbSession, Pagination, require_permissions
from app.core.responses import ApiError, ok, paginated
from app.models.operations import ReservationStatus, Resource, ResourceReservation
from app.schemas.operations import (
    ReleaseRequest,
    ReserveRequest,
    ResourceCreate,
    ResourceUpdate,
)
from app.services import audit
from app.services import resources as service

router = APIRouter(tags=["resources"])


@router.get("/resources/categories")
def categories():
    from app.models.operations import RESOURCE_CATEGORY_LABELS

    return ok([{"key": k, "label": v} for k, v in RESOURCE_CATEGORY_LABELS.items()])


@router.get("/resources")
def list_resources(
    db: DbSession,
    user: CurrentUser,
    page: Pagination,
    search: str | None = Query(None, max_length=120),
    category: str | None = None,
    status_filter: str | None = Query(None, alias="status"),
    include_archived: bool = False,
    sort: str = "name",
    direction: str = Query("asc", pattern="^(asc|desc)$"),
):
    items, total = service.list_resources(
        db,
        search=search,
        category=category,
        status=status_filter,
        include_archived=include_archived,
        sort=sort,
        direction=direction,
        offset=page.offset,
        limit=page.limit,
    )
    return paginated(
        [service.resource_to_dict(db, r) for r in items],
        total=total,
        page=page.page,
        page_size=page.page_size,
    )


@router.get("/resources/utilisation")
def utilisation(db: DbSession, user: CurrentUser):
    return ok(service.utilisation_summary(db))


@router.post(
    "/resources",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permissions("resource:write"))],
)
def create_resource(payload: ResourceCreate, request: Request, db: DbSession, user: CurrentUser):
    resource = service.create_resource(db, payload)
    audit.record(
        db, action="resource.create", actor=user, resource_type="resource", resource_id=resource.id,
        message=f"{resource.code} registered ({resource.category})", request=request,
    )
    db.commit()
    return ok(service.resource_to_dict(db, resource))


@router.patch("/resources/{resource_id}", dependencies=[Depends(require_permissions("resource:write"))])
def update_resource(
    resource_id: int, payload: ResourceUpdate, request: Request, db: DbSession, user: CurrentUser
):
    resource = db.get(Resource, resource_id)
    if resource is None:
        raise ApiError("Resource not found.", status_code=404, code="not_found")
    service.update_resource(db, resource, payload)
    audit.record(
        db, action="resource.update", actor=user, resource_type="resource", resource_id=resource.id,
        message=f"{resource.code} updated", metadata=payload.model_dump(exclude_unset=True), request=request,
    )
    db.commit()
    return ok(service.resource_to_dict(db, resource))


@router.get("/resources/{resource_id}")
def get_resource(resource_id: int, db: DbSession, user: CurrentUser):
    resource = db.get(Resource, resource_id)
    if resource is None:
        raise ApiError("Resource not found.", status_code=404, code="not_found")
    data = service.resource_to_dict(db, resource)
    data["reservations"] = [
        {
            "id": r.id, "repair_task_id": r.repair_task_id, "plan_id": r.plan_id,
            "quantity": float(r.quantity), "status": r.status, "reserved_at": r.reserved_at,
            "released_at": r.released_at, "release_reason": r.release_reason,
        }
        for r in service.list_reservations(db, resource_id=resource.id)
    ]
    return ok(data)


@router.post("/resources/{resource_id}/reserve", dependencies=[Depends(require_permissions("resource:write"))])
def reserve(
    resource_id: int, payload: ReserveRequest, request: Request, db: DbSession, user: CurrentUser
):
    resource = db.get(Resource, resource_id)
    if resource is None:
        raise ApiError("Resource not found.", status_code=404, code="not_found")
    reservation = service.reserve(
        db,
        resource,
        quantity=payload.quantity,
        repair_task_id=payload.repair_task_id,
        plan_id=payload.plan_id,
        actor_id=user.id,
    )
    audit.record(
        db, action="resource.reserve", actor=user, resource_type="resource_reservation",
        resource_id=reservation.id,
        message=f"Reserved {reservation.quantity:g} of {resource.code}", request=request,
    )
    db.commit()
    return ok(
        {
            "id": reservation.id,
            "resource_id": resource.id,
            "quantity": float(reservation.quantity),
            "status": reservation.status,
            "available": service.resource_to_dict(db, resource)["available_quantity"],
        }
    )


@router.post("/resources/reservations/{reservation_id}/release", dependencies=[Depends(require_permissions("resource:write"))])
def release(
    reservation_id: int, payload: ReleaseRequest, request: Request, db: DbSession, user: CurrentUser
):
    reservation = db.get(ResourceReservation, reservation_id)
    if reservation is None:
        raise ApiError("Reservation not found.", status_code=404, code="not_found")
    service.release(db, reservation, reason=payload.reason, actor_id=user.id)
    audit.record(
        db, action="resource.release", actor=user, resource_type="resource_reservation",
        resource_id=reservation.id, message=f"Released: {payload.reason}", request=request,
    )
    db.commit()
    return ok({"message": "Reservation released.", "id": reservation.id})


@router.get("/resources/reservations")
def reservations(
    db: DbSession,
    user: CurrentUser,
    resource_id: int | None = None,
    status_filter: str | None = Query(None, alias="status"),
):
    rows = service.list_reservations(db, resource_id=resource_id, status=status_filter)
    return ok(
        [
            {
                "id": r.id, "resource_id": r.resource_id, "repair_task_id": r.repair_task_id,
                "plan_id": r.plan_id, "workflow_id": r.workflow_id, "quantity": float(r.quantity),
                "status": r.status, "reserved_at": r.reserved_at, "released_at": r.released_at,
                "release_reason": r.release_reason,
            }
            for r in rows
        ]
    )
