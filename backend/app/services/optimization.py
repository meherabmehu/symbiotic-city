"""Optimisation orchestration: demand assembly, solver call, plan persistence."""
from __future__ import annotations

import json

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.responses import ApiError
from app.core.types import utcnow
from app.models.infrastructure import CATEGORY_PRIORITY, InfrastructureAsset
from app.models.operations import (
    Incident,
    RepairTask,
    ReservationStatus,
    Resource,
    ResourceReservation,
    TaskStatus,
)
from app.models.optimization import (
    OptimizationAssignment,
    OptimizationPlan,
    OptimizationRequest,
)
from app.models.simulation import SimulationResult, SimulationRun
from app.optimization.engine import (
    INFEASIBLE,
    Demand,
    OptimizationInput,
    ResourceOption,
    optimize,
)
from app.schemas.optimization import OptimizationSubmitRequest
from app.seed.catalog import RESOURCE_ELIGIBILITY
from app.services import infrastructure as infra_service


def next_request_code(db: Session) -> str:
    count = db.scalar(select(func.count()).select_from(OptimizationRequest)) or 0
    return f"OPT-{count + 1:04d}"


def next_plan_code(db: Session) -> str:
    count = db.scalar(select(func.count()).select_from(OptimizationPlan)) or 0
    return f"PLAN-{count + 1:04d}"


def _resource_pool(db: Session, resource_ids: list[int] | None) -> list[Resource]:
    stmt = select(Resource).where(Resource.is_archived.is_(False))
    if resource_ids:
        stmt = stmt.where(Resource.id.in_(resource_ids))
    return list(db.scalars(stmt).all())


def _available_quantity(db: Session, resource: Resource) -> float:
    reserved = db.scalar(
        select(func.coalesce(func.sum(ResourceReservation.quantity), 0)).where(
            ResourceReservation.resource_id == resource.id,
            ResourceReservation.status == ReservationStatus.RESERVED,
        )
    )
    available = float(resource.capacity) - float(reserved or 0)
    if resource.status in ("maintenance", "unavailable"):
        return 0.0
    return max(0.0, round(available, 2))


def build_demands(
    db: Session, payload: OptimizationSubmitRequest, overrides: dict | None = None
) -> list[Demand]:
    demands: list[Demand] = []
    for item in payload.demands:
        asset = db.get(InfrastructureAsset, item.asset_id)
        if asset is None or asset.is_archived:
            raise ApiError(
                "A demand references an asset that is unavailable.",
                status_code=422,
                code="invalid_asset",
                details={"asset_id": item.asset_id},
            )
        data = item.model_dump()
        if overrides and asset.code in overrides:
            data.update(overrides[asset.code])
        demands.append(
            Demand(
                asset_id=asset.id,
                asset_code=asset.code,
                asset_name=asset.name,
                category=asset.category,
                need=data["need"],
                priority=data["priority"],
                population=_population_weight(asset),
                eligible_categories=data["eligible_categories"],
                service_window_minutes=data["service_window_minutes"],
                estimated_hours=data["estimated_hours"],
            )
        )
    return demands


def _population_weight(asset: InfrastructureAsset) -> int:
    from app.models.infrastructure import CATEGORY_POPULATION_WEIGHT

    return CATEGORY_POPULATION_WEIGHT.get(asset.category, 500) * max(1, asset.criticality)


def build_resource_options(db: Session, resource_ids: list[int] | None) -> list[ResourceOption]:
    options: list[ResourceOption] = []
    for resource in _resource_pool(db, resource_ids):
        options.append(
            ResourceOption(
                resource_id=resource.id,
                code=resource.code,
                name=resource.name,
                category=resource.category,
                available=_available_quantity(db, resource),
                hourly_cost=resource.hourly_cost,
                mobilisation_minutes=resource.mobilisation_minutes,
                serves_categories=RESOURCE_ELIGIBILITY.get(resource.category, []),
            )
        )
    return options


