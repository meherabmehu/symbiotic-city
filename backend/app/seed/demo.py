"""Seeds the synthetic Aurora Vale demo dataset.

The seed is idempotent: it only fills tables that are empty, so restarting the
API never duplicates data. A fixed random seed is used for the jittered field
values in the historical records, which keeps the analytics reproducible.
"""
from __future__ import annotations

import json
import random
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.permissions import (
    PERMISSIONS,
    ROLE_DESCRIPTIONS,
    ROLE_LABELS,
    ROLE_PERMISSIONS,
    Role,
)
from app.core.security import hash_password
from app.core.types import utcnow
from app.models.identity import Permission, Role as RoleModel, SystemSetting, User
from app.models.infrastructure import (
    AssetStatus,
    CityZone,
    InfrastructureAsset,
    InfrastructureDependency,
    InfrastructureStatusHistory,
)
from app.models.operations import (
    Incident,
    IncidentAsset,
    IncidentEvent,
    IncidentStatus,
    RepairTask,
    Resource,
    TaskStatus,
    TaskStatusHistory,
)
from app.models.system import Notification
from app.seed import catalog
from app.services import notifications as notify

RNG = random.Random(20260101)


def seed_roles_and_permissions(db: Session) -> None:
    existing = {p.key: p for p in db.scalars(select(Permission)).all()}
    for key, description in PERMISSIONS.items():
        if key not in existing:
            perm = Permission(key=key, description=description)
            db.add(perm)
            existing[key] = perm
    db.flush()

    roles = {r.key: r for r in db.scalars(select(RoleModel)).all()}
    for role_key in [r.value for r in Role]:
        if role_key not in roles:
            role = RoleModel(
                key=role_key,
                name=ROLE_LABELS[role_key],
                description=ROLE_DESCRIPTIONS[role_key],
            )
            db.add(role)
            roles[role_key] = role
    db.flush()
    for role_key, permission_keys in ROLE_PERMISSIONS.items():
        role = roles[role_key]
        role.permissions = [existing[k] for k in sorted(permission_keys) if k in existing]
    db.flush()


def seed_users(db: Session) -> dict[str, User]:
    roles = {r.key: r for r in db.scalars(select(RoleModel)).all()}
    users: dict[str, User] = {}
    for spec in catalog.USERS:
        user = db.scalar(select(User).where(User.email == spec["email"]))
        if user is None:
            user = User(
                email=spec["email"],
                full_name=spec["full_name"],
                password_hash=hash_password(spec["password"]),
                job_title=spec["job_title"],
                phone=spec["phone"],
                avatar_color=spec["avatar_color"],
                roles=[roles[spec["role"]]],
            )
            db.add(user)
            db.flush()
        users[spec["role"] + ":" + spec["email"]] = user
    db.flush()
    return users


def seed_settings(db: Session) -> None:
    if db.scalar(select(func.count()).select_from(SystemSetting)):
        return
    for spec in catalog.SYSTEM_SETTINGS:
        db.add(SystemSetting(**spec))
    db.flush()


def seed_infrastructure(db: Session) -> tuple[dict[str, InfrastructureAsset], dict[str, CityZone]]:
    zones: dict[str, CityZone] = {}
    for spec in catalog.ZONES:
        zone = db.scalar(select(CityZone).where(CityZone.code == spec["code"]))
        if zone is None:
            zone = CityZone(**spec)
            db.add(zone)
        zones[spec["code"]] = zone
    db.flush()

    assets: dict[str, InfrastructureAsset] = {}
    for (
        code,
        name,
        category,
        zone_code,
        criticality,
        capacity,
        unit,
        load,
        lat,
        lon,
        x,
        y,
        year,
    ) in catalog.ASSETS:
        asset = db.scalar(select(InfrastructureAsset).where(InfrastructureAsset.code == code))
        if asset is None:
            asset = InfrastructureAsset(
                code=code,
                name=name,
                category=category,
                zone_id=zones[zone_code].id,
                status=AssetStatus.OPERATIONAL,
                criticality=criticality,
                capacity=float(capacity),
                capacity_unit=unit,
                load_percent=float(load),
                latitude=lat,
                longitude=lon,
                map_x=float(x),
                map_y=float(y),
                built_year=year,
                notes=catalog.ASSET_NOTES.get(code),
                last_inspection_at=utcnow() - timedelta(days=RNG.randint(5, 180)),
            )
            db.add(asset)
        assets[code] = asset
    db.flush()

    if not db.scalar(select(func.count()).select_from(InfrastructureDependency)):
        for source, target, kind, weight, redundancy, description in catalog.DEPENDENCIES:
            db.add(
                InfrastructureDependency(
                    source_asset_id=assets[source].id,
                    target_asset_id=assets[target].id,
                    dependency_type=kind,
                    impact_weight=weight,
                    redundancy=redundancy,
                    description=description,
                )
            )
    db.flush()

    # one historical status change per asset so history/analytics are not empty
    if not db.scalar(select(func.count()).select_from(InfrastructureStatusHistory)):
        for asset in assets.values():
            db.add(
                InfrastructureStatusHistory(
                    asset_id=asset.id,
                    previous_status=AssetStatus.MAINTENANCE,
                    new_status=AssetStatus.OPERATIONAL,
                    reason="Scheduled maintenance completed",
                    changed_at=utcnow() - timedelta(days=RNG.randint(10, 120)),
                )
            )
    db.flush()
    return assets, zones


