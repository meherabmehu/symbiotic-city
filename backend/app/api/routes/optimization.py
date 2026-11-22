"""Optimisation, plan approval and reservation endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession, Pagination, require_permissions
from app.core.responses import ApiError, ok, paginated
from app.models.optimization import OptimizationPlan, OptimizationRequest
from app.schemas.optimization import (
    ApprovalRequest,
    OptimizationPreviewRequest,
    OptimizationSubmitRequest,
)
from app.services import audit
from app.services import optimization as service

router = APIRouter(tags=["optimization"])


@router.get("/optimization/plans")
def list_plans(
    db: DbSession,
    user: CurrentUser,
    page: Pagination,
    status_filter: str | None = Query(None, alias="status"),
):
    items, total = service.list_plans(db, status=status_filter, offset=page.offset, limit=page.limit)
    return paginated(
        [service.plan_to_dict(db, p) for p in items],
        total=total,
        page=page.page,
        page_size=page.page_size,
    )


@router.get("/optimization/requests")
def list_requests(db: DbSession, user: CurrentUser, page: Pagination):
    from sqlalchemy import func

    total = db.scalar(select(func.count()).select_from(OptimizationRequest)) or 0
    rows = db.scalars(
        select(OptimizationRequest)
        .order_by(OptimizationRequest.created_at.desc())
        .offset(page.offset)
        .limit(page.limit)
    ).all()
    return paginated(
        [
            {
                "id": r.id, "code": r.code, "title": r.title, "objective": r.objective,
                "status": r.status, "requested_by_id": r.requested_by_id,
                "created_at": r.created_at, "incident_id": r.incident_id,
                "simulation_run_id": r.simulation_run_id,
            }
            for r in rows
        ],
        total=total,
        page=page.page,
        page_size=page.page_size,
    )


@router.post("/optimization/preview", dependencies=[Depends(require_permissions("optimization:read"))])
def preview(payload: OptimizationPreviewRequest, db: DbSession, user: CurrentUser):
    data = service.preview(db, payload)
    return ok(data)


@router.post(
    "/optimization/requests",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permissions("optimization:run"))],
)
def submit(payload: OptimizationSubmitRequest, request: Request, db: DbSession, user: CurrentUser):
    req, plan, result = service.create_request_and_plan(db, payload, actor_id=user.id)
    audit.record(
        db, action="optimization.solve", actor=user, resource_type="optimization_plan",
        resource_id=plan.id,
        message=(
            f"{plan.code} {plan.solution_status}: {plan.covered_demand}/{plan.total_demand} "
            f"demands covered (objective {plan.objective_value:.0f})"
        ),
        metadata={"request_id": req.id, "infeasible": plan.solution_status == "infeasible"},
        request=request,
    )
    db.commit()
    return ok({"request": _request_dict(req), "plan": service.plan_to_dict(db, plan, detail=True), "solver": result})


@router.get("/optimization/plans/{plan_id}")
def get_plan(plan_id: int, db: DbSession, user: CurrentUser):
    plan = db.get(OptimizationPlan, plan_id)
    if plan is None:
        raise ApiError("Plan not found.", status_code=404, code="not_found")
    return ok(service.plan_to_dict(db, plan, detail=True))


@router.post(
    "/optimization/plans/{plan_id}/approve",
    dependencies=[Depends(require_permissions("optimization:approve"))],
)
def approve_plan(
    plan_id: int, payload: ApprovalRequest, request: Request, db: DbSession, user: CurrentUser
):
    from app.workflows import engine as workflow_engine

    plan = db.get(OptimizationPlan, plan_id)
    if plan is None:
        raise ApiError("Plan not found.", status_code=404, code="not_found")
    if not payload.approve:
        if plan.status not in ("proposed", "approved"):
            raise ApiError(
                f"Plan is {plan.status} and cannot be rejected.", status_code=409, code="invalid_state"
            )
        plan.status = "rejected"
        plan.rejection_reason = (payload.note or "Rejected by operator")[:400]
        audit.record(
            db, action="optimization.plan_rejected", actor=user, resource_type="optimization_plan",
            resource_id=plan.id, message=payload.note or "Plan rejected", request=request,
        )
        db.commit()
        return ok(service.plan_to_dict(db, plan, detail=True))
    if plan.solution_status == "infeasible":
        raise ApiError(
            "An infeasible plan cannot be approved. Re-solve with relaxed constraints or more resources.",
            status_code=409,
            code="infeasible_plan",
        )
    if plan.status == "approved":
        return ok(service.plan_to_dict(db, plan, detail=True))
    if plan.status != "proposed":
        raise ApiError(f"Plan is {plan.status}.", status_code=409, code="invalid_state")

    # reserving capacity is part of approval: it happens in this transaction so
    # a failure leaves no half-approved plan behind
    plan.status = "approved"
    from app.core.types import utcnow

    plan.approved_at = utcnow()
    plan.approved_by_id = user.id
    db.flush()

    workflow = db.scalar(
        select(__import__("app.models.workflow", fromlist=["WorkflowInstance"]).WorkflowInstance)
        .where(
            __import__("app.models.workflow", fromlist=["WorkflowInstance"]).WorkflowInstance.plan_id
            == plan.id
        )
    )
    try:
        if workflow:
            workflow_engine.advance_workflow(
                db,
                workflow_id=workflow.id,
                step="plan_approved",
                actor_id=user.id,
                payload={"note": payload.note},
            )
        else:
            _reserve_for_plan(db, plan, user.id)
    except ApiError:
        db.rollback()
        raise
    audit.record(
        db, action="optimization.plan_approved", actor=user, resource_type="optimization_plan",
        resource_id=plan.id,
        message=f"{plan.code} approved; resources reserved transactionally",
        metadata={"workflow_id": workflow.id if workflow else None}, request=request,
    )
    db.commit()
    plan = db.get(OptimizationPlan, plan_id)
    data = service.plan_to_dict(db, plan, detail=True)
    return ok(data)


def _reserve_for_plan(db, plan: OptimizationPlan, actor_id: int) -> None:
    from app.models.operations import Resource
    from app.services import resources as resource_service

    for assignment in db.scalars(
        select(__import__("app.models.optimization", fromlist=["OptimizationAssignment"]).OptimizationAssignment)
        .where(
            __import__("app.models.optimization", fromlist=["OptimizationAssignment"]).OptimizationAssignment.plan_id
            == plan.id
        )
    ).all():
        resource = db.get(Resource, assignment.resource_id)
        if resource is None:
            raise ApiError("A planned resource no longer exists.", status_code=409, code="resource_missing")
        resource_service.reserve(
            db,
            resource,
            quantity=assignment.quantity,
            repair_task_id=None,
            plan_id=plan.id,
            actor_id=actor_id,
        )


def _request_dict(r: OptimizationRequest) -> dict:
    return {
        "id": r.id,
        "code": r.code,
        "title": r.title,
        "objective": r.objective,
        "status": r.status,
        "requested_by_id": r.requested_by_id,
        "created_at": r.created_at,
        "incident_id": r.incident_id,
        "simulation_run_id": r.simulation_run_id,
    }