def solve(
    db: Session,
    payload: OptimizationSubmitRequest,
    *,
    overrides: dict | None = None,
    must_serve_priority: int | None = None,
    horizon_hours: float | None = None,
) -> OptimizationInput | tuple[OptimizationInput, object]:
    demands = build_demands(db, payload, overrides)
    resources = build_resource_options(db, payload.resource_ids)
    if payload.force_infeasible_demo:
        demands = [
            Demand(
                asset_id=d.asset_id,
                asset_code=d.asset_code,
                asset_name=d.asset_name,
                category=d.category,
                need=d.need * 4,
                priority=d.priority,
                population=d.population,
                eligible_categories=d.eligible_categories,
                service_window_minutes=d.service_window_minutes,
                estimated_hours=d.estimated_hours,
            )
            for d in demands
        ]
    input_ = OptimizationInput(
        demands=demands,
        resources=resources,
        horizon_hours=horizon_hours if horizon_hours is not None else payload.horizon_hours,
        must_serve_priority=must_serve_priority
        if must_serve_priority is not None
        else payload.must_serve_priority,
        max_assignments_per_demand=payload.max_assignments_per_demand,
    )
    return input_, optimize(input_)


def preview(
    db: Session,
    payload: OptimizationSubmitRequest,
    overrides: dict | None = None,
    must_serve_priority: int | None = None,
) -> dict:
    """Run the solver without persisting anything (plan comparison view)."""
    input_, result = solve(
        db, payload, overrides=overrides, must_serve_priority=must_serve_priority
    )
    return {
        "result": result.as_dict(),
        "resources": [
            {
                "resource_id": r.resource_id,
                "code": r.code,
                "name": r.name,
                "category": r.category,
                "available": r.available,
                "mobilisation_minutes": r.mobilisation_minutes,
                "hourly_cost": r.hourly_cost,
            }
            for r in input_.resources
        ],
        "demands": [
            {
                "asset_id": d.asset_id,
                "asset_code": d.asset_code,
                "asset_name": d.asset_name,
                "category": d.category,
                "need": d.need,
                "priority": d.priority,
            }
            for d in input_.demands
        ],
    }


def create_request_and_plan(
    db: Session,
    payload: OptimizationSubmitRequest,
    *,
    actor_id: int | None,
    overrides: dict | None = None,
    must_serve_priority: int | None = None,
) -> tuple[OptimizationRequest, OptimizationPlan, dict]:
    input_, result = solve(
        db, payload, overrides=overrides, must_serve_priority=must_serve_priority
    )
    request = OptimizationRequest(
        code=next_request_code(db),
        title=payload.title,
        objective=payload.objective,
        incident_id=payload.incident_id,
        simulation_run_id=payload.simulation_run_id,
        status="solved",
        demand_json=json.dumps(
            [
                {
                    "asset_id": d.asset_id,
                    "asset_code": d.asset_code,
                    "asset_name": d.asset_name,
                    "need": d.need,
                    "priority": d.priority,
                    "eligible_categories": d.eligible_categories,
                    "service_window_minutes": d.service_window_minutes,
                    "estimated_hours": d.estimated_hours,
                }
                for d in input_.demands
            ]
        ),
        constraint_json=json.dumps(
            {
                "horizon_hours": input_.horizon_hours,
                "must_serve_priority": input_.must_serve_priority,
                "max_assignments_per_demand": input_.max_assignments_per_demand,
                "resource_ids": payload.resource_ids,
                "force_infeasible_demo": payload.force_infeasible_demo,
            }
        ),
        requested_by_id=actor_id,
    )
    db.add(request)
    db.flush()

    plan = OptimizationPlan(
        code=next_plan_code(db),
        request_id=request.id,
        status="proposed" if result.status != INFEASIBLE else "infeasible",
        solution_status=result.status,
        objective_value=result.objective_value,
        covered_demand=result.covered_demand,
        total_demand=result.total_demand,
        coverage_percent=round(result.coverage_percent, 2),
        solver_wall_ms=result.wall_ms,
        explanation_json=json.dumps(
            {
                "steps": result.explanation,
                "debug": result.debug,
                "unserved": result.unserved,
                "resource_usage": result.resource_usage,
                "demands": json.loads(request.demand_json),
                "constraints": json.loads(request.constraint_json),
            }
        ),
        infeasibility_reason=result.infeasibility_reason,
    )
    db.add(plan)
    db.flush()

    if result.status != INFEASIBLE:
        for row in result.assignments:
            asset = db.get(InfrastructureAsset, row.asset_id)
            priority = CATEGORY_PRIORITY.get(asset.category, 5) if asset else 5
            db.add(
                OptimizationAssignment(
                    plan_id=plan.id,
                    asset_id=row.asset_id,
                    resource_id=row.resource_id,
                    quantity=row.quantity,
                    priority_weight=priority,
                    contribution=row.contribution,
                    served=True,
                    rationale=row.rationale,
                )
            )
        plan.total_demand = len(input_.demands)
        plan.covered_demand = len({row.asset_id for row in result.assignments})
        plan.coverage_percent = round(
            100.0 * plan.covered_demand / max(1, plan.total_demand), 2
        )
    db.flush()
    return request, plan, result.as_dict()


