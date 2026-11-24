"""Simulation scenario, run, result and comparison endpoints."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession, Pagination, require_permissions
from app.core.responses import ApiError, ok, paginated
from app.models.simulation import SimulationRun, SimulationScenario
from app.schemas.simulation import (
    ScenarioCreate,
    SimulationComparison,
    SimulationRunDetail,
    SimulationRunRequest,
)
from app.services import audit
from app.services import simulation as service
from app.simulation.engine import ASSUMPTIONS

router = APIRouter(tags=["simulation"])


@router.get(
    "/simulations/assumptions",
    dependencies=[Depends(require_permissions("simulation:read"))],
)
def assumptions():
    return ok({"assumptions": ASSUMPTIONS})


@router.get(
    "/scenarios",
    dependencies=[Depends(require_permissions("simulation:read"))],
)
def list_scenarios(db: DbSession, user: CurrentUser):
    rows = db.scalars(select(SimulationScenario).order_by(SimulationScenario.created_at.desc())).all()
    return ok([_scenario_dict(s) for s in rows])


@router.post(
    "/scenarios",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permissions("simulation:run"))],
)
def create_scenario(payload: ScenarioCreate, request: Request, db: DbSession, user: CurrentUser):
    scenario = SimulationScenario(
        name=payload.name,
        description=payload.description,
        failure_mode=payload.failure_mode,
        initial_failure_ids_json=json.dumps(payload.initial_failure_ids),
        cascade_threshold=payload.cascade_threshold,
        max_depth=payload.max_depth,
        random_seed=payload.random_seed,
        is_template=payload.save_as_template,
        created_by_id=user.id,
    )
    db.add(scenario)
    db.flush()
    audit.record(
        db, action="simulation.scenario_create", actor=user, resource_type="simulation_scenario",
        resource_id=scenario.id, message=f"Scenario '{scenario.name}' saved", request=request,
    )
    db.commit()
    return ok(_scenario_dict(scenario))


@router.get(
    "/simulations",
    dependencies=[Depends(require_permissions("simulation:read"))],
)
def list_runs(
    db: DbSession,
    user: CurrentUser,
    page: Pagination,
    search: str | None = Query(None, max_length=120),
    status_filter: str | None = Query(None, alias="status"),
    incident_id: int | None = None,
):
    items, total = service.list_runs(
        db,
        search=search,
        status=status_filter,
        incident_id=incident_id,
        offset=page.offset,
        limit=page.limit,
    )
    return paginated(
        [
            {
                "id": r.id,
                "code": r.code,
                "name": r.name,
                "status": r.status,
                "failure_mode": r.failure_mode,
                "cascade_threshold": r.cascade_threshold,
                "max_depth": r.max_depth,
                "random_seed": r.random_seed,
                "started_at": r.started_at,
                "completed_at": r.completed_at,
                "duration_ms": r.duration_ms,
                "triggered_by_id": r.triggered_by_id,
                "incident_id": r.incident_id,
                "summary": json.loads(r.summary_json or "{}"),
                "initial_failure_ids": json.loads(r.initial_failure_ids_json or "[]"),
            }
            for r in items
        ],
        total=total,
        page=page.page,
        page_size=page.page_size,
    )


@router.post(
    "/simulations/run",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permissions("simulation:run"))],
)
def run_simulation(payload: SimulationRunRequest, request: Request, db: DbSession, user: CurrentUser):
    run = service.execute_run(db, payload, actor_id=user.id)
    result = service.run_to_dict(db, run)
    audit.record(
        db, action="simulation.run", actor=user, resource_type="simulation_run", resource_id=run.id,
        message=(
            f"{run.code}: {result['summary'].get('assets_failed', 0)} failed, "
            f"{result['summary'].get('affected_population', 0)} people affected"
        ),
        metadata={"initial_failures": result["initial_failure_ids"], "mode": run.failure_mode},
        request=request,
    )
    db.commit()
    return ok(service.run_to_dict(db, run))


@router.get(
    "/simulations/{run_id}",
    dependencies=[Depends(require_permissions("simulation:read"))],
)
def get_run(run_id: int, db: DbSession, user: CurrentUser):
    run = db.get(SimulationRun, run_id)
    if run is None:
        raise ApiError("Simulation run not found.", status_code=404, code="not_found")
    return ok(service.run_to_dict(db, run))


@router.get(
    "/simulations/{run_id}/demands",
    dependencies=[Depends(require_permissions("simulation:read"))],
)
def run_demands(run_id: int, db: DbSession, user: CurrentUser):
    from app.services import optimization as optimization_service

    return ok(optimization_service.demands_from_simulation(db, run_id))


@router.get(
    "/simulations/compare/selected",
    dependencies=[Depends(require_permissions("simulation:read"))],
)
def compare(
    db: DbSession,
    user: CurrentUser,
    ids: list[int] = Query(..., min_length=2, max_length=4),
):
    data = service.compare_runs(db, ids)
    return ok(
        {
            "runs": [
                {
                    "id": r.id, "code": r.code, "name": r.name, "started_at": r.started_at,
                    "cascade_threshold": r.cascade_threshold, "failure_mode": r.failure_mode,
                }
                for r in data["runs"]
            ],
            "metrics": data["metrics"],
        }
    )


def _scenario_dict(s: SimulationScenario) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "description": s.description,
        "failure_mode": s.failure_mode,
        "cascade_threshold": s.cascade_threshold,
        "max_depth": s.max_depth,
        "random_seed": s.random_seed,
        "is_template": s.is_template,
        "created_at": s.created_at,
        "initial_failure_ids": json.loads(s.initial_failure_ids_json or "[]"),
    }
