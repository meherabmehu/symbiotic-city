"""Resource inventory, transactional reservations and release."""
from __future__ import annotations

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.responses import ApiError
from app.core.types import utcnow
from app.models.operations import (
    ReservationStatus,
    Resource,
    ResourceCategory,
    ResourceReservation,
)
from app.schemas.operations import ResourceCreate, ResourceUpdate
from app.services import notifications as notify


def list_resources(
    db: Session,
    *,
    search: str | None = None,
    category: str | None = None,
    status: str | None = None,
    include_archived: bool = False,
    sort: str = "name",
    direction: str = "asc",
    offset: int = 0,
    limit: int = 20,
) -> tuple[list[Resource], int]:
    stmt = select(Resource)
    count_stmt = select(func.count()).select_from(Resource)
    filters = []
    if not include_archived:
        filters.append(Resource.is_archived.is_(False))
    if search:
        needle = f"%{search.lower()}%"
        filters.append(
            or_(func.lower(Resource.name).like(needle), func.lower(Resource.code).like(needle))
        )
    if category:
        filters.append(Resource.category == category)
    if status:
        filters.append(Resource.status == status)
    for f in filters:
        stmt = stmt.where(f)
        count_stmt = count_stmt.where(f)
    columns = {
        "name": Resource.name,
        "code": Resource.code,
        "category": Resource.category,
        "capacity": Resource.capacity,
        "hourly_cost": Resource.hourly_cost,
    }
    col = columns.get(sort, Resource.name)
    stmt = stmt.order_by(col.desc() if direction == "desc" else col.asc())
    total = db.scalar(count_stmt) or 0
    return list(db.scalars(stmt.offset(offset).limit(limit)).all()), total


def reserved_quantity(db: Session, resource_id: int) -> float:
    value = db.scalar(
        select(func.coalesce(func.sum(ResourceReservation.quantity), 0)).where(
            ResourceReservation.resource_id == resource_id,
            ResourceReservation.status == ReservationStatus.RESERVED,
        )
    )
    return float(value or 0)


def resource_to_dict(db: Session, resource: Resource) -> dict:
    reserved = reserved_quantity(db, resource.id)
    active = (
        db.scalar(
            select(func.count())
            .select_from(ResourceReservation)
            .where(
                ResourceReservation.resource_id == resource.id,
                ResourceReservation.status == ReservationStatus.RESERVED,
            )
        )
        or 0
    )
    capacity = float(resource.capacity)
    return {
        "id": resource.id,
        "code": resource.code,
        "name": resource.name,
        "category": resource.category,
        "capacity": capacity,
        "capacity_unit": resource.capacity_unit,
        "status": resource.status,
        "home_zone_id": resource.home_zone_id,
        "hourly_cost": resource.hourly_cost,
        "mobilisation_minutes": resource.mobilisation_minutes,
        "notes": resource.notes,
        "is_archived": resource.is_archived,
        "created_at": resource.created_at,
        "updated_at": resource.updated_at,
        "reserved_quantity": round(reserved, 2),
        "available_quantity": round(max(0.0, capacity - reserved), 2),
        "active_reservations": active,
    }


def create_resource(db: Session, payload: ResourceCreate) -> Resource:
    if db.scalar(select(Resource).where(Resource.code == payload.code)):
        raise ApiError(
            f"Resource code {payload.code} already exists.", status_code=409, code="duplicate_code"
        )
    resource = Resource(**payload.model_dump())
    db.add(resource)
    db.flush()
    return resource


def update_resource(db: Session, resource: Resource, payload: ResourceUpdate) -> Resource:
    data = payload.model_dump(exclude_unset=True)
    new_capacity = data.get("capacity")
    if new_capacity is not None:
        reserved = reserved_quantity(db, resource.id)
        if new_capacity < reserved:
            raise ApiError(
                f"Cannot reduce capacity below the {reserved:g} currently reserved on active tasks.",
                status_code=409,
                code="capacity_below_reserved",
            )
    for key, value in data.items():
        setattr(resource, key, value)
    resource.updated_at = utcnow()
    db.flush()
    return resource


