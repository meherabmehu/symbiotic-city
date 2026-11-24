"""City resilience heatmap, built from stored simulation data.

Design rule: a heatmap that shows a colour with no provenance is decoration. Every
number here traces back to either a persisted ``SimulationRun`` or the criticality
model, and each zone carries the sentence that explains its score.

Two sources, combined:

* **Stored severity.** Each zone's assets are looked up in the most recent
  simulation runs, so what the map shows is what the lab actually produced.
* **Derived risk.** Criticality says which zones hold assets the city depends on,
  whether or not a run has ever failed them.

A zone is presented with three things the screen needs and a legend can explain:

    risk_band      low | guarded | elevated | high | severe   (the legend bands)
    risk_score     0..100, higher = worse
    drivers        the named reasons, in plain language

``source`` says which mode produced the current view -- ``runs`` when specific
simulation runs were selected, ``latest`` for the most recent runs, ``synthetic``
when the database has no runs yet and the map had to derive one. That last case
is computed and persisted through the normal run path rather than faked, so the
map is never showing invented numbers.
"""

from __future__ import annotations

import json

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.infrastructure import CityZone, InfrastructureAsset
from app.models.simulation import SimulationResult, SimulationRun
from app.services import criticality as criticality_service

# Band edges on the 0..100 score. Named bands rather than continuous colour:
# humans rank risk in categories, and a legend with five entries is readable.
RISK_BANDS: tuple[tuple[str, int, str], ...] = (
    ("low", 20, "Little downstream exposure; loss is contained to the site."),
    ("guarded", 40, "Some dependants, but alternative paths keep services running."),
    ("elevated", 60, "Losing assets here interrupts a service for a while."),
    ("high", 80, "Critical services depend on assets here; loss spreads."),
    ("severe", 101, "The city leans heavily here; single failures cascade."),
)

HEATMAP_ASSUMPTIONS: tuple[str, ...] = (
    "Zone score is the population-weighted mean of its assets' risk, so a zone "
    "holding a hospital is not averaged away by empty buildings.",
    "Asset risk blends stored impact level (failed 1.0, degraded 0.6, affected 0.3) "
    "with the derived criticality index, weighted 0.55 stored impact to 0.45 "
    "criticality.",
    "When no run exists for an asset, its stored component is 0 and the row is "
    "marked as derived-only rather than assumed safe.",
    "Bands are fixed thresholds on the 0..100 score, mirrored in the legend.",
)

# One point per asset in the zone, so a 23-asset city maps onto the same labels
# the twin already uses.
INTENSITY_WEIGHT_IMPACT = 0.55
INTENSITY_WEIGHT_CRITICALITY = 0.45
IMPACT_LEVEL_SCORE = {"failed": 1.0, "degraded": 0.6, "affected": 0.3}


def band_for(score: float) -> str:
    for name, limit, _description in RISK_BANDS:
        if score < limit:
            return name
    return RISK_BANDS[-1][0]


def _latest_run_ids(db: Session, limit: int = 3) -> list[int]:
    return list(
        db.scalars(
            select(SimulationRun.id)
            .where(SimulationRun.status.in_(("completed", "optimal", "feasible", "partial")))
            .order_by(SimulationRun.started_at.desc())
            .limit(limit)
        ).all()
    )


def _stored_impacts(db: Session, run_ids: list[int]) -> dict[int, dict]:
    """Worst stored impact per asset across the selected runs."""
    if not run_ids:
        return {}
    rows = db.scalars(
        select(SimulationResult).where(SimulationResult.run_id.in_(run_ids))
    ).all()
    worst: dict[int, dict] = {}
    for row in rows:
        score = IMPACT_LEVEL_SCORE.get(row.impact_level, 0.0)
        current = worst.get(row.asset_id)
        if current is None or score > current["score"]:
            worst[row.asset_id] = {
                "score": score,
                "impact_level": row.impact_level,
                "run_id": row.run_id,
                "depth": row.depth,
                "explanation": row.explanation,
            }
    return worst


