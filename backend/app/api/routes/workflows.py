"""Recovery workflow endpoints (start, inspect, retry, fault injection)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, status

from app.api.deps import CurrentUser, DbSession, Pagination, require_permissions
from app.core.responses import ApiError, ok, paginated
from app.models.operations import Incident, IncidentStatus
from app.models.optimization import OptimizationPlan
from app.models.workflow import WorkflowInstance
from app.workflows import engine
from app.workflows.engine import STEPS
from app.services import audit

router = APIRouter(tags=["workflows"])


@router.get("/workflows/steps")
def steps():
    return ok([{"key": k, "label": v, "automatic": k in engine.AUTOMATIC_STEPS} for k, v in STEPS])


@router.get("/workflows")
def list_workflows(
    db: DbSession,
    user: CurrentUser,
    page: Pagination,
    status_filter: str | None = Query(None, alias="status"),
    incident_id: int | None = None,
):
    items, total = engine.list_workflows(
        db, status=status_filter, incident_id=incident_id, offset=page.offset, limit=page.limit
    )
    return paginated(
        [engine.workflow_to_dict(db, w) for w in items],
        total=total,
        page=page.page,
        page_size=page.page_size,
    )


@router.post(
    "/workflows/start",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permissions("workflow:manage"))],
)
def start_workflow(
    incident_id: int,
    request: Request,
    db: DbSession,
    user: CurrentUser,
    simulation_run_id: int | None = None,
    plan_id: int | None = None,
    fail_at_step: str | None = Query(None, description="Demonstration fault injection"),
):
    incident = db.get(Incident, incident_id)
    if incident is None:
        raise ApiError("Incident not found.", status_code=404, code="not_found")
    if incident.status not in (IncidentStatus.REPORTED, IncidentStatus.VERIFIED):
        raise ApiError(
            "A workflow can only be started for a reported or verified incident.",
            status_code=409,
            code="invalid_incident_state",
        )
    plan = db.get(OptimizationPlan, plan_id) if plan_id else None
    from app.models.simulation import SimulationRun

    run = db.get(SimulationRun, simulation_run_id) if simulation_run_id else None
    if fail_at_step:
        # pre-register the workflow so the fault can be attached to its id
        workflow = engine.WorkflowInstance(
            code=engine.next_workflow_code(db),
            workflow_type="recovery",
            title=f"Recovery workflow for {incident.code}",
            status="running",
            current_step="incident_created",
            incident_id=incident.id,
            simulation_run_id=run.id if run else None,
            plan_id=plan.id if plan else None,
            started_by_id=user.id,
        )
        db.add(workflow)
        db.flush()
        engine.simulate_failure_at(workflow.id, fail_at_step)
        try:
            engine.start_recovery_workflow(
                db, incident=incident, simulation_run=run, plan=plan, actor_id=user.id
            )
        except ApiError as exc:
            db.rollback()
            raise ApiError(
                exc.message,
                status_code=status.HTTP_409_CONFLICT,
                code=exc.code,
                details={"fault_injected": fail_at_step},
            ) from exc
    else:
        workflow = engine.start_recovery_workflow(
            db, incident=incident, simulation_run=run, plan=plan, actor_id=user.id
        )
    audit.record(
        db, action="workflow.start", actor=user, resource_type="workflow_instance",
        resource_id=workflow.id, message=f"{workflow.code} started for {incident.code}",
        metadata={"fail_at_step": fail_at_step}, request=request,
    )
    db.commit()
    workflow = db.get(WorkflowInstance, workflow.id)
    return ok(engine.workflow_to_dict(db, workflow, detail=True))


@router.get("/workflows/{workflow_id}")
def get_workflow(workflow_id: int, db: DbSession, user: CurrentUser):
    workflow = db.get(WorkflowInstance, workflow_id)
    if workflow is None:
        raise ApiError("Workflow not found.", status_code=404, code="not_found")
    return ok(engine.workflow_to_dict(db, workflow, detail=True))


@router.post(
    "/workflows/{workflow_id}/retry",
    dependencies=[Depends(require_permissions("workflow:manage"))],
)
def retry_workflow(workflow_id: int, request: Request, db: DbSession, user: CurrentUser):
    workflow = db.get(WorkflowInstance, workflow_id)
    if workflow is None:
        raise ApiError("Workflow not found.", status_code=404, code="not_found")
    try:
        engine.retry_workflow(db, workflow, actor_id=user.id)
    except ApiError:
        db.rollback()
        raise
    audit.record(
        db, action="workflow.retry", actor=user, resource_type="workflow_instance",
        resource_id=workflow.id, message=f"{workflow.code} retried (attempt {workflow.retry_count})",
        request=request,
    )
    db.commit()
    workflow = db.get(WorkflowInstance, workflow_id)
    return ok(engine.workflow_to_dict(db, workflow, detail=True))


@router.post(
    "/workflows/{workflow_id}/simulate-failure",
    dependencies=[Depends(require_permissions("workflow:manage"))],
)
def inject_failure(
    workflow_id: int,
    step: str,
    request: Request,
    db: DbSession,
    user: CurrentUser,
):
    workflow = db.get(WorkflowInstance, workflow_id)
    if workflow is None:
        raise ApiError("Workflow not found.", status_code=404, code="not_found")
    engine.simulate_failure_at(workflow_id, step)
    audit.record(
        db, action="workflow.fault_injected", actor=user, resource_type="workflow_instance",
        resource_id=workflow.id, message=f"Fault scheduled at {step}", request=request,
    )
    db.commit()
    return ok({"message": f"The next attempt of '{step}' will fail once.", "step": step})
