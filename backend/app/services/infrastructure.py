"""Infrastructure read/write services, including graph integrity checks."""
from __future__ import annotations

from collections.abc import Sequence

import networkx as nx
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.core.responses import ApiError
from app.core.types import utcnow
from app.models.infrastructure import (
    AssetStatus,
    CityZone,
    InfrastructureAsset,
    InfrastructureDependency,
    InfrastructureStatusHistory,
)
from app.models.operations import Incident, IncidentAsset, IncidentStatus
from app.schemas.infrastructure import AssetCreate, AssetUpdate, DependencyCreate
from app.simulation.engine import AssetNode, DependencyEdge

ACTIVE_INCIDENT_STATES = (
    IncidentStatus.REPORTED,
    IncidentStatus.VERIFIED,
    IncidentStatus.PLANNING,
    IncidentStatus.APPROVED,
    IncidentStatus.IN_PROGRESS,
)


def list_assets(
    db: Session,
    *,
    search: str | None = None,
    category: str | None = None,
    status: str | None = None,
    zone_id: int | None = None,
    include_archived: bool = False,
    sort: str = "name",
    direction: str = "asc",
    offset: int = 0,
    limit: int = 20,
) -> tuple[list[InfrastructureAsset], int]:
    stmt = select(InfrastructureAsset).options(selectinload(InfrastructureAsset.zone))
    count_stmt = select(func.count()).select_from(InfrastructureAsset)
    filters = []
    if not include_archived:
        filters.append(InfrastructureAsset.is_archived.is_(False))
    if search:
        needle = f"%{search.strip().lower()}%"
        filters.append(
            or_(
                func.lower(InfrastructureAsset.name).like(needle),
                func.lower(InfrastructureAsset.code).like(needle),
                func.lower(InfrastructureAsset.notes).like(needle),
            )
        )
    if category:
        filters.append(InfrastructureAsset.category == category)
    if status:
        filters.append(InfrastructureAsset.status == status)
    if zone_id:
        filters.append(InfrastructureAsset.zone_id == zone_id)
    for f in filters:
        stmt = stmt.where(f)
        count_stmt = count_stmt.where(f)

    sort_columns = {
        "name": InfrastructureAsset.name,
        "code": InfrastructureAsset.code,
        "category": InfrastructureAsset.category,
        "status": InfrastructureAsset.status,
        "criticality": InfrastructureAsset.criticality,
        "capacity": InfrastructureAsset.capacity,
        "load_percent": InfrastructureAsset.load_percent,
        "updated_at": InfrastructureAsset.updated_at,
    }
    column = sort_columns.get(sort, InfrastructureAsset.name)
    stmt = stmt.order_by(column.desc() if direction == "desc" else column.asc())
    total = db.scalar(count_stmt) or 0
    items = db.scalars(stmt.offset(offset).limit(limit)).unique().all()
    return list(items), total


def get_asset(db: Session, asset_id: int) -> InfrastructureAsset:
    asset = db.scalar(
        select(InfrastructureAsset)
        .options(selectinload(InfrastructureAsset.zone))
        .where(InfrastructureAsset.id == asset_id)
    )
    if asset is None:
        raise ApiError("Infrastructure asset not found.", status_code=404, code="not_found")
    return asset


def create_asset(db: Session, payload: AssetCreate) -> InfrastructureAsset:
    if db.scalar(select(InfrastructureAsset).where(InfrastructureAsset.code == payload.code)):
        raise ApiError(
            f"An asset with code {payload.code} already exists.",
            status_code=409,
            code="duplicate_code",
        )
    if payload.zone_id and db.get(CityZone, payload.zone_id) is None:
        raise ApiError("Selected zone does not exist.", status_code=422, code="invalid_zone")
    asset = InfrastructureAsset(**payload.model_dump())
    db.add(asset)
    db.flush()
    db.add(
        InfrastructureStatusHistory(
            asset_id=asset.id,
            previous_status=None,
            new_status=asset.status,
            reason="Asset registered",
            changed_at=utcnow(),
        )
    )
    return asset


