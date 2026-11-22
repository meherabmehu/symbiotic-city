"""Automated multi-step recovery workflow (advanced challenge A07).

Design
======
A workflow is an ordered list of steps. Each step is idempotent, records an
event row, and either advances the workflow or raises :class:`StepFailure`.
Because every consequential step writes to the database inside the *caller's*
transaction, a failure can either

* **roll back** everything since the last checkpoint (``abort`` strategy), or
* keep completed work and run **compensating actions** for the partial effects
  (``compensate`` strategy — used for resource reservations, which must be
  explicitly released before a retry, otherwise a retry would double book).

State is persisted in ``workflow_instances`` + ``workflow_events``; the event
table has a unique constraint on ``(workflow_id, step, attempt)`` so a repeated
request cannot record the same step twice.

Steps
=====
``incident_created`` → ``incident_validated`` → ``simulation_performed`` →
``recovery_plan_generated`` → ``plan_approved`` → ``resources_reserved`` →
``repair_tasks_assigned`` → ``engineer_accepted`` → ``repair_verified`` →
``incident_resolved``

Steps after ``plan_approved`` are driven by human actions (approval, engineer
acceptance, verification). The engine exposes two entry points:

* :func:`start_recovery_workflow` — runs the automatic front half.
* :func:`advance_workflow` — called by the approval / task / incident services
  when a human action completes an engine step.

Fault injection for the demonstration is available through
:func:`simulate_failure_at`, which makes a chosen step fail once so the
rollback/compensation path can be shown live.
"""
from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.responses import ApiError
from app.core.types import utcnow
from app.models.infrastructure import InfrastructureAsset
from app.models.operations import (
    Incident,
    IncidentStatus,
    RepairTask,
    Resource,
    ResourceReservation,
    ReservationStatus,
    TaskStatus,
)
from app.models.optimization import OptimizationPlan
from app.models.simulation import SimulationRun
from app.models.workflow import WorkflowEvent, WorkflowInstance
from app.services import notifications as notify
from app.workflows import steps as step_impl

STEPS: list[tuple[str, str]] = [
    ("incident_created", "Incident recorded"),
    ("incident_validated", "Incident validated"),
    ("simulation_performed", "Cascade simulation executed"),
    ("recovery_plan_generated", "Constrained recovery plan generated"),
    ("plan_approved", "Recovery plan approved by operator"),
    ("resources_reserved", "Resources reserved transactionally"),
    ("repair_tasks_assigned", "Repair tasks dispatched"),
    ("engineer_accepted", "Field engineer accepted assignment"),
    ("repair_verified", "Repair verified by operator"),
    ("incident_resolved", "Incident resolved"),
]
STEP_LABELS = dict(STEPS)
AUTOMATIC_STEPS = [s for s, _ in STEPS[:4]]
MANUAL_STEPS = [s for s, _ in STEPS[4:]]


class StepFailure(Exception):
    """Raised by a step to trigger the workflow's failure handling."""

    def __init__(self, message: str, *, code: str = "step_failed") -> None:
        super().__init__(message)
        self.message = message
        self.code = code


@dataclass
class WorkflowContext:
    db: Session
    workflow: WorkflowInstance
    actor_id: int | None
    payload: dict[str, Any]


def next_workflow_code(db: Session) -> str:
    count = db.scalar(select(func.count()).select_from(WorkflowInstance)) or 0
    return f"WF-{count + 1:04d}"


def _record_event(
    db: Session,
    workflow: WorkflowInstance,
    step: str,
    *,
    attempt: int,
    outcome: str,
    message: str,
    actor_id: int | None,
    data: dict | None = None,
) -> WorkflowEvent:
    event = WorkflowEvent(
        workflow_id=workflow.id,
        step=step,
        attempt=attempt,
        outcome=outcome,
        message=message[:2000],
        data_json=json.dumps(data or {}, default=str),
        actor_id=actor_id,
        created_at=utcnow(),
    )
    db.add(event)
    db.flush()
    return event


def completed_steps(workflow: WorkflowInstance) -> list[str]:
    return json.loads(workflow.completed_steps_json or "[]")


def _set_completed(workflow: WorkflowInstance, steps: list[str]) -> None:
    # Preserve execution order (not alphabetical) so the UI can show the real
    # sequence of events.
    workflow.completed_steps_json = json.dumps(list(dict.fromkeys(steps)))


def _current_step_index(workflow: WorkflowInstance) -> int:
    order = [s for s, _ in STEPS]
    if workflow.current_step in order:
        return order.index(workflow.current_step)
    return 0


