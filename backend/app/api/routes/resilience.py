"""Resilience intelligence endpoints.

Criticality ranking, the risk heatmap, saved what-if scenarios, multi-objective
planning, replay and the investment planner all live here. They are administered
as one surface because they share a single idea: turn the stored dependency graph
and simulation history into a decision an operator can defend.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.deps import CurrentUser, DbSession, require_permissions
from app.core.responses import ok
from app.core.types import utcnow
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