def update_asset(
    db: Session, asset: InfrastructureAsset, payload: AssetUpdate, actor_id: int | None
) -> InfrastructureAsset:
    data = payload.model_dump(exclude_unset=True)
    new_status = data.pop("status", None)
    for key, value in data.items():
        setattr(asset, key, value)
    asset.updated_at = utcnow()
    if new_status and new_status != asset.status:
        change_status(
            db,
            asset,
            new_status,
            reason="Updated via infrastructure management",
            actor_id=actor_id,
        )
    db.flush()
    return asset


def change_status(
    db: Session,
    asset: InfrastructureAsset,
    new_status: str,
    *,
    reason: str,
    actor_id: int | None,
    cascade: bool = True,
) -> InfrastructureAsset:
    if new_status == AssetStatus.ARCHIVED:
        archive_asset(db, asset, actor_id=actor_id, reason=reason)
        return asset
    previous = asset.status
    if previous == new_status:
        # An operator re-asserting the current state is still a statement of
        # record: "this asset is down because of its own fault, not because of
        # the feeder". Recording it keeps the audit trail truthful and lets
        # dependency recovery tell whose outage it is. Silently dropping it lost
        # that provenance. All form of the reset flows go through here.
        if previous in (AssetStatus.OFFLINE, AssetStatus.DEGRADED):
            db.add(
                InfrastructureStatusHistory(
                    asset_id=asset.id,
                    previous_status=previous,
                    new_status=new_status,
                    reason=(reason or "Status confirmed")[:300],
                    changed_by_id=actor_id,
                    changed_at=utcnow(),
                )
            )
            db.flush()
        return asset
    asset.status = new_status
    asset.updated_at = utcnow()
    db.add(
        InfrastructureStatusHistory(
            asset_id=asset.id,
            previous_status=previous,
            new_status=new_status,
            reason=reason[:300],
            changed_by_id=actor_id,
            changed_at=utcnow(),
        )
    )
    db.flush()
    if cascade:
        propagate_status(db, asset, previous=previous, actor_id=actor_id)
    return asset


# History rows that record a status this module wrote on the *target* asset are
# tagged so recovery can tell "I caused this" from "someone else caused this".
CASCADE_TAG = "[cascade] "


def _cascade_origin(db: Session, asset_id: int) -> bool:
    """Was this asset's current status written by dependency propagation?

    A status is propagation-owned when the most recent history row for the asset
    was written by propagate_status rather than by a human or a workflow. The
    marker lives in the history reason, so no new columns are needed and the
    audit trail stays the single source of truth.
    """
    latest = db.scalars(
        select(InfrastructureStatusHistory)
        .where(InfrastructureStatusHistory.asset_id == asset_id)
        .order_by(InfrastructureStatusHistory.changed_at.desc(), InfrastructureStatusHistory.id.desc())
        .limit(1)
    ).first()
    if latest is None:
        return False
    return (latest.reason or "").startswith(CASCADE_TAG)


def _status_before_cascade(db: Session, asset_id: int) -> str | None:
    """The status the asset held immediately before the cascade wrote over it."""
    rows = db.scalars(
        select(InfrastructureStatusHistory)
        .where(InfrastructureStatusHistory.asset_id == asset_id)
        .order_by(InfrastructureStatusHistory.changed_at.desc(), InfrastructureStatusHistory.id.desc())
        .limit(10)
    ).all()
    for row in rows:
        if (row.reason or "").startswith(CASCADE_TAG):
            return row.previous_status
    return None


