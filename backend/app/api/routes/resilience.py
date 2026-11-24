"""Resilience intelligence endpoints.

Criticality ranking, the risk heatmap, saved what-if scenarios, multi-objective
planning, replay and the investment planner all live here. They are administered
as one surface because they share a single idea: turn the stored dependency graph
and simulation history into a decision an operator can defend.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query, Request

from app.api.deps import CurrentUser, DbSession, require_permissions
from app.core.responses import ApiError, ok
from app.core.types import utcnow
from app.schemas.simulation import WhatIfObserveRequest, WhatIfScenarioCreate
from app.services import criticality as criticality_service

router = APIRouter(tags=["resilience"])


@router.get(
    "/resilience/criticality",
    dependencies=[Depends(require_permissions("resilience:read"))],
)
def get_criticality(
    db: DbSession,
    user: CurrentUser,
    limit: int = Query(25, ge=1, le=60),
):
    """Rank assets by derived, dependency-aware criticality.

    The hand-assigned ``criticality`` field says how important an asset is on its
    own; this says how much of the city leans on it. Both are returned so the
    screen can show where the two disagree, which is the interesting case.
    """
    data = criticality_service.analyse(db, limit=limit)
    data["generated_at"] = utcnow()
    return ok(data)


@router.get(
    "/resilience/criticality/{asset_id}/consequence",
    dependencies=[Depends(require_permissions("resilience:read"))],
)
def get_consequence(asset_id: int, db: DbSession, user: CurrentUser):
    """What actually breaks if this one asset fails, from the cascade engine."""
    return ok(criticality_service.consequence_of(db, asset_id))


@router.get(
    "/resilience/heatmap",
    dependencies=[Depends(require_permissions("resilience:read"))],
)
def get_heatmap(
    db: DbSession,
    user: CurrentUser,
    run_ids: list[int] | None = Query(
        None, max_length=4, description="Restrict to these simulation runs."
    ),
    ensure_run: bool = Query(
        False,
        description=(
            "Create one persisted baseline run when the database has none, so a "
            "fresh install shows real cascade data instead of an empty map."
        ),
    ),
):
    """Zone-by-zone resilience risk with an explanatory legend.

    Every zone reports a score, a band, and the plain-language reasons behind it,
    so the map can be read without knowing the model.
    """
    from app.services import heatmap as heatmap_service

    data = heatmap_service.build(
        db, run_ids=run_ids, ensure_run=ensure_run, actor_id=user.id
    )
    data["generated_at"] = utcnow()
    return ok(data)


# --------------------------------------------------------------------------- #
# What-if future simulator
# --------------------------------------------------------------------------- #


@router.get(
    "/resilience/whatif",
    dependencies=[Depends(require_permissions("resilience:read"))],
)
def list_whatifs(db: DbSession, user: CurrentUser):
    """Every saved what-if, newest reading first, with its recorded readings."""
    from app.services import whatif as whatif_service

    scenarios = whatif_service.list_scenarios(db)
    return ok(
        [
            whatif_service.scenario_dict(db, scenario)
            for scenario in scenarios
        ]
    )


@router.post(
    "/resilience/whatif",
    status_code=201,
    dependencies=[Depends(require_permissions("resilience:plan"))],
)
def create_whatif(
    payload: WhatIfScenarioCreate,
    request: Request,
    db: DbSession,
    user: CurrentUser,
):
    """Save a failure hypothesis so it can be run and compared later."""
    from app.services import audit
    from app.services import whatif as whatif_service

    scenario = whatif_service.create_scenario(
        db,
        name=payload.name,
        description=payload.description,
        initial_failure_ids=payload.initial_failure_ids,
        failure_mode=payload.failure_mode,
        cascade_threshold=payload.cascade_threshold,
        max_depth=payload.max_depth,
        random_seed=payload.random_seed,
        is_baseline=payload.is_baseline,
        actor_id=user.id,
    )
    audit.record(
        db,
        action="whatif.create",
        actor=user,
        resource_type="whatif_scenario",
        resource_id=scenario.id,
        message=f"{scenario.code} saved: {scenario.name}",
        metadata={"assets": payload.initial_failure_ids},
        request=request,
    )
    db.commit()
    return ok(whatif_service.scenario_dict(db, scenario))


@router.delete(
    "/resilience/whatif/{scenario_id}",
    dependencies=[Depends(require_permissions("resilience:plan"))],
)
def delete_whatif(scenario_id: int, request: Request, db: DbSession, user: CurrentUser):
    from app.models.simulation import WhatIfScenario
    from app.services import audit

    scenario = db.get(WhatIfScenario, scenario_id)
    if scenario is None:
        raise ApiError("Scenario not found.", status_code=404, code="not_found")
    code = scenario.code
    db.delete(scenario)
    audit.record(
        db,
        action="whatif.delete",
        actor=user,
        resource_type="whatif_scenario",
        resource_id=scenario_id,
        message=f"{code} deleted",
        request=request,
    )
    db.commit()
    return ok({"deleted": scenario_id})


@router.post(
    "/resilience/whatif/{scenario_id}/observe",
    status_code=201,
    dependencies=[Depends(require_permissions("resilience:plan"))],
)
def observe_whatif(
    scenario_id: int,
    payload: WhatIfObserveRequest,
    request: Request,
    db: DbSession,
    user: CurrentUser,
):
    """Run the scenario for real and record the reading taken from that run."""
    from app.models.simulation import WhatIfScenario
    from app.services import audit
    from app.services import whatif as whatif_service

    scenario = db.get(WhatIfScenario, scenario_id)
    if scenario is None:
        raise ApiError("Scenario not found.", status_code=404, code="not_found")
    observation = whatif_service.observe(db, scenario, note=payload.note, actor_id=user.id)
    audit.record(
        db,
        action="whatif.observe",
        actor=user,
        resource_type="whatif_scenario",
        resource_id=scenario.id,
        message=f"{scenario.code} recorded: {observation.headline}",
        metadata={"run_id": observation.run_id},
        request=request,
    )
    db.commit()
    return ok(
        {
            "observation_id": observation.id,
            "run_id": observation.run_id,
            "headline": observation.headline,
            "metrics": json.loads(observation.metrics_json or "{}"),
        }
    )


@router.get(
    "/resilience/whatif/compare",
    dependencies=[Depends(require_permissions("resilience:read"))],
)
def compare_whatifs(
    db: DbSession,
    user: CurrentUser,
    ids: list[int] = Query(..., min_length=2, max_length=4),
):
    """Compare saved scenarios and say what separates them."""
    from app.services import whatif as whatif_service

    return ok(whatif_service.compare(db, ids))