def plan_to_dict(db: Session, plan: OptimizationPlan, *, detail: bool = False) -> dict:
    request = db.get(OptimizationRequest, plan.request_id)
    assignments = db.scalars(
        select(OptimizationAssignment).where(OptimizationAssignment.plan_id == plan.id)
    ).all()
    explanation = json.loads(plan.explanation_json or "{}")
    base = {
        "id": plan.id,
        "code": plan.code,
        "status": plan.status,
        "solution_status": plan.solution_status,
        "objective_value": plan.objective_value,
        "covered_demand": plan.covered_demand,
        "total_demand": plan.total_demand,
        "coverage_percent": plan.coverage_percent,
        "solver_wall_ms": plan.solver_wall_ms,
        "infeasibility_reason": plan.infeasibility_reason,
        "approved_at": plan.approved_at,
        "approved_by_id": plan.approved_by_id,
        "created_at": plan.created_at,
        "assignments": [
            {
                "id": a.id,
                "asset_id": a.asset_id,
                "resource_id": a.resource_id,
                "quantity": a.quantity,
                "priority_weight": a.priority_weight,
                "contribution": a.contribution,
                "served": a.served,
                "rationale": a.rationale,
                "repair_task_id": a.repair_task_id,
            }
            for a in assignments
        ],
    }
    if detail:
        asset_ids = {a.asset_id for a in assignments}
        resource_ids = {a.resource_id for a in assignments}
        assets = {
            a.id: a
            for a in db.scalars(
                select(InfrastructureAsset).where(InfrastructureAsset.id.in_(asset_ids or {0}))
            ).all()
        }
        resources = {
            r.id: r
            for r in db.scalars(select(Resource).where(Resource.id.in_(resource_ids or {0}))).all()
        }
        for row in base["assignments"]:
            asset = assets.get(row["asset_id"])
            resource = resources.get(row["resource_id"])
            row["asset_code"] = asset.code if asset else str(row["asset_id"])
            row["asset_name"] = asset.name if asset else "Unknown asset"
            row["asset_category"] = asset.category if asset else "unknown"
            row["resource_code"] = resource.code if resource else str(row["resource_id"])
            row["resource_name"] = resource.name if resource else "Unknown resource"
        base["explanation"] = explanation
        base["request"] = (
            {
                "id": request.id,
                "code": request.code,
                "title": request.title,
                "objective": request.objective,
                "status": request.status,
                "incident_id": request.incident_id,
                "simulation_run_id": request.simulation_run_id,
                "requested_by_id": request.requested_by_id,
                "created_at": request.created_at,
            }
            if request
            else {}
        )
        from app.models.workflow import WorkflowInstance

        workflow = db.scalar(select(WorkflowInstance).where(WorkflowInstance.plan_id == plan.id))
        base["workflow_id"] = workflow.id if workflow else None
    return base