def reserve(
    db: Session,
    resource: Resource,
    *,
    quantity: float | None,
    repair_task_id: int | None,
    plan_id: int | None,
    workflow_id: int | None = None,
    actor_id: int | None,
) -> ResourceReservation:
    """Reserve capacity inside the caller's transaction.

    Uses a row lock on PostgreSQL (``with_for_update``) and an explicit
    re-check on SQLite, so two concurrent approvals cannot double book the same
    exclusive resource.
    """
    if resource.status in ("maintenance", "unavailable"):
        raise ApiError(
            f"{resource.code} is {resource.status} and cannot be reserved.",
            status_code=409,
            code="resource_unavailable",
        )
    # Serialise concurrent reservations for the same resource.
    locked = db.scalar(
        select(Resource).where(Resource.id == resource.id).with_for_update()
    )
    if locked is None:
        raise ApiError("Resource not found.", status_code=404, code="not_found")
    amount = float(quantity if quantity is not None else resource.capacity)
    if amount <= 0:
        raise ApiError("Reservation quantity must be positive.", status_code=422, code="invalid_quantity")
    already = reserved_quantity(db, resource.id)
    capacity = float(locked.capacity)
    if already + amount > capacity + 1e-9:
        raise ApiError(
            f"{resource.code} only has {capacity - already:g} {resource.capacity_unit} uncommitted; "
            f"{amount:g} requested.",
            status_code=409,
            code="insufficient_capacity",
            details={
                "resource_id": resource.id,
                "capacity": capacity,
                "reserved": already,
                "requested": amount,
            },
        )
    if repair_task_id:
        existing = db.scalar(
            select(ResourceReservation).where(
                ResourceReservation.resource_id == resource.id,
                ResourceReservation.repair_task_id == repair_task_id,
                ResourceReservation.status == ReservationStatus.RESERVED,
            )
        )
        if existing:
            raise ApiError(
                f"{resource.code} is already reserved for this task.",
                status_code=409,
                code="duplicate_reservation",
                details={"reservation_id": existing.id},
            )
    reservation = ResourceReservation(
        resource_id=resource.id,
        repair_task_id=repair_task_id,
        plan_id=plan_id,
        workflow_id=workflow_id,
        quantity=amount,
        status=ReservationStatus.RESERVED,
        reserved_by_id=actor_id,
        reserved_at=utcnow(),
    )
    db.add(reservation)
    try:
        db.flush()
    except IntegrityError as exc:  # pragma: no cover - DB level guard
        db.rollback()
        raise ApiError(
            "The reservation conflicted with a concurrent allocation. Nothing was changed.",
            status_code=409,
            code="reservation_conflict",
        ) from exc
    return reservation


def release(
    db: Session, reservation: ResourceReservation, *, reason: str, actor_id: int | None
) -> ResourceReservation:
    if reservation.status != ReservationStatus.RESERVED:
        raise ApiError(
            f"Reservation is already {reservation.status}.", status_code=409, code="already_released"
        )
    reservation.status = ReservationStatus.RELEASED
    reservation.released_at = utcnow()
    reservation.release_reason = reason[:240]
    db.flush()
    return reservation


def list_reservations(
    db: Session, *, resource_id: int | None = None, status: str | None = None, limit: int = 100
) -> list[ResourceReservation]:
    stmt = select(ResourceReservation).order_by(ResourceReservation.reserved_at.desc())
    if resource_id:
        stmt = stmt.where(ResourceReservation.resource_id == resource_id)
    if status:
        stmt = stmt.where(ResourceReservation.status == status)
    return list(db.scalars(stmt.limit(limit)).all())


def utilisation_summary(db: Session) -> list[dict]:
    rows = db.execute(
        select(
            Resource.category,
            func.count(Resource.id),
            func.coalesce(func.sum(Resource.capacity), 0),
        )
        .where(Resource.is_archived.is_(False))
        .group_by(Resource.category)
    ).all()
    reserved_rows = db.execute(
        select(
            Resource.category,
            func.coalesce(func.sum(ResourceReservation.quantity), 0),
        )
        .join(ResourceReservation, ResourceReservation.resource_id == Resource.id)
        .where(ResourceReservation.status == ReservationStatus.RESERVED)
        .group_by(Resource.category)
    ).all()
    reserved = {row[0]: float(row[1]) for row in reserved_rows}
    out = []
    for category, count, capacity in rows:
        used = reserved.get(category, 0.0)
        capacity_f = float(capacity)
        out.append(
            {
                "category": category,
                "label": RESOURCE_LABELS.get(category, category.replace("_", " ").title()),
                "count": int(count),
                "capacity": round(capacity_f, 2),
                "reserved": round(used, 2),
                "available": round(max(0.0, capacity_f - used), 2),
                "utilisation_percent": round(100.0 * used / capacity_f, 1) if capacity_f else 0.0,
            }
        )
    return out


RESOURCE_LABELS = {
    ResourceCategory.GENERATOR: "Backup Generator",
    ResourceCategory.WATER_TANKER: "Water Tanker",
    ResourceCategory.CREW: "Repair Crew",
    ResourceCategory.EQUIPMENT: "Heavy Equipment",
    ResourceCategory.MEDICAL_SUPPLY: "Medical Supply",
}


def broadcast_low_availability(db: Session, threshold: float = 0.15) -> None:
    """Notify operators when a resource class drops below a safety margin."""
    for row in utilisation_summary(db):
        if row["capacity"] and row["available"] / row["capacity"] <= threshold:
            notify.push_to_roles(
                db,
                ["city_operator", "super_admin"],
                title=f"{row['label']} availability low",
                body=(
                    f"{row['available']:g} of {row['capacity']:g} units remain "
                    f"({row['utilisation_percent']}% committed)."
                ),
                category="resource",
                severity="warning",
                link="/resources",
            )