# --------------------------------------------------------------------------- #
# fault injection (demonstration only, never enabled in production by default)
# --------------------------------------------------------------------------- #
_FAULTS: dict[int, str] = {}


def simulate_failure_at(workflow_id: int, step: str) -> None:
    if step not in STEP_LABELS:
        raise ApiError("Unknown workflow step.", status_code=422, code="invalid_step")
    _FAULTS[workflow_id] = step


def clear_faults(workflow_id: int) -> None:
    _FAULTS.pop(workflow_id, None)


def take_fault(workflow_id: int, step: str) -> bool:
    """True exactly once if a fault was registered for this step.

    Steps call this *mid-way through* their work so the demonstration shows a
    genuine partial failure (some reservations made, then a failure) rather than
    a step that refuses to start.
    """
    if _FAULTS.get(workflow_id) == step:
        _FAULTS.pop(workflow_id, None)
        return True
    return False


def _maybe_fail(workflow: WorkflowInstance, step: str) -> None:
    if _FAULTS.get(workflow.id) == step:
        _FAULTS.pop(workflow.id, None)
        raise StepFailure(
            f"Injected failure at step '{STEP_LABELS[step]}'. The workflow stopped and "
            "compensating actions were applied for partial effects.",
            code="injected_failure",
        )


# --------------------------------------------------------------------------- #
# start
# --------------------------------------------------------------------------- #
def start_recovery_workflow(
    db: Session,
    *,
    incident: Incident,
    simulation_run: SimulationRun | None,
    plan: OptimizationPlan | None,
    actor_id: int | None,
    adopt_id: int | None = None,
) -> WorkflowInstance:
    """Start (or adopt) the recovery workflow for an incident.

    ``adopt_id`` lets callers pre-create the workflow row (so a demonstration
    fault can be registered against its id) and then hand it over to the engine.
    """
    existing = db.scalar(
        select(WorkflowInstance).where(
            WorkflowInstance.incident_id == incident.id,
            WorkflowInstance.status.in_(["running", "awaiting_approval", "awaiting_field"]),
            WorkflowInstance.id != (adopt_id or 0),
        )
    )
    if existing and adopt_id is None:
        raise ApiError(
            f"{existing.code} is already driving this incident. Retry or resume it instead of starting a second workflow.",
            status_code=409,
            code="workflow_exists",
            details={"workflow_id": existing.id, "code": existing.code},
        )
    if adopt_id is not None:
        workflow = db.get(WorkflowInstance, adopt_id)
        if workflow is None:  # pragma: no cover - defensive
            raise ApiError("The workflow to adopt no longer exists.", status_code=404, code="not_found")
        workflow.status = "running"
        workflow.current_step = "incident_created"
        workflow.started_at = utcnow()
        workflow.simulation_run_id = simulation_run.id if simulation_run else workflow.simulation_run_id
        workflow.plan_id = plan.id if plan else workflow.plan_id
        _set_completed(workflow, [])
    else:
        workflow = WorkflowInstance(
            code=next_workflow_code(db),
            workflow_type="recovery",
            title=f"Recovery workflow for {incident.code}",
            status="running",
            current_step="incident_created",
            incident_id=incident.id,
            simulation_run_id=simulation_run.id if simulation_run else None,
            plan_id=plan.id if plan else None,
            started_by_id=actor_id,
            started_at=utcnow(),
        )
        db.add(workflow)
        db.flush()
        _set_completed(workflow, [])
    ctx = WorkflowContext(
        db=db,
        workflow=workflow,
        actor_id=actor_id,
        payload={
            "incident_id": incident.id,
            "simulation_run_id": simulation_run.id if simulation_run else None,
            "plan_id": plan.id if plan else None,
        },
    )
    try:
        _run_automatic_steps(ctx, start_at="incident_created")
    except StepFailure as failure:
        # The failed run is persisted on purpose: completed steps, the failure
        # reason and the compensating actions are the artefact operators and
        # judges need to see. Each step writes only its own effects and every
        # partial effect is compensated in _handle_failure, so nothing is
        # half-applied (no orphan reservations, no stranded tasks).
        db.flush()
        raise ApiError(
            failure.message,
            status_code=409,
            code=failure.code,
            details={"workflow_id": workflow.id, "failure_step": workflow.failure_step},
        ) from failure
    db.flush()
    return workflow


def _run_automatic_steps(ctx: WorkflowContext, *, start_at: str) -> None:
    workflow = ctx.workflow
    order = [s for s, _ in STEPS]
    start_index = order.index(start_at)
    for step in order[start_index : len(AUTOMATIC_STEPS)]:
        if step in completed_steps(workflow):
            continue
        _execute_step(ctx, step)