def list_plans(
    db: Session, *, status: str | None = None, offset: int = 0, limit: int = 20
) -> tuple[list[OptimizationPlan], int]:
    stmt = select(OptimizationPlan)
    count_stmt = select(func.count()).select_from(OptimizationPlan)
    if status:
        stmt = stmt.where(OptimizationPlan.status == status)
        count_stmt = count_stmt.where(OptimizationPlan.status == status)
    total = db.scalar(count_stmt) or 0
    items = db.scalars(
        stmt.order_by(OptimizationPlan.created_at.desc()).offset(offset).limit(limit)
    ).all()
    return list(items), total


# Assets that can actually be served by a mobile generator.
BACKUP_POWER_CATEGORIES: set[str] = {
    "hospital",
    "water_treatment",
    "water_pump",
    "telecom",
    "residential",
    "school",
    "commercial",
}

# Typical backup-power requirement per asset category, in kVA.
BACKUP_KVA_PER_ASSET: dict[str, float] = {
    "hospital": 55.0,
    "water_treatment": 45.0,
    "water_pump": 30.0,
    "telecom": 22.0,
    "residential": 15.0,
    "school": 12.0,
    "commercial": 10.0,
    "substation": 25.0,
    "power_station": 40.0,
}


def demands_from_simulation(db: Session, run_id: int, default_hours: float = 2.0) -> list[dict]:
    run = db.get(SimulationRun, run_id)
    if run is None:
        raise ApiError("Simulation run not found.", status_code=404, code="not_found")
    rows = db.scalars(
        select(SimulationResult)
        .where(SimulationResult.run_id == run_id, SimulationResult.impact_level != "affected")
        .order_by(SimulationResult.depth)
    ).all()
    demands: list[dict] = []
    for row in rows:
        asset = db.get(InfrastructureAsset, row.asset_id)
        if asset is None:
            continue
        if asset.category not in BACKUP_POWER_CATEGORIES:
            # A failed substation or power station is restored by crews and
            # spares, not by a generator; requesting backup power for them would
            # put an unsolvable demand into the model.
            continue
        # Translate "asset is down" into a concrete backup-power requirement in
        # kVA. Capacity units in the register are heterogeneous (beds, ML/day,
        # pupils), so a per-category conversion table is used instead of the raw
        # capacity number. This keeps the demo demand set solvable while staying
        # faithful to what a dispatcher would actually request.
        need = round(
            min(60.0, max(8.0, BACKUP_KVA_PER_ASSET.get(asset.category, 10) * (row.capacity_loss_percent / 100.0))),
            1,
        )
        demands.append(
            {
                "asset_id": asset.id,
                "asset_code": asset.code,
                "asset_name": asset.name,
                "category": asset.category,
                "need": need,
                "priority": min(5, max(1, asset.criticality)),
                "eligible_categories": ["generator"],
                "service_window_minutes": 240,
                "estimated_hours": default_hours,
            }
        )
    demands.sort(key=lambda d: (d["priority"], -d["need"]))
    return demands


def approvals_pending(db: Session) -> int:
    return (
        db.scalar(
            select(func.count())
            .select_from(OptimizationPlan)
            .where(OptimizationPlan.status == "proposed")
        )
        or 0
    )


def tasks_created_for_plan(db: Session, plan_id: int) -> list[RepairTask]:
    assignment_task_ids = [
        a.repair_task_id
        for a in db.scalars(
            select(OptimizationAssignment).where(OptimizationAssignment.plan_id == plan_id)
        ).all()
        if a.repair_task_id
    ]
    if not assignment_task_ids:
        return []
    return list(
        db.scalars(select(RepairTask).where(RepairTask.id.in_(assignment_task_ids))).all()
    )


def open_task_count(db: Session) -> int:
    return (
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


def active_incidents(db: Session) -> int:
    from app.models.operations import IncidentStatus
    from app.services.infrastructure import ACTIVE_INCIDENT_STATES

    return (
        db.scalar(
            select(func.count()).select_from(Incident).where(Incident.status.in_(ACTIVE_INCIDENT_STATES))
        )
        or 0
    )