def propagate_status(
    db: Session, asset: InfrastructureAsset, *, previous: str, actor_id: int | None
) -> list[dict]:
    """Reflect an upstream failure on directly dependent assets.

    This is *not* the simulation engine: it is the live operational consequence
    of an authorised status change. Direct dependents with no redundancy are
    marked degraded/offline so the digital twin stays truthful.
    """
    affected: list[dict] = []
    dependents = db.scalars(
        select(InfrastructureDependency).where(
            InfrastructureDependency.source_asset_id == asset.id
        )
    ).all()
    going_down = asset.status in (AssetStatus.OFFLINE,)
    for dep in dependents:
        target = db.get(InfrastructureAsset, dep.target_asset_id)
        if target is None or target.is_archived:
            continue
        if going_down:
            residual = (1 - dep.impact_weight) + dep.redundancy
            target_status = (
                AssetStatus.OFFLINE
                if residual < 0.2
                else AssetStatus.DEGRADED
                if residual < 0.75
                else target.status
            )
        elif previous == AssetStatus.OFFLINE and asset.status == AssetStatus.OPERATIONAL:
            # Recovery must not touch a dependent that is down for its own reason.
            # Only a status this propagation wrote (or a degraded asset, which can
            # only have been degraded by a cascade -- degrade is not user settable)
            # is ours to clear. Without this test, restoring a feeder claimed an
            # unrelated hospital outage had been fixed.
            ours = _cascade_origin(db, target.id)
            if not (ours or target.status == AssetStatus.DEGRADED):
                continue
            # Restore to what the asset was before the cascade, not to a state this
            # function invents. The asset may have been in scheduled maintenance;
            # promoting it to operational silently cancelled that work.
            restored = _status_before_cascade(db, target.id)
            if restored is None or restored not in (
                AssetStatus.OPERATIONAL,
                AssetStatus.MAINTENANCE,
            ):
                restored = AssetStatus.OPERATIONAL
            if restored == target.status:
                continue
            target_status = restored
        else:
            continue
        if target_status != target.status:
            db.add(
                InfrastructureStatusHistory(
                    asset_id=target.id,
                    previous_status=target.status,
                    new_status=target_status,
                    reason=f"{CASCADE_TAG}{asset.code} ({target.status} -> {target_status})",
                    changed_by_id=actor_id,
                    changed_at=utcnow(),
                )
            )
            affected.append(
                {
                    "asset_id": target.id,
                    "code": target.code,
                    "from": target.status,
                    "to": target_status,
                }
            )
            target.status = target_status
            target.updated_at = utcnow()
    db.flush()
    return affected


def archive_asset(
    db: Session, asset: InfrastructureAsset, *, actor_id: int | None, reason: str
) -> InfrastructureAsset:
    open_incidents = db.scalar(
        select(func.count())
        .select_from(Incident)
        .where(Incident.primary_asset_id == asset.id, Incident.status.in_(ACTIVE_INCIDENT_STATES))
    )
    if open_incidents:
        raise ApiError(
            "This asset is referenced by an open incident and cannot be archived yet.",
            status_code=409,
            code="asset_in_use",
        )
    previous = asset.status
    asset.is_archived = True
    asset.status = AssetStatus.ARCHIVED
    asset.updated_at = utcnow()
    db.add(
        InfrastructureStatusHistory(
            asset_id=asset.id,
            previous_status=previous,
            new_status=AssetStatus.ARCHIVED,
            reason=reason[:300],
            changed_by_id=actor_id,
            changed_at=utcnow(),
        )
    )
    db.flush()
    return asset


def delete_asset_hard(db: Session, asset: InfrastructureAsset) -> None:
    """Only allowed for assets with no operational history."""

    has_history = db.scalar(
        select(func.count())
        .select_from(InfrastructureStatusHistory)
        .where(InfrastructureStatusHistory.asset_id == asset.id)
    )
    has_incident = db.scalar(
        select(func.count()).select_from(IncidentAsset).where(IncidentAsset.asset_id == asset.id)
    )
    if (has_history or 0) > 1 or (has_incident or 0) > 0:
        raise ApiError(
            "Assets with operational history must be archived instead of deleted.",
            status_code=409,
            code="asset_has_history",
        )
    db.delete(asset)
    db.flush()


