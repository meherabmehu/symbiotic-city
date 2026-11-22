"""Individual workflow step handlers.

Every handler receives a :class:`WorkflowContext`, mutates the database inside
the caller's transaction and returns ``(human_message, data)``. Handlers must be
idempotent: re-running a step after a retry must not duplicate rows.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import func, select

from app.core.types import utcnow
from app.models.infrastructure import InfrastructureAsset
from app.models.operations import (
    Incident,
    IncidentAsset,
    IncidentStatus,
    RepairTask,
    Resource,
    ResourceReservation,
    ReservationStatus,
    TaskStatus,
)
from app.models.optimization import OptimizationAssignment, OptimizationPlan
from app.models.simulation import SimulationRun
from app.services import incidents as incident_service
from app.services import notifications as notify
from app.services import resources as resource_service
from app.services import simulation as simulation_service
from app.services import tasks as task_service

if TYPE_CHECKING:
    from app.workflows.engine import WorkflowContext


def _incident(ctx: "WorkflowContext") -> Incident:
    from app.workflows.engine import StepFailure

    incident = ctx.db.get(Incident, ctx.workflow.incident_id)
    if incident is None:
        raise StepFailure("The incident for this workflow no longer exists.")
    return incident


# --------------------------------------------------------------------------- #
# 1. incident_created
# --------------------------------------------------------------------------- #
def incident_created(ctx: "WorkflowContext") -> tuple[str, dict]:
    from app.workflows.engine import StepFailure

    incident = _incident(ctx)
    if incident.status != IncidentStatus.REPORTED:
        raise StepFailure(
            f"Workflow expects a freshly reported incident but {incident.code} is {incident.status}.",
            code="invalid_incident_state",
        )
    incident_service.add_event(
        ctx.db,
        incident,
        event_type="workflow",
        from_status=incident.status,
        to_status=incident.status,
        message=f"Recovery workflow {ctx.workflow.code} started.",
        actor_id=ctx.actor_id,
    )
    return (
        f"{incident.code} captured with severity {incident.severity}.",
        {"incident_id": incident.id, "severity": incident.severity},
    )


# --------------------------------------------------------------------------- #
# 2. incident_validated
# --------------------------------------------------------------------------- #
def incident_validated(ctx: "WorkflowContext") -> tuple[str, dict]:
    from app.workflows.engine import StepFailure

    incident = _incident(ctx)
    asset = ctx.db.get(InfrastructureAsset, incident.primary_asset_id)
    if asset is None or asset.is_archived:
        raise StepFailure(
            "Validation failed: the primary asset is missing or archived.", code="validation_failed"
        )
    if not incident.description.strip():
        raise StepFailure(
            "Validation failed: an incident needs a description before recovery planning.",
            code="validation_failed",
        )
    duplicates = ctx.db.scalar(
        select(func.count())
        .select_from(Incident)
        .where(
            Incident.primary_asset_id == incident.primary_asset_id,
            Incident.severity.in_(["critical", "high"]),
            Incident.status.notin_([IncidentStatus.RESOLVED, IncidentStatus.CANCELLED]),
            Incident.id != incident.id,
            Incident.severity == "critical",
        )
    )
    if duplicates:
        raise StepFailure(
            "Validation failed: another critical incident is already open on this asset.",
            code="validation_failed",
        )
    previous = incident.status
    incident.status = IncidentStatus.VERIFIED
    incident.updated_at = utcnow()
    incident_service.add_event(
        ctx.db,
        incident,
        event_type="status_change",
        from_status=previous,
        to_status=IncidentStatus.VERIFIED,
        message="Automatically validated by the recovery workflow.",
        actor_id=ctx.actor_id,
    )
    return (
        f"{incident.code} validated against the infrastructure register.",
        {"primary_asset": asset.code, "severity": incident.severity},
    )


# --------------------------------------------------------------------------- #
# 3. simulation_performed
# --------------------------------------------------------------------------- #
def simulation_performed(ctx: "WorkflowContext") -> tuple[str, dict]:
    from app.schemas.simulation import SimulationRunRequest
    from app.simulation.engine import severity_label

    incident = _incident(ctx)
    run_id = ctx.workflow.simulation_run_id
    run = ctx.db.get(SimulationRun, run_id) if run_id else None
    if run is None:
        payload = SimulationRunRequest(
            name=f"Auto simulation for {incident.code}",
            initial_failure_ids=[incident.primary_asset_id],
            cascade_threshold=0.35,
            max_depth=6,
            random_seed=42,
            incident_id=incident.id,
        )
        run = simulation_service.execute_run(ctx.db, payload, actor_id=ctx.actor_id)
        ctx.workflow.simulation_run_id = run.id
        incident.simulation_run_id = run.id
    import json

    summary = json.loads(run.summary_json or "{}")
    severity = severity_label(summary.get("severity_index", 0))
    incident.severity = severity if severity in ("low", "medium", "high", "critical") else incident.severity
    for result in ctx.db.scalars(
        select(IncidentAsset).where(IncidentAsset.incident_id == incident.id)
    ).all():
        pass
    incident_service.add_event(
        ctx.db,
        incident,
        event_type="simulation",
        from_status=incident.status,
        to_status=incident.status,
        message=(
            f"Cascade simulation {run.code} completed: "
            f"{summary.get('assets_failed', 0)} failed, {summary.get('assets_affected', 0)} affected, "
            f"severity {severity}."
        ),
        actor_id=ctx.actor_id,
    )
    return (
        f"Simulated cascade from {incident.code}: {summary.get('assets_failed', 0)} asset(s) fail.",
        {"run_id": run.id, "run_code": run.code, "summary": summary},
    )


# --------------------------------------------------------------------------- #
# 4. recovery_plan_generated
# --------------------------------------------------------------------------- #
def recovery_plan_generated(ctx: "WorkflowContext") -> tuple[str, dict]:
    from app.schemas.optimization import DemandInput, OptimizationSubmitRequest
    from app.services import optimization as optimization_service

    incident = _incident(ctx)
    run = ctx.db.get(SimulationRun, ctx.workflow.simulation_run_id) if ctx.workflow.simulation_run_id else None
    if run is None:
        from app.workflows.engine import StepFailure

        raise StepFailure("No simulation is attached; a recovery plan needs impact data.")

    demand_rows = optimization_service.demands_from_simulation(ctx.db, run.id)
    if not demand_rows:
        from app.workflows.engine import StepFailure

        raise StepFailure("The simulation produced no recoverable demand.")
    demands = [
        DemandInput(
            asset_id=row["asset_id"],
            need=row["need"],
            priority=row["priority"],
            eligible_categories=row["eligible_categories"],
            service_window_minutes=row["service_window_minutes"],
            estimated_hours=row["estimated_hours"],
        )
        for row in demand_rows
    ]
    base = OptimizationSubmitRequest(
        title=f"Recovery plan for {incident.code}",
        simulation_run_id=run.id,
        incident_id=incident.id,
        demands=demands,
        horizon_hours=12.0,
        must_serve_priority=1,
    )
    request, plan, result = optimization_service.create_request_and_plan(
        ctx.db, base, actor_id=ctx.actor_id
    )
    relaxed = False
    if plan.solution_status == "infeasible":
        # Conditional branch: if the strict "every P1 demand must be served"
        # model is infeasible, re-solve with the floor removed so operators get
        # a ranked recommendation instead of a dead end. The relaxation is
        # recorded on the plan and in the workflow ledger.
        relaxed = True
        base = base.model_copy(update={"title": f"{base.title} (relaxed P1 floor)"})
        request, plan, result = optimization_service.create_request_and_plan(
            ctx.db,
            base,
            actor_id=ctx.actor_id,
            must_serve_priority=None,
        )
        import json as _json

        explanation = _json.loads(plan.explanation_json or "{}")
        explanation["relaxation"] = (
            "The strict must-serve-every-P1 model was infeasible with the current resource pool, "
            "so the workflow automatically re-solved with the priority floor relaxed. Demands are "
            "still ranked by priority; the highest-priority items are served first."
        )
        plan.explanation_json = _json.dumps(explanation)
    ctx.workflow.plan_id = plan.id
    incident.optimization_plan_id = plan.id
    incident.status = IncidentStatus.PLANNING
    incident_service.add_event(
        ctx.db,
        incident,
        event_type="plan",
        from_status=IncidentStatus.VERIFIED,
        to_status=IncidentStatus.PLANNING,
        message=(
            f"{plan.code} generated with status {plan.solution_status}: "
            f"{plan.covered_demand}/{plan.total_demand} demand points covered."
        ),
        actor_id=ctx.actor_id,
    )
    notify.push_to_roles(
        ctx.db,
        ["city_operator"],
        title=f"Plan {plan.code} awaits approval",
        body=f"{plan.covered_demand}/{plan.total_demand} demand points covered for {incident.code}.",
        category="optimization",
        severity="warning",
        link=f"/optimization/plans/{plan.id}",
        entity_type="optimization_plan",
        entity_id=plan.id,
    )
    return (
        f"Plan {plan.code} generated (coverage {plan.coverage_percent:.0f}%"
        + (", priority floor relaxed after an infeasible first pass)" if relaxed else ")"),
        {"plan_id": plan.id, "plan_code": plan.code, "relaxed": relaxed, "result": result},
    )


# --------------------------------------------------------------------------- #
# 5. resources_reserved
# --------------------------------------------------------------------------- #
def resources_reserved(ctx: "WorkflowContext") -> tuple[str, dict]:
    from app.workflows.engine import StepFailure

    plan = ctx.db.get(OptimizationPlan, ctx.workflow.plan_id) if ctx.workflow.plan_id else None
    if plan is None:
        raise StepFailure("No approved plan is attached to this workflow.")
    if plan.solution_status == "infeasible":
        raise StepFailure(
            "The plan is infeasible, so no resources can be reserved. Re-solve with relaxed constraints first.",
            code="infeasible_plan",
        )
    incident = _incident(ctx)
    assignments = ctx.db.scalars(
        select(OptimizationAssignment).where(OptimizationAssignment.plan_id == plan.id)
    ).all()
    reserved: list[dict] = []
    for assignment in assignments:
        resource = ctx.db.get(Resource, assignment.resource_id)
        if resource is None:
            raise StepFailure(f"Resource {assignment.resource_id} disappeared before reservation.")
        existing = ctx.db.scalar(
            select(ResourceReservation).where(
                ResourceReservation.plan_id == plan.id,
                ResourceReservation.resource_id == resource.id,
                ResourceReservation.status == ReservationStatus.RESERVED,
            )
        )
        if existing:
            continue  # idempotent
        try:
            reservation = resource_service.reserve(
                ctx.db,
                resource,
                quantity=assignment.quantity,
                repair_task_id=None,
                plan_id=plan.id,
                workflow_id=ctx.workflow.id,
                actor_id=ctx.actor_id,
            )
        except Exception as exc:  # noqa: BLE001 - converted to a step failure
            raise StepFailure(
                f"Reservation failed for {resource.code}: {getattr(exc, 'message', str(exc))}. "
                "No resources were left half-booked; the workflow will compensate.",
                code="reservation_failed",
            ) from exc
        reserved.append(
            {"resource_id": resource.id, "code": resource.code, "quantity": float(reservation.quantity)}
        )
        from app.workflows import engine as _engine

        if _engine.take_fault(ctx.workflow.id, "resources_reserved"):
            # Demonstration of a mid-flight failure: the reservation above is
            # already committed when the step fails, so the workflow has to
            # compensate by releasing it before a retry can run.
            raise StepFailure(
                "Injected failure halfway through resource reservation: "
                f"{resource.code} was committed before the failure. Compensating actions "
                "release the partial reservation so a retry cannot double book capacity.",
                code="injected_failure",
            )
    notify.push_to_roles(
        ctx.db,
        ["city_operator", "super_admin"],
        title=f"{len(reserved)} resource(s) reserved",
        body=f"Plan {plan.code} for {incident.code} has capacity committed.",
        category="resource",
        severity="info",
        link="/resources",
        entity_type="optimization_plan",
        entity_id=plan.id,
    )
    return (
        f"Reserved {len(reserved)} resource allocation(s) for plan {plan.code}.",
        {"reserved": reserved, "plan_id": plan.id},
    )


# --------------------------------------------------------------------------- #
# 6. repair_tasks_assigned
# --------------------------------------------------------------------------- #
def repair_tasks_assigned(ctx: "WorkflowContext") -> tuple[str, dict]:
    from app.workflows.engine import StepFailure

    incident = _incident(ctx)
    plan = ctx.db.get(OptimizationPlan, ctx.workflow.plan_id) if ctx.workflow.plan_id else None
    if plan is None:
        raise StepFailure("No plan is attached; nothing to dispatch.")
    engineers = ctx.db.execute(
        select(__import__("app.models.identity", fromlist=["User"]).User)
    ).scalars().all()
    eligible_engineers = [
        u for u in engineers if "field_engineer" in u.role_keys and u.is_active
    ]
    if not eligible_engineers:
        raise StepFailure(
            "No active field engineer is available to receive the assignment.",
            code="no_engineer_available",
        )
    assignments = ctx.db.scalars(
        select(OptimizationAssignment).where(OptimizationAssignment.plan_id == plan.id)
    ).all()
    created: list[dict] = []
    for index, assignment in enumerate(assignments):
        if assignment.repair_task_id:
            continue
        asset = ctx.db.get(InfrastructureAsset, assignment.asset_id)
        resource = ctx.db.get(Resource, assignment.resource_id)
        engineer = eligible_engineers[index % len(eligible_engineers)]
        task = task_service.create_task(
            ctx.db,
            __import__("app.schemas.operations", fromlist=["TaskCreate"]).TaskCreate(
                title=f"Restore supply to {asset.name}"[:180],
                description=(
                    f"Deploy {resource.name} ({resource.code}) to {asset.name} as planned by "
                    f"{plan.code}. Quantity {assignment.quantity:g} {resource.capacity_unit}. "
                    f"Auto-dispatched by workflow {ctx.workflow.code}."
                ),
                asset_id=assignment.asset_id,
                incident_id=incident.id,
                assignee_id=engineer.id,
                priority=max(1, min(5, assignment.priority_weight)),
                estimated_hours=2.0,
            ),
            actor_id=ctx.actor_id,
        )
        assignment.repair_task_id = task.id
        reservations = ctx.db.scalars(
            select(ResourceReservation).where(
                ResourceReservation.plan_id == plan.id,
                ResourceReservation.resource_id == assignment.resource_id,
                ResourceReservation.status == ReservationStatus.RESERVED,
            )
        ).all()
        for reservation in reservations:
            if reservation.repair_task_id is None:
                reservation.repair_task_id = task.id
        created.append({"task_id": task.id, "code": task.code, "assignee_id": engineer.id})

    previous_status = incident.status
    if incident.status in (IncidentStatus.PLANNING, IncidentStatus.APPROVED):
        incident.status = IncidentStatus.IN_PROGRESS
        incident.updated_at = utcnow()
        incident_service.add_event(
            ctx.db,
            incident,
            event_type="status_change",
            from_status=previous_status,
            to_status=IncidentStatus.IN_PROGRESS,
            message=f"{len(created)} repair task(s) dispatched after approval.",
            actor_id=ctx.actor_id,
        )
    notify.push_to_roles(
        ctx.db,
        ["field_engineer"],
        title="Repair assignment dispatched",
        body=f"{len(created)} new task(s) for incident {incident.code}.",
        category="task",
        severity="warning",
        link="/my-tasks",
        entity_type="incident",
        entity_id=incident.id,
    )
    return (
        f"Dispatched {len(created)} repair task(s) to field engineers.",
        {"tasks": created, "incident_status": incident.status},
    )


# --------------------------------------------------------------------------- #
# 7. engineer_accepted
# --------------------------------------------------------------------------- #
def engineer_accepted(ctx: "WorkflowContext") -> tuple[str, dict]:
    incident = _incident(ctx)
    accepted = ctx.db.scalar(
        select(func.count())
        .select_from(RepairTask)
        .where(
            RepairTask.incident_id == incident.id,
            RepairTask.status.in_(
                [TaskStatus.ACCEPTED, TaskStatus.IN_PROGRESS, TaskStatus.COMPLETED, TaskStatus.VERIFIED]
            ),
        )
    )
    return (
        f"{accepted} task(s) accepted by the assigned engineer(s).",
        {"accepted_tasks": accepted},
    )


# --------------------------------------------------------------------------- #
# 8. repair_verified
# --------------------------------------------------------------------------- #
def repair_verified(ctx: "WorkflowContext") -> tuple[str, dict]:
    from app.workflows.engine import StepFailure

    incident = _incident(ctx)
    open_tasks = ctx.db.scalar(
        select(func.count())
        .select_from(RepairTask)
        .where(
            RepairTask.incident_id == incident.id,
            RepairTask.status.notin_([TaskStatus.VERIFIED, TaskStatus.CANCELLED]),
        )
    )
    if open_tasks:
        raise StepFailure(
            f"{open_tasks} repair task(s) are still open; verification cannot complete.",
            code="open_tasks",
        )
    return ("All repair tasks verified by operations.", {"open_tasks": 0})


# --------------------------------------------------------------------------- #
# 9. incident_resolved
# --------------------------------------------------------------------------- #
def incident_resolved(ctx: "WorkflowContext") -> tuple[str, dict]:
    incident = _incident(ctx)
    if incident.status != IncidentStatus.RESOLVED:
        previous = incident.status
        incident.status = IncidentStatus.RESOLVED
        incident.resolved_at = utcnow()
        incident.resolution_notes = incident.resolution_notes or "Resolved through the recovery workflow."
        incident.updated_at = utcnow()
        incident_service.add_event(
            ctx.db,
            incident,
            event_type="status_change",
            from_status=previous,
            to_status=IncidentStatus.RESOLVED,
            message="Workflow closed the incident after verified repairs.",
            actor_id=ctx.actor_id,
        )
        # A resolution performed by the workflow is still an incident transition,
        # so it has to appear in the audit trail with the actor who triggered it —
        # an auto-closed incident must never be unattributable.
        _audit_transition(ctx, incident, previous=previous)
    return (f"{incident.code} resolved.", {"incident_id": incident.id})


def _audit_transition(ctx: "WorkflowContext", incident, *, previous: str) -> None:
    from app.models.identity import User
    from app.services import audit

    actor = ctx.db.get(User, ctx.actor_id) if ctx.actor_id else None
    audit.record(
        ctx.db,
        action="incident.transition",
        actor=actor,
        resource_type="incident",
        resource_id=incident.id,
        message=f"{incident.code} {previous} -> resolved by recovery workflow.",
        metadata={"workflow_id": ctx.workflow.id, "source": "workflow"},
    )