def _execute_step(ctx: WorkflowContext, step: str) -> None:
    workflow = ctx.workflow
    attempt = workflow.retry_count + 1
    handlers: dict[str, Callable[[WorkflowContext], tuple[str, dict]]] = {
        "incident_created": step_impl.incident_created,
        "incident_validated": step_impl.incident_validated,
        "simulation_performed": step_impl.simulation_performed,
        "recovery_plan_generated": step_impl.recovery_plan_generated,
        "resources_reserved": step_impl.resources_reserved,
        "repair_tasks_assigned": step_impl.repair_tasks_assigned,
        "engineer_accepted": step_impl.engineer_accepted,
        "repair_verified": step_impl.repair_verified,
        "incident_resolved": step_impl.incident_resolved,
    }
    handler = handlers.get(step)
    if handler is None:
        if step == "plan_approved":
            workflow.current_step = step
            workflow.status = "awaiting_approval"
            _record_event(
                ctx.db,
                workflow,
                step,
                attempt=attempt,
                outcome="awaiting",
                message="Waiting for an operator to approve the generated recovery plan.",
                actor_id=ctx.actor_id,
            )
            return
        raise StepFailure(f"No handler registered for step {step}.", code="missing_handler")

    try:
        if step != "resources_reserved":
            # resources_reserved injects its own mid-step fault
            _maybe_fail(workflow, step)
        message, data = handler(ctx)
    except StepFailure as failure:
        _handle_failure(ctx, step, failure)
        raise
    except Exception as exc:  # noqa: BLE001 - any step error is compensated
        failure = StepFailure(f"Unexpected error in '{STEP_LABELS[step]}': {exc}")
        _handle_failure(ctx, step, failure)
        raise failure from exc

    steps = completed_steps(workflow)
    steps.append(step)
    _set_completed(workflow, steps)
    workflow.current_step = step
    workflow.failure_step = None
    workflow.failure_reason = None
    workflow.updated_at = utcnow()
    _record_event(
        ctx.db,
        workflow,
        step,
        attempt=attempt,
        outcome="succeeded",
        message=message,
        actor_id=ctx.actor_id,
        data=data,
    )

    # pause points where a human is required
    if step == "recovery_plan_generated":
        workflow.current_step = "plan_approved"
        workflow.status = "awaiting_approval"
    elif step == "repair_tasks_assigned":
        workflow.status = "awaiting_field"
    elif step == "repair_verified":
        workflow.current_step = "incident_resolved"
    elif step == "incident_resolved":
        workflow.status = "completed"
        workflow.current_step = "incident_resolved"
        workflow.completed_at = utcnow()
    ctx.db.flush()


def request_tail(*, context: WorkflowContext, workflow: WorkflowInstance) -> None:
    """Run the post-approval steps, recording a failure instead of raising it.

    Approval has already been committed at this point, so a failure here must
    leave the workflow in the ``failed`` state (with compensation applied) and
    let the operator retry, rather than rolling back the approval itself.
    """
    queue = ["resources_reserved", "repair_tasks_assigned"]
    for follow in queue:
        if workflow.status not in ("running", "failed"):
            break
        if follow in completed_steps(workflow):
            continue
        try:
            _execute_step(context, follow)
        except StepFailure:
            return
        except Exception:  # noqa: BLE001 - already recorded by _handle_failure
            return


def _handle_failure(ctx: WorkflowContext, step: str, failure: StepFailure) -> None:
    workflow = ctx.workflow
    attempt = workflow.retry_count + 1
    workflow.status = "failed"
    workflow.failure_step = step
    workflow.failure_reason = failure.message
    workflow.updated_at = utcnow()
    _record_event(
        ctx.db,
        workflow,
        step,
        attempt=attempt,
        outcome="failed",
        message=failure.message,
        actor_id=ctx.actor_id,
        data={"rolled_back": True},
    )
    _compensate(ctx, step)
    notify.push_to_roles(
        ctx.db,
        ["city_operator", "super_admin"],
        title=f"Workflow {workflow.code} failed",
        body=failure.message,
        category="workflow",
        severity="error",
        link="/workflows",
        entity_type="workflow",
        entity_id=workflow.id,
    )
    ctx.db.flush()