def list_zones(db: Session) -> list[CityZone]:
    return list(db.scalars(select(CityZone).order_by(CityZone.name)).all())


def dependencies_for(db: Session, asset_id: int | None = None) -> list[InfrastructureDependency]:
    stmt = select(InfrastructureDependency)
    if asset_id is not None:
        stmt = stmt.where(
            or_(
                InfrastructureDependency.source_asset_id == asset_id,
                InfrastructureDependency.target_asset_id == asset_id,
            )
        )
    return list(db.scalars(stmt).all())


def create_dependency(db: Session, payload: DependencyCreate) -> InfrastructureDependency:
    source = db.get(InfrastructureAsset, payload.source_asset_id)
    target = db.get(InfrastructureAsset, payload.target_asset_id)
    if source is None or target is None:
        raise ApiError("Both assets must exist.", status_code=422, code="invalid_asset")
    if source.id == target.id:
        raise ApiError("An asset cannot depend on itself.", status_code=422, code="self_dependency")
    existing = db.scalar(
        select(InfrastructureDependency).where(
            InfrastructureDependency.source_asset_id == payload.source_asset_id,
            InfrastructureDependency.target_asset_id == payload.target_asset_id,
        )
    )
    if existing:
        raise ApiError(
            "That dependency already exists.", status_code=409, code="duplicate_dependency"
        )
    graph = build_graph_from_db(db)
    if nx.has_path(graph, payload.target_asset_id, payload.source_asset_id):
        raise ApiError(
            "This link would create a circular dependency. Break the existing chain first.",
            status_code=422,
            code="circular_dependency",
        )
    dep = InfrastructureDependency(**payload.model_dump())
    db.add(dep)
    db.flush()
    return dep


def delete_dependency(db: Session, dependency_id: int) -> None:
    dep = db.get(InfrastructureDependency, dependency_id)
    if dep is None:
        raise ApiError("Dependency not found.", status_code=404, code="not_found")
    db.delete(dep)
    db.flush()


def build_graph_from_db(db: Session) -> nx.DiGraph:
    graph = nx.DiGraph()
    assets = db.scalars(
        select(InfrastructureAsset).where(InfrastructureAsset.is_archived.is_(False))
    ).all()
    for asset in assets:
        graph.add_node(asset.id, code=asset.code)
    for dep in db.scalars(select(InfrastructureDependency)).all():
        if dep.source_asset_id in graph and dep.target_asset_id in graph:
            graph.add_edge(dep.source_asset_id, dep.target_asset_id)
    return graph


def simulation_inputs(
    db: Session, *, exclude_archived: bool = True
) -> tuple[list[AssetNode], list[DependencyEdge]]:
    stmt = select(InfrastructureAsset)
    if exclude_archived:
        stmt = stmt.where(InfrastructureAsset.is_archived.is_(False))
    assets = db.scalars(stmt).all()
    nodes = [
        AssetNode(
            id=a.id,
            code=a.code,
            name=a.name,
            category=a.category,
            criticality=a.criticality,
            status=a.status,
            capacity=a.capacity,
            load_percent=a.load_percent,
            map_x=a.map_x,
            map_y=a.map_y,
        )
        for a in assets
    ]
    ids = {a.id for a in assets}
    edges = [
        DependencyEdge(
            source=d.source_asset_id,
            target=d.target_asset_id,
            impact_weight=d.impact_weight,
            redundancy=d.redundancy,
            dependency_type=d.dependency_type,
        )
        for d in db.scalars(select(InfrastructureDependency)).all()
        if d.source_asset_id in ids and d.target_asset_id in ids
    ]
    return nodes, edges


def status_history(db: Session, asset_id: int, limit: int = 25) -> Sequence[InfrastructureStatusHistory]:
    return db.scalars(
        select(InfrastructureStatusHistory)
        .where(InfrastructureStatusHistory.asset_id == asset_id)
        .order_by(InfrastructureStatusHistory.changed_at.desc())
        .limit(limit)
    ).all()