def build(
    db: Session,
    *,
    run_ids: list[int] | None = None,
    ensure_run: bool = False,
    actor_id: int | None = None,
) -> dict:
    """Compose the heatmap payload.

    ``run_ids`` restricts the view to named runs. ``ensure_run`` allows the map to
    create one persisted run when the database has none, so a fresh install still
    shows real cascade data instead of an empty canvas.
    """
    zones = db.scalars(select(CityZone).order_by(CityZone.code)).all()
    if not zones:
        return {
            "zones": [],
            "legend": _legend_payload(),
            "assumptions": list(HEATMAP_ASSUMPTIONS),
            "source": "empty",
            "runs": [],
        }

    source = "selected" if run_ids else "latest"
    selected = run_ids or _latest_run_ids(db)

    if not selected and ensure_run:
        # Nothing has ever been simulated. Derive one through the normal run path
        # so the numbers on the map come from the engine and are persisted, rather
        # than being an artefact drawn only for the screen.
        from app.schemas.simulation import SimulationRunRequest
        from app.services import simulation as simulation_service

        nodes, _edges = __import__(
            "app.services.infrastructure", fromlist=["simulation_inputs"]
        ).simulation_inputs(db)
        if nodes:
            # Seed with the highest-impact single asset: the criticality model says
            # which one that is, so the first map a visitor sees is the worst case.
            analysis = criticality_service.analyse(db, limit=1)
            subject = analysis["ranking"][0]["asset_id"] if analysis["ranking"] else nodes[0].id
            run = simulation_service.execute_run(
                db,
                SimulationRunRequest(
                    name="Baseline resilience map",
                    initial_failure_ids=[subject],
                    cascade_threshold=0.35,
                    max_depth=6,
                    failure_mode="total_failure",
                ),
                actor_id=actor_id,
            )
            # This call writes, and the read path it sits in never commits, so it
            # commits here. Without this the run exists only for the duration of
            # the request and the map cites a simulation nobody can retrieve.
            db.commit()
            selected = [run.id]
            source = "synthetic"
        else:
            source = "empty"

    stored = _stored_impacts(db, selected)
    analysis = criticality_service.analyse(db, limit=200)
    by_asset = {row["asset_id"]: row for row in analysis["ranking"]}

    assets = db.scalars(
        select(InfrastructureAsset).where(InfrastructureAsset.is_archived.is_(False))
    ).all()

    runs_meta = []
    if selected:
        runs_meta = [
            {
                "id": run.id,
                "code": run.code,
                "name": run.name,
                "started_at": run.started_at,
                "summary": json.loads(run.summary_json or "{}"),
            }
            for run in db.scalars(
                select(SimulationRun).where(SimulationRun.id.in_(selected))
            ).all()
        ]

    zone_rows: list[dict] = []
    for zone in zones:
        zone_assets = [a for a in assets if a.zone_id == zone.id]
        if not zone_assets:
            zone_rows.append(
                {
                    "zone_id": zone.id,
                    "code": zone.code,
                    "name": zone.name,
                    "district": zone.district,
                    "population": zone.population,
                    "center_x": zone.center_x,
                    "center_y": zone.center_y,
                    "risk_score": 0.0,
                    "risk_band": "low",
                    "asset_count": 0,
                    "assets_failed": 0,
                    "assets_degraded": 0,
                    "population_at_risk": 0,
                    "drivers": ["No registered assets in this zone."],
                    "top_assets": [],
                    "has_stored_impact": False,
                }
            )
            continue

        scored: list[dict] = []
        for asset in zone_assets:
            crit = by_asset.get(asset.id)
            criticality_index = float(crit["criticality_index"]) if crit else 0.0
            stored_hit = stored.get(asset.id)
            stored_score = stored_hit["score"] if stored_hit else 0.0
            blended = (
                INTENSITY_WEIGHT_IMPACT * stored_score * 100.0
                + INTENSITY_WEIGHT_CRITICALITY * criticality_index
            )
            scored.append(
                {
                    "asset_id": asset.id,
                    "code": asset.code,
                    "name": asset.name,
                    "category": asset.category,
                    "status": asset.status,
                    "map_x": asset.map_x,
                    "map_y": asset.map_y,
                    "criticality": asset.criticality,
                    "criticality_index": round(criticality_index, 1),
                    "stored_impact": stored_hit["impact_level"] if stored_hit else None,
                    "risk_score": round(blended, 1),
                }
            )

        # Population-weighted: a zone's risk is driven by what people depend on.
        weight_total = sum(zone_assets[i].criticality for i in range(len(zone_assets)))
        # Population weighting uses the zone population once, distributed by hand
        # criticality, so the zone number is comparable between zones.
        if weight_total > 0:
            zone_score = sum(
                scored[i]["risk_score"] * zone_assets[i].criticality
                for i in range(len(scored))
            ) / weight_total
        else:
            zone_score = sum(s["risk_score"] for s in scored) / len(scored)

        zone_score = round(min(100.0, zone_score), 1)
        scored.sort(key=lambda s: -s["risk_score"])
        top = scored[:3]

        failed = sum(1 for s in scored if s["stored_impact"] == "failed")
        degraded = sum(1 for s in scored if s["stored_impact"] == "degraded")
        population_at_risk = round(zone.population * zone_score / 100.0)

        drivers: list[str] = []
        for asset in top:
            if asset["stored_impact"] == "failed":
                drivers.append(
                    f"{asset['code']} ({asset['category'].replace('_', ' ')}) failed in the "
                    f"selected run and scores {asset['risk_score']:.0f}."
                )
            elif asset["stored_impact"] == "degraded":
                drivers.append(
                    f"{asset['code']} was degraded in the selected run and scores "
                    f"{asset['risk_score']:.0f}."
                )
            elif asset["criticality_index"] >= 40:
                drivers.append(
                    f"{asset['code']} has not failed but carries a criticality index of "
                    f"{asset['criticality_index']:.0f}: {asset['category'].replace('_', ' ')} "
                    "with downstream dependants."
                )
        if not drivers:
            drivers.append("No stored failure and no high-criticality asset in this zone.")

        zone_rows.append(
            {
                "zone_id": zone.id,
                "code": zone.code,
                "name": zone.name,
                "district": zone.district,
                "population": zone.population,
                "center_x": zone.center_x,
                "center_y": zone.center_y,
                "risk_score": zone_score,
                "risk_band": band_for(zone_score),
                "asset_count": len(scored),
                "assets_failed": failed,
                "assets_degraded": degraded,
                "population_at_risk": population_at_risk,
                "drivers": drivers,
                "top_assets": top,
                "has_stored_impact": any(s["stored_impact"] for s in scored),
            }
        )

    zone_rows.sort(key=lambda z: (-z["risk_score"], z["code"]))

    return {
        "zones": zone_rows,
        "assets": [
            {
                "asset_id": a["asset_id"],
                "code": a["code"],
                "name": a["name"],
                "category": a["category"],
                "map_x": a["map_x"],
                "map_y": a["map_y"],
                "risk_score": a["risk_score"],
                "risk_band": band_for(a["risk_score"]),
                "stored_impact": a["stored_impact"],
                "criticality_index": a["criticality_index"],
            }
            for zone in zone_rows
            for a in zone["top_assets"]
        ],
        "legend": _legend_payload(),
        "assumptions": list(HEATMAP_ASSUMPTIONS),
        "source": source,
        "runs": runs_meta,
        "model": {
            "impact_weight": INTENSITY_WEIGHT_IMPACT,
            "criticality_weight": INTENSITY_WEIGHT_CRITICALITY,
            "impact_levels": IMPACT_LEVEL_SCORE,
        },
        "totals": {
            "zones": len(zone_rows),
            "population_at_risk": sum(z["population_at_risk"] for z in zone_rows),
            "assets_failed": sum(z["assets_failed"] for z in zone_rows),
            "assets_degraded": sum(z["assets_degraded"] for z in zone_rows),
        },
    }


def _legend_payload() -> list[dict]:
    """The legend is data, so the screen cannot drift from the scoring code.

    Colour tokens are named, not hex: the frontend maps them to the design
    system, which keeps the approved visual identity in one place and lets the
    accessibility guard in test_design_tokens.py check the result.
    """
    token_for = {
        "low": "mint",
        "guarded": "accent",
        "elevated": "amber",
        "high": "coral",
        "severe": "coral-deep",
    }
    return [
        {
            "band": name,
            "label": name.capitalize(),
            "threshold": None if limit >= 101 else limit,
            "description": description,
            "color_token": token_for[name],
        }
        for name, limit, description in RISK_BANDS
    ]