def seed_resources(db: Session, zones: dict[str, CityZone]) -> dict[str, Resource]:
    resources: dict[str, Resource] = {}
    for code, name, category, capacity, unit, cost, mob, zone_code in catalog.RESOURCES:
        resource = db.scalar(select(Resource).where(Resource.code == code))
        if resource is None:
            resource = Resource(
                code=code,
                name=name,
                category=category,
                capacity=capacity,
                capacity_unit=unit,
                status="available",
                home_zone_id=zones[zone_code].id,
                hourly_cost=cost,
                mobilisation_minutes=mob,
            )
            db.add(resource)
        resources[code] = resource
    db.flush()
    return resources


def seed_historical_incidents(
    db: Session,
    assets: dict[str, InfrastructureAsset],
    users: dict[str, User],
) -> None:
    """A small, deterministic history so analytics and audit pages have data."""
    if db.scalar(select(func.count()).select_from(Incident)):
        return
    operator = users["city_operator:operator@symbiotic.city"]
    engineer = users["field_engineer:engineer@symbiotic.city"]
    analyst = users["city_analyst:analyst@symbiotic.city"]
    now = utcnow()

    history = [
        {
            "code": "INC-0001",
            "title": "River intake pump trips on voltage sag",
            "asset": "WP-01",
            "severity": "high",
            "status": IncidentStatus.RESOLVED,
            "days_ago": 21,
            "description": (
                "Voltage sag on the Riverside feeder tripped the raw water intake pumps. "
                "Treatment output fell for 90 minutes while the crews restarted the pumps."
            ),
            "resolution": "Pump control panel reset, feeder inspected, status restored to operational.",
        },
        {
            "code": "INC-0002",
            "title": "Eastfield substation transformer overheating",
            "asset": "SS-03",
            "severity": "medium",
            "status": IncidentStatus.RESOLVED,
            "days_ago": 12,
            "description": "Transformer T2 exceeded 95C under peak load; load was shifted to T1.",
            "resolution": "Cooling fans replaced and load rebalanced across both transformers.",
        },
        {
            "code": "INC-0003",
            "title": "School power quality complaint",
            "asset": "SC-01",
            "severity": "low",
            "status": IncidentStatus.RESOLVED,
            "days_ago": 6,
            "description": "Flickering lights reported in the east wing of the model school.",
            "resolution": "Loose neutral connection tightened at the service panel.",
        },
        {
            "code": "INC-0004",
            "title": "Southbank booster pump bearing noise",
            "asset": "WP-03",
            "severity": "low",
            "status": IncidentStatus.CANCELLED,
            "days_ago": 3,
            "description": "Operator reported bearing noise; inspection found it within tolerance.",
            "resolution": None,
        },
    ]

    for idx, item in enumerate(history):
        reported = now - timedelta(days=item["days_ago"], hours=RNG.randint(1, 8))
        asset = assets[item["asset"]]
        incident = Incident(
            code=item["code"],
            title=item["title"],
            description=item["description"],
            category="infrastructure_fault",
            severity=item["severity"],
            status=item["status"],
            primary_asset_id=asset.id,
            reported_by_id=operator.id,
            assigned_operator_id=operator.id,
            affected_population=RNG.randint(2_000, 12_000),
            reported_at=reported,
            created_at=reported,
            resolved_at=reported + timedelta(hours=RNG.randint(3, 30))
            if item["status"] == IncidentStatus.RESOLVED
            else None,
            cancelled_at=reported + timedelta(hours=2)
            if item["status"] == IncidentStatus.CANCELLED
            else None,
            resolution_notes=item["resolution"],
        )
        db.add(incident)
        db.flush()
        db.add(
            IncidentAsset(
                incident_id=incident.id,
                asset_id=asset.id,
                impact_level="failed",
                impact_score=1.0,
            )
        )
        steps = [
            ("created", None, IncidentStatus.REPORTED, f"Incident {item['code']} reported."),
            ("status_change", IncidentStatus.REPORTED, IncidentStatus.VERIFIED, "Verified by duty operator."),
        ]
        if item["status"] == IncidentStatus.CANCELLED:
            steps.append(
                ("status_change", IncidentStatus.VERIFIED, IncidentStatus.CANCELLED, "Stood down after inspection.")
            )
        else:
            steps += [
                ("status_change", IncidentStatus.VERIFIED, IncidentStatus.PLANNING, "Recovery planning started."),
                ("status_change", IncidentStatus.PLANNING, IncidentStatus.APPROVED, "Plan approved by watch commander."),
                ("status_change", IncidentStatus.APPROVED, IncidentStatus.IN_PROGRESS, "Crew dispatched."),
                ("status_change", IncidentStatus.IN_PROGRESS, IncidentStatus.RESOLVED, item["resolution"] or "Resolved."),
            ]
        for offset, (etype, frm, to, message) in enumerate(steps):
            db.add(
                IncidentEvent(
                    incident_id=incident.id,
                    event_type=etype,
                    from_status=frm,
                    to_status=to,
                    message=message,
                    actor_id=operator.id,
                    created_at=reported + timedelta(minutes=40 * offset),
                )
            )
        if item["status"] == IncidentStatus.RESOLVED:
            task = RepairTask(
                code=f"TASK-{1000 + idx}",
                title=f"Restore {asset.name}",
                description=f"Repair task for {item['code']}: {item['resolution']}",
                status=TaskStatus.VERIFIED,
                priority={"critical": 1, "high": 2, "medium": 3, "low": 4}[item["severity"]],
                incident_id=incident.id,
                asset_id=asset.id,
                assignee_id=engineer.id,
                created_by_id=operator.id,
                verification_by_id=operator.id,
                estimated_hours=2.0 + idx,
                actual_hours=1.5 + idx,
                assigned_at=reported + timedelta(minutes=30),
                accepted_at=reported + timedelta(minutes=55),
                started_at=reported + timedelta(hours=1),
                completed_at=reported + timedelta(hours=3 + idx),
                verified_at=reported + timedelta(hours=4 + idx),
                completion_notes="Repair completed and tested. Asset returned to service.",
                created_at=reported + timedelta(minutes=30),
            )
            db.add(task)
            db.flush()
            for frm, to in [
                (None, TaskStatus.ASSIGNED),
                (TaskStatus.ASSIGNED, TaskStatus.ACCEPTED),
                (TaskStatus.ACCEPTED, TaskStatus.IN_PROGRESS),
                (TaskStatus.IN_PROGRESS, TaskStatus.COMPLETED),
                (TaskStatus.COMPLETED, TaskStatus.VERIFIED),
            ]:
                db.add(
                    TaskStatusHistory(
                        task_id=task.id,
                        from_status=frm,
                        to_status=to,
                        note="Historical demo record",
                        actor_id=engineer.id if to != TaskStatus.VERIFIED else operator.id,
                        changed_at=reported + timedelta(hours=1),
                    )
                )
    db.flush()

    # a live, in-flight incident for the demo dashboards
    live = Incident(
        code="INC-0005",
        title="Central substation feeder 3 overload",
        description=(
            "Feeder 3 at the Central 132kV substation is running at 108% of rating during the "
            "evening peak. The hospital's secondary feed is on the same feeder."
        ),
        category="power_outage",
        severity="high",
        status=IncidentStatus.PLANNING,
        primary_asset_id=assets["SS-01"].id,
        reported_by_id=operator.id,
        assigned_operator_id=operator.id,
        affected_population=9_400,
        reported_at=now - timedelta(hours=5),
        created_at=now - timedelta(hours=5),
    )
    db.add(live)
    db.flush()
    db.add(
        IncidentAsset(
            incident_id=live.id, asset_id=assets["SS-01"].id, impact_level="degraded", impact_score=0.62
        )
    )
    db.add(
        IncidentAsset(
            incident_id=live.id, asset_id=assets["HO-01"].id, impact_level="affected", impact_score=0.31
        )
    )
    db.add(
        IncidentEvent(
            incident_id=live.id,
            event_type="created",
            from_status=None,
            to_status=IncidentStatus.REPORTED,
            message="Overload alarm raised by SCADA bridge.",
            actor_id=operator.id,
            created_at=now - timedelta(hours=5),
        )
    )
    db.add(
        IncidentEvent(
            incident_id=live.id,
            event_type="status_change",
            from_status=IncidentStatus.REPORTED,
            to_status=IncidentStatus.VERIFIED,
            message="Verified against telemetry; load transfer under review.",
            actor_id=operator.id,
            created_at=now - timedelta(hours=4, minutes=20),
        )
    )
    db.add(
        IncidentEvent(
            incident_id=live.id,
            event_type="status_change",
            from_status=IncidentStatus.VERIFIED,
            to_status=IncidentStatus.PLANNING,
            message="Analyst asked to model a feeder trip before dispatch.",
            actor_id=analyst.id,
            created_at=now - timedelta(hours=3),
        )
    )
    db.add(
        IncidentEvent(
            incident_id=live.id,
            event_type="comment",
            from_status=None,
            to_status=None,
            message="Hospital confirmed its diesel set is at 70% fuel.",
            actor_id=operator.id,
            created_at=now - timedelta(hours=1),
        )
    )
    db.flush()

    for code in ("HO-01", "SS-01", "CM-01"):
        notify.push(
            db,
            user_id=operator.id,
            title="Open incident needs attention",
            body=f"INC-0005 is in planning and references {code}.",
            category="incident",
            severity="warning",
            link="/incidents",
            entity_type="incident",
            entity_id=live.id,
        )