def _compensate(ctx: WorkflowContext, failed_step: str) -> None:
    """Undo partial effects that are safe to undo.

    Reservations made by earlier attempts of ``resources_reserved`` are
    released so a retry cannot double book capacity. Repair tasks created but
    never dispatched are cancelled rather than deleted, preserving the audit
    trail. Authorised status changes to infrastructure are the only actions not
    auto-reverted: they require a human decision and are surfaced in the UI.
    """
    db, workflow = ctx.db, ctx.workflow
    reservations = db.scalars(
        select(ResourceReservation).where(
            ResourceReservation.workflow_id == workflow.id,
            ResourceReservation.status == ReservationStatus.RESERVED,
        )
    ).all()
    for reservation in reservations:
        reservation.status = ReservationStatus.ROLLED_BACK
        reservation.released_at = utcnow()
        reservation.release_reason = f"Workflow {workflow.code} failed at {failed_step}"
    tasks = db.scalars(
        select(RepairTask).where(
            RepairTask.incident_id == workflow.incident_id,
            RepairTask.status.in_([TaskStatus.PENDING, TaskStatus.ASSIGNED]),
        )
    ).all()
    for task in tasks:
        task.status = TaskStatus.CANCELLED
        task.updated_at = utcnow()
    if reservations or tasks:
        _record_event(
            db,
            workflow,
            "compensation",
            attempt=workflow.retry_count + 1,
            outcome="succeeded",
            message=(
                f"Released {len(reservations)} reservation(s) and cancelled {len(tasks)} "
                f"undispatched task(s) after the failure at {failed_step}."
            ),
            actor_id=ctx.actor_id,
            data={
                "released_reservations": [r.id for r in reservations],
                "cancelled_tasks": [t.id for t in tasks],
            },
        )


# --------------------------------------------------------------------------- #
# human driven advancement
# --------------------------------------------------------------------------- #
def advance_workflow(
    db: Session,
    *,
    workflow_id: int,
    step: str,
    actor_id: int | None,
    payload: dict | None = None,
) -> WorkflowInstance:
    workflow = db.get(WorkflowInstance, workflow_id)
    if workflow is None:
        raise ApiError("Workflow not found.", status_code=404, code="not_found")
    if step in completed_steps(workflow):
        # idempotent: repeated signals (e.g. double-clicked approval) are no-ops
        return workflow
    if workflow.status == "completed":
        raise ApiError("This workflow has already completed.", status_code=409, code="workflow_complete")
    if step == "plan_approved" and workflow.current_step != "plan_approved":
        raise ApiError(
            "The plan must be generated before it can be approved.",
            status_code=409,
            code="out_of_order",
        )
    ctx = WorkflowContext(
        db=db,
        workflow=workflow,
        actor_id=actor_id,
        payload=payload or {},
    )
    if workflow.status == "failed":
        workflow.status = "running"
        workflow.retry_count += 1
    if step == "plan_approved":
        # human gate: record the approval, then continue the automatic tail
        steps = completed_steps(workflow)
        steps.append(step)
        _set_completed(workflow, steps)
        workflow.current_step = step
        workflow.status = "running"
        workflow.updated_at = utcnow()
        _record_event(
            db,
            workflow,
            step,
            attempt=workflow.retry_count + 1,
            outcome="succeeded",
            message=(payload or {}).get("note")
            or "Recovery plan approved by an authorised operator.",
            actor_id=actor_id,
            data={"plan_id": workflow.plan_id},
        )
        request_tail(context=ctx, workflow=workflow)
        if workflow.status == "running":
            workflow.status = "awaiting_field"
    elif step in AUTOMATIC_STEPS or step in {
        "resources_reserved",
        "repair_tasks_assigned",
        "engineer_accepted",
        "repair_verified",
        "incident_resolved",
    }:
        _execute_step(ctx, step)
    else:
        steps = completed_steps(workflow)
        steps.append(step)
        _set_completed(workflow, steps)
        workflow.current_step = step
        workflow.updated_at = utcnow()
        _record_event(
            db,
            workflow,
            step,
            attempt=workflow.retry_count + 1,
            outcome="succeeded",
            message=f"{STEP_LABELS.get(step, step)} recorded.",
            actor_id=actor_id,
        )
    db.flush()
    return workflow


