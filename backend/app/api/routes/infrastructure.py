"""Infrastructure, zone, dependency and digital-twin endpoints."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy import func, select

from app.api.deps import CurrentUser, DbSession, Pagination, require_permissions
from app.core.responses import ApiError, ok, paginated
from app.core.types import utcnow
from app.models.infrastructure import (
    CATEGORY_LABELS,
    AssetCategory,
    AssetStatus,
    CityZone,
    InfrastructureAsset,
    InfrastructureDependency,
)
from app.models.operations import Incident, IncidentAsset
from app.schemas.infrastructure import (
    AssetCreate,
    AssetUpdate,
    DependencyCreate,
    StatusChange,
    TwinGraph,
    ZoneCreate,
)
from app.services import audit
from app.services import infrastructure as service
from app.services.infrastructure import ACTIVE_INCIDENT_STATES

router = APIRouter(tags=["infrastructure"])


@router.get("/infrastructure/categories")
def categories():
    return ok(
        [
            {"key": c.value, "label": CATEGORY_LABELS.get(c.value, c.value.replace("_", " ").title())}
            for c in AssetCategory
        ]
    )


@router.get("/infrastructure/statuses")
def statuses():
    return ok([{"key": s.value, "label": s.value.replace("_", " ").title()} for s in AssetStatus])


@router.get("/zones")
def list_zones(db: DbSession, user: CurrentUser):
    zones = service.list_zones(db)
    counts = dict(
        db.execute(
            select(InfrastructureAsset.zone_id, func.count())
            .where(InfrastructureAsset.is_archived.is_(False))
            .group_by(InfrastructureAsset.zone_id)
        ).all()
    )
    return ok(
        [
            {
                "id": z.id,
                "code": z.code,
                "name": z.name,
                "district": z.district,
                "population": z.population,
                "center_x": z.center_x,
                "center_y": z.center_y,
                "assets": counts.get(z.id, 0),
            }
            for z in zones
        ]
    )


@router.post("/zones", status_code=status.HTTP_201_CREATED, dependencies=[Depends(require_permissions("settings:manage"))])
def create_zone(payload: ZoneCreate, request: Request, db: DbSession, user: CurrentUser):
    if db.scalar(select(CityZone).where(CityZone.code == payload.code)):
        raise ApiError("A zone with that code already exists.", status_code=409, code="duplicate_code")
    zone = CityZone(**payload.model_dump())
    db.add(zone)
    db.flush()
    audit.record(
        db, action="zone.create", actor=user, resource_type="city_zone", resource_id=zone.id,
        message=f"Zone {zone.code} created", request=request,
    )
    db.commit()
    return ok({"id": zone.id, "code": zone.code, "name": zone.name})


@router.get("/infrastructure")
def list_assets(
    db: DbSession,
    user: CurrentUser,
    page: Pagination,
    search: str | None = Query(None, max_length=120),
    category: str | None = None,
    status_filter: str | None = Query(None, alias="status"),
    zone_id: int | None = None,
    include_archived: bool = False,
    sort: str = "name",
    direction: str = Query("asc", pattern="^(asc|desc)$"),
):
    items, total = service.list_assets(
        db,
        search=search,
        category=category,
        status=status_filter,
        zone_id=zone_id,
        include_archived=include_archived,
        sort=sort,
        direction=direction,
        offset=page.offset,
        limit=page.limit,
    )
    dependency_counts = _dependency_counts(db)
    payload = []
    for asset in items:
        data = _asset_dict(asset)
        data["inbound_dependencies"] = dependency_counts["inbound"].get(asset.id, 0)
        data["outbound_dependencies"] = dependency_counts["outbound"].get(asset.id, 0)
        payload.append(data)
    return paginated(payload, total=total, page=page.page, page_size=page.page_size)


@router.post(
    "/infrastructure",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permissions("infrastructure:write"))],
)
def create_asset(payload: AssetCreate, request: Request, db: DbSession, user: CurrentUser):
    asset = service.create_asset(db, payload)
    audit.record(
        db, action="infrastructure.create", actor=user, resource_type="infrastructure_asset",
        resource_id=asset.id, message=f"Registered {asset.code} ({asset.category})", request=request,
    )
    db.commit()
    return ok(_asset_dict(asset))


@router.get("/infrastructure/{asset_id}")
def get_asset(asset_id: int, db: DbSession, user: CurrentUser):
    asset = service.get_asset(db, asset_id)
    dependents = service.dependencies_for(db, asset_id)
    assets = {
        a.id: a
        for a in db.scalars(
            select(InfrastructureAsset).where(
                InfrastructureAsset.id.in_(
                    {d.source_asset_id for d in dependents} | {d.target_asset_id for d in dependents}
                )
            )
        ).all()
    }
    detail = _asset_dict(asset)
    detail["inbound"] = [
        _dependency_row(d, assets) for d in dependents if d.target_asset_id == asset_id
    ]
    detail["outbound"] = [
        _dependency_row(d, assets) for d in dependents if d.source_asset_id == asset_id
    ]
    detail["history"] = [
        {
            "id": h.id,
            "previous_status": h.previous_status,
            "new_status": h.new_status,
            "reason": h.reason,
            "changed_at": h.changed_at,
            "changed_by_id": h.changed_by_id,
        }
        for h in service.status_history(db, asset_id)
    ]
    open_incidents = db.scalars(
        select(Incident)
        .join(IncidentAsset, IncidentAsset.incident_id == Incident.id)
        .where(IncidentAsset.asset_id == asset_id, Incident.status.in_(ACTIVE_INCIDENT_STATES))
    ).unique().all()
    detail["active_incidents"] = [
        {"id": i.id, "code": i.code, "title": i.title, "severity": i.severity, "status": i.status}
        for i in open_incidents
    ]
    return ok(detail)


@router.patch(
    "/infrastructure/{asset_id}",
    dependencies=[Depends(require_permissions("infrastructure:write"))],
)
def update_asset(asset_id: int, payload: AssetUpdate, request: Request, db: DbSession, user: CurrentUser):
    asset = service.get_asset(db, asset_id)
    if asset.is_archived:
        raise ApiError("Archived assets are read-only.", status_code=409, code="asset_archived")
    before = _asset_dict(asset)
    service.update_asset(db, asset, payload, user.id)
    audit.record(
        db, action="infrastructure.update", actor=user, resource_type="infrastructure_asset",
        resource_id=asset.id, message=f"Updated {asset.code}",
        metadata={"changes": payload.model_dump(exclude_unset=True)}, request=request,
    )
    db.commit()
    return ok(_asset_dict(service.get_asset(db, asset_id)))


@router.post(
    "/infrastructure/{asset_id}/status",
    dependencies=[Depends(require_permissions("infrastructure:write"))],
)
def change_status(asset_id: int, payload: StatusChange, request: Request, db: DbSession, user: CurrentUser):
    asset = service.get_asset(db, asset_id)
    if asset.is_archived:
        raise ApiError("Archived assets cannot change status.", status_code=409, code="asset_archived")
    previous = asset.status
    service.change_status(db, asset, payload.status.value, reason=payload.reason, actor_id=user.id)
    affected = db.scalars(
        select(InfrastructureAsset).where(InfrastructureAsset.id == asset_id)
    ).all()
    audit.record(
        db, action="infrastructure.status_change", actor=user, resource_type="infrastructure_asset",
        resource_id=asset.id, message=f"{asset.code}: {previous} → {asset.status} ({payload.reason})",
        metadata={"previous": previous, "new": asset.status}, request=request,
    )
    db.commit()
    return ok({"asset": _asset_dict(asset), "propagation_note": "Dependent statuses were re-evaluated."})


@router.delete(
    "/infrastructure/{asset_id}",
    dependencies=[Depends(require_permissions("infrastructure:delete"))],
)
def archive_asset(
    asset_id: int,
    request: Request,
    db: DbSession,
    user: CurrentUser,
    hard: bool = Query(False, description="Permanently delete a never-used asset"),
):
    asset = service.get_asset(db, asset_id)
    if hard:
        service.delete_asset_hard(db, asset)
        audit.record(
            db, action="infrastructure.delete", actor=user, resource_type="infrastructure_asset",
            resource_id=asset_id, message=f"Deleted {asset.code}", request=request,
        )
        db.commit()
        return ok({"message": "Asset deleted."})
    service.archive_asset(db, asset, actor_id=user.id, reason="Archived by administrator")
    audit.record(
        db, action="infrastructure.archive", actor=user, resource_type="infrastructure_asset",
        resource_id=asset.id, message=f"Archived {asset.code}", request=request,
    )
    db.commit()
    return ok({"message": f"{asset.code} archived. History is preserved."})


@router.get("/dependencies")
def list_dependencies(db: DbSession, user: CurrentUser, asset_id: int | None = None):
    rows = service.dependencies_for(db, asset_id)
    assets = {
        a.id: a
        for a in db.scalars(
            select(InfrastructureAsset).where(
                InfrastructureAsset.id.in_(
                    {d.source_asset_id for d in rows} | {d.target_asset_id for d in rows}
                )
            )
        ).all()
    }
    return ok([_dependency_row(d, assets) for d in rows])


@router.post(
    "/dependencies",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permissions("infrastructure:write"))],
)
def create_dependency(payload: DependencyCreate, request: Request, db: DbSession, user: CurrentUser):
    dep = service.create_dependency(db, payload)
    audit.record(
        db, action="dependency.create", actor=user, resource_type="infrastructure_dependency",
        resource_id=dep.id,
        message=f"Linked {payload.source_asset_id} → {payload.target_asset_id} ({payload.dependency_type})",
        request=request,
    )
    db.commit()
    return ok({"id": dep.id})


@router.delete(
    "/dependencies/{dependency_id}",
    dependencies=[Depends(require_permissions("infrastructure:write"))],
)
def delete_dependency(dependency_id: int, request: Request, db: DbSession, user: CurrentUser):
    service.delete_dependency(db, dependency_id)
    audit.record(
        db, action="dependency.delete", actor=user, resource_type="infrastructure_dependency",
        resource_id=dependency_id, message="Dependency removed", request=request,
    )
    db.commit()
    return ok({"message": "Dependency removed."})


@router.get("/twin/graph")
def twin_graph(db: DbSession, user: CurrentUser):
    assets = db.scalars(
        select(InfrastructureAsset).where(InfrastructureAsset.is_archived.is_(False))
    ).all()
    deps = db.scalars(select(InfrastructureDependency)).all()
    zones = service.list_zones(db)
    active_by_asset = dict(
        db.execute(
            select(IncidentAsset.asset_id, func.count())
            .join(Incident, Incident.id == IncidentAsset.incident_id)
            .where(Incident.status.in_(ACTIVE_INCIDENT_STATES))
            .group_by(IncidentAsset.asset_id)
        ).all()
    )
    zone_names = {z.id: z.name for z in zones}
    nodes = [
        {
            "id": a.id,
            "code": a.code,
            "name": a.name,
            "category": a.category,
            "status": a.status,
            "criticality": a.criticality,
            "map_x": a.map_x,
            "map_y": a.map_y,
            "zone": zone_names.get(a.zone_id),
            "capacity": a.capacity,
            "load_percent": a.load_percent,
            "active_incidents": active_by_asset.get(a.id, 0),
        }
        for a in assets
    ]
    ids = {a.id for a in assets}
    edges = [
        {
            "id": d.id,
            "source": d.source_asset_id,
            "target": d.target_asset_id,
            "dependency_type": d.dependency_type,
            "impact_weight": d.impact_weight,
            "redundancy": d.redundancy,
        }
        for d in deps
        if d.source_asset_id in ids and d.target_asset_id in ids
    ]
    by_status: dict[str, int] = {}
    for a in assets:
        by_status[a.status] = by_status.get(a.status, 0) + 1
    return ok(
        {
            "nodes": nodes,
            "edges": edges,
            "zones": [
                {
                    "id": z.id, "code": z.code, "name": z.name, "district": z.district,
                    "population": z.population, "center_x": z.center_x, "center_y": z.center_y,
                }
                for z in zones
            ],
            "generated_at": utcnow(),
            "stats": {"nodes": len(nodes), "edges": len(edges), "by_status": by_status},
        }
    )


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _dependency_counts(db) -> dict:
    inbound = dict(
        db.execute(
            select(InfrastructureDependency.target_asset_id, func.count()).group_by(
                InfrastructureDependency.target_asset_id
            )
        ).all()
    )
    outbound = dict(
        db.execute(
            select(InfrastructureDependency.source_asset_id, func.count()).group_by(
                InfrastructureDependency.source_asset_id
            )
        ).all()
    )
    return {"inbound": inbound, "outbound": outbound}


def _dependency_row(dep: InfrastructureDependency, assets: dict) -> dict:
    source = assets.get(dep.source_asset_id)
    target = assets.get(dep.target_asset_id)
    return {
        "id": dep.id,
        "source_asset_id": dep.source_asset_id,
        "target_asset_id": dep.target_asset_id,
        "dependency_type": dep.dependency_type,
        "impact_weight": dep.impact_weight,
        "redundancy": dep.redundancy,
        "description": dep.description,
        "created_at": dep.created_at,
        "source_code": source.code if source else "",
        "source_name": source.name if source else "",
        "target_code": target.code if target else "",
        "target_name": target.name if target else "",
    }


def _asset_dict(asset: InfrastructureAsset) -> dict:
    return {
        "id": asset.id,
        "code": asset.code,
        "name": asset.name,
        "category": asset.category,
        "category_label": CATEGORY_LABELS.get(asset.category, asset.category.replace("_", " ").title()),
        "status": asset.status,
        "criticality": asset.criticality,
        "capacity": asset.capacity,
        "capacity_unit": asset.capacity_unit,
        "load_percent": asset.load_percent,
        "latitude": asset.latitude,
        "longitude": asset.longitude,
        "map_x": asset.map_x,
        "map_y": asset.map_y,
        "zone_id": asset.zone_id,
        "zone": (
            {
                "id": asset.zone.id, "code": asset.zone.code, "name": asset.zone.name,
                "district": asset.zone.district, "population": asset.zone.population,
                "center_x": asset.zone.center_x, "center_y": asset.zone.center_y,
            }
            if asset.zone
            else None
        ),
        "built_year": asset.built_year,
        "last_inspection_at": asset.last_inspection_at,
        "notes": asset.notes,
        "is_archived": asset.is_archived,
        "created_at": asset.created_at,
        "updated_at": asset.updated_at,
    }