def seed_notifications_for_all(db: Session, users: dict[str, User]) -> None:
    if db.scalar(select(func.count()).select_from(Notification)):
        return
    analyst = users["city_analyst:analyst@symbiotic.city"]
    engineer = users["field_engineer:engineer@symbiotic.city"]
    admin = users["super_admin:admin@symbiotic.city"]
    notify.push(
        db,
        user_id=analyst.id,
        title="Simulation engine ready",
        body="Aurora Vale twin loaded with 23 assets and 24 dependency links. Run a cascade test to begin.",
        category="simulation",
        severity="info",
        link="/simulation",
    )
    notify.push(
        db,
        user_id=engineer.id,
        title="2 tasks awaiting acceptance",
        body="You have repair tasks assigned in the engineer workspace.",
        category="task",
        severity="info",
        link="/my-tasks",
    )
    notify.push(
        db,
        user_id=admin.id,
        title="Demo dataset seeded",
        body="Synthetic Aurora Vale data has been loaded. All figures are fictional.",
        category="system",
        severity="info",
        link="/admin/audit",
    )
    db.flush()


def seed_all(db: Session) -> dict:
    seed_roles_and_permissions(db)
    users = seed_users(db)
    seed_settings(db)
    assets, zones = seed_infrastructure(db)
    resources = seed_resources(db, zones)
    seed_historical_incidents(db, assets, users)
    seed_notifications_for_all(db, users)
    db.commit()
    return {
        "users": len(catalog.USERS),
        "zones": len(catalog.ZONES),
        "assets": len(catalog.ASSETS),
        "dependencies": len(catalog.DEPENDENCIES),
        "resources": len(catalog.RESOURCES),
        "incidents": db.scalar(select(func.count()).select_from(Incident)) or 0,
    }


def demo_demand_payload(assets: dict[str, InfrastructureAsset]) -> list[dict]:
    """Demand set used by the A02 '3 customers, 2 generators' demonstration."""
    payload = []
    for code, need, priority, eligible, window, hours in catalog.DEMO_DEMAND:
        payload.append(
            {
                "asset_id": assets[code].id,
                "asset_code": code,
                "asset_name": assets[code].name,
                "need": need,
                "priority": priority,
                "eligible_categories": eligible,
                "service_window_minutes": window,
                "estimated_hours": hours,
            }
        )
    return payload


def as_json(value) -> str:  # small helper used by services
    return json.dumps(value, default=str)