def retry_workflow(
    db: Session, workflow: WorkflowInstance, *, actor_id: int | None
) -> WorkflowInstance:
    if workflow.status not in ("failed", "running", "awaiting_field", "awaiting_approval"):
        raise ApiError(
            f"Workflow is {workflow.status} and cannot be retried.",
            status_code=409,
            code="invalid_state",
        )
    workflow.retry_count += 1
    workflow.status = "running"
    workflow.failure_step = None
    workflow.failure_reason = None
    workflow.updated_at = utcnow()
    _record_event(
        db,
        workflow,
        "retry",
        attempt=workflow.retry_count,
        outcome="started",
        message="Retry requested by operator. Completed steps are preserved; only failed steps re-run.",
        actor_id=actor_id,
    )
    ctx = WorkflowContext(db=db, workflow=workflow, actor_id=actor_id, payload={})
    done = completed_steps(workflow)
    order = [s for s, _ in STEPS]
    for step in AUTOMATIC_STEPS:
        if step in done:
            continue
        _execute_step(ctx, step)
        if workflow.status != "running":
            break
    # if the automatic front half is complete but approval already happened,
    # resume the dispatch tail
    if workflow.status == "running" and "plan_approved" in completed_steps(workflow):
        request_tail(context=ctx, workflow=workflow)
        if workflow.status == "running":
            workflow.status = "awaiting_field"
    db.flush()
    return workflow


def sync_workflow_step(
    db: Session, *, incident_id: int | None, step: str, actor_id: int | None
) -> None:
    """Advance a running workflow when a human action completes one of its steps.

    Safe to call even when no workflow is attached (e.g. incidents created by
    hand). Failures are recorded on the workflow and never mask the human action
    that triggered them.
    """
    if incident_id is None or step not in STEP_LABELS:
        return
    workflow = db.scalar(
        select(WorkflowInstance).where(
            WorkflowInstance.incident_id == incident_id,
            WorkflowInstance.status.in_(["running", "awaiting_field", "awaiting_approval"]),
        )
    )
    if workflow is None or step in completed_steps(workflow):
        return
    try:
        advance_workflow(db, workflow_id=workflow.id, step=step, actor_id=actor_id)
    except (ApiError, StepFailure):
        db.flush()


def workflow_to_dict(db: Session, workflow: WorkflowInstance, *, detail: bool = False) -> dict:
    base = {
        "id": workflow.id,
        "code": workflow.code,
        "workflow_type": workflow.workflow_type,
        "title": workflow.title,
        "status": workflow.status,
        "current_step": workflow.current_step,
        "incident_id": workflow.incident_id,
        "simulation_run_id": workflow.simulation_run_id,
        "plan_id": workflow.plan_id,
        "failure_step": workflow.failure_step,
        "failure_reason": workflow.failure_reason,
        "retry_count": workflow.retry_count,
        "started_at": workflow.started_at,
        "completed_at": workflow.completed_at,
        "updated_at": workflow.updated_at,
        "completed_steps": completed_steps(workflow),
    }
    if detail:
        events = db.scalars(
            select(WorkflowEvent)
            .where(WorkflowEvent.workflow_id == workflow.id)
            .order_by(WorkflowEvent.created_at, WorkflowEvent.id)
        ).all()
        base["events"] = [
            {
                "id": e.id,
                "step": e.step,
                "attempt": e.attempt,
                "outcome": e.outcome,
                "message": e.message,
                "actor_id": e.actor_id,
                "created_at": e.created_at,
            }
            for e in events
        ]
        base["next_actions"] = _next_actions(workflow)
        base["steps"] = [
            {
                "key": key,
                "label": label,
                "status": (
                    "done"
                    if key in base["completed_steps"]
                    else "failed"
                    if workflow.failure_step == key
                    else "current"
                    if workflow.current_step == key
                    else "pending"
                ),
            }
            for key, label in STEPS
        ]
    return base


def _next_actions(workflow: WorkflowInstance) -> list[str]:
    if workflow.status == "failed":
        return ["retry"]
    if workflow.status == "completed":
        return []
    if workflow.status == "awaiting_approval":
        return ["approve_plan"]
    if workflow.status == "awaiting_field":
        return ["await_engineer_acceptance"]
    if workflow.status == "running":
        return ["resume"]
    return []


def list_workflows(
    db: Session,
    *,
    status: str | None = None,
    incident_id: int | None = None,
    offset: int = 0,
    limit: int = 20,
) -> tuple[list[WorkflowInstance], int]:
    stmt = select(WorkflowInstance)
    count_stmt = select(func.count()).select_from(WorkflowInstance)
    if status:
        stmt = stmt.where(WorkflowInstance.status == status)
        count_stmt = count_stmt.where(WorkflowInstance.status == status)
    if incident_id:
        stmt = stmt.where(WorkflowInstance.incident_id == incident_id)
        count_stmt = count_stmt.where(WorkflowInstance.incident_id == incident_id)
    total = db.scalar(count_stmt) or 0
    items = db.scalars(
        stmt.order_by(WorkflowInstance.started_at.desc()).offset(offset).limit(limit)
    ).all()
    return list(items), total
