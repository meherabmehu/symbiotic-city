"""Dependency-aware criticality: which assets matter, and why.

The asset register already carries a hand-assigned ``criticality`` 1-5. That
number says how important an asset is *in itself*, and nothing about how much of
the city leans on it. A substation with criticality 2 that feeds a hospital, a
water plant and a telecom exchange is a far worse thing to lose than a
criticality 2 substation feeding a car park.

This module derives that second number from the dependency graph, then uses the
existing cascade engine to turn it into a consequence statement a duty officer
can act on: run the failure, then report what actually breaks.

Model, stated so the UI can show it
-----------------------------------
``criticality_index`` (0..100, higher = worse to lose) is a weighted sum of four
normalised components, each computed from the stored graph:

    reach        how much of the city's critical-service capacity depends on it,
                 counted with graph distance decay so a direct feed counts fully
                 and a feed of a feed counts less;
    population   how many people live downstream of it;
    blast        how many assets it can take down (from the engine's own
                 affected count for a single-asset failure);
    single point assets whose loss makes a critical service unrecoverable
                 because no alternative path exists in the graph.

Weights are fixed constants, not learned, and they are reported in the response
so the ranking is auditable rather than mysterious:

    reach 0.40, blast 0.30, population 0.20, single point 0.10

Two properties are deliberate:

* **Reproducible.** The same graph produces the same ranking; there is no random
  sampling and no wall-clock dependency. The consequence figures come from
  ``simulate_cascade`` with the same default parameters the simulation lab uses
  (threshold 0.35, depth 6, total failure), and the snapshot hash is returned so
  a ranking can be tied to a specific graph state.
* **Honest about direction.** Dependencies run source -> target, meaning "target
  depends on source". Criticality therefore flows *upstream*: an asset is
  critical when things downstream of it are critical. Computing reach by walking
  successors is what makes that true.

The per-asset consequence estimate is the engine's answer, not a formula of our
own: we inject that single failure and report the failed/degraded set, the
population affected, the critical services lost and the depth reached.
"""

from __future__ import annotations

import json
from collections import deque

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.responses import ApiError
from app.models.infrastructure import (
    CATEGORY_PRIORITY,
    AssetCategory,
    CityZone,
    InfrastructureAsset,
    InfrastructureDependency,
)
from app.simulation.engine import AssetNode, DependencyEdge, simulate_cascade
from app.services import infrastructure as infra_service

# Categories whose loss is a public-safety event rather than an inconvenience.
CRITICAL_CATEGORIES: tuple[str, ...] = (
    AssetCategory.HOSPITAL,
    AssetCategory.WATER_TREATMENT,
    AssetCategory.WATER_PUMP,
    AssetCategory.TELECOM,
)

# Weights are exposed in the payload so the ranking can be explained, and kept
# here as named constants so a test can pin them.
WEIGHT_REACH = 0.40
WEIGHT_BLAST = 0.30
WEIGHT_POPULATION = 0.20
WEIGHT_SINGLE_POINT = 0.10

MODEL_WEIGHTS: dict[str, float] = {
    "reach": WEIGHT_REACH,
    "blast": WEIGHT_BLAST,
    "population": WEIGHT_POPULATION,
    "single_point": WEIGHT_SINGLE_POINT,
}

# Distance decay for the reach walk: a direct dependant contributes 1.0, its
# dependant 0.5, the next 0.25, and so on. Beyond this many hops the contribution
# is below 1/32 and not worth walking.
REACH_DECAY = 0.5
REACH_MAX_HOPS = 5

ASSUMPTIONS: tuple[str, ...] = (
    "Dependencies mean 'target depends on source', so criticality flows upstream.",
    "Reach decays by half per hop: a direct dependant counts 1.0, its dependant 0.5.",
    f"Critical-service categories: {', '.join(CRITICAL_CATEGORIES)}.",
    "Blast radius is measured with the cascade engine at threshold 0.35, depth 6, "
    "total failure of the subject asset only.",
    "Population downstream counts the population_weight of every reachable dependant, "
    "not the population of the subject asset.",
    "Weights are fixed constants, not learned; they are returned with every ranking.",
)


def _decayed_reach(
    graph: dict[int, list[tuple[int, float, float]]],
    subject: int,
    critical_ids: set[int],
) -> tuple[float, float, int]:
    """Total critical-service reach downstream of ``subject``, with hop decay.

    Returns ``(critical_reach, all_reach, critical_services_reached)``. The walk is
    breadth first over successors and stops at ``REACH_MAX_HOPS``; it is a plain
    visit-with-best-weight loop rather than DFS so a diamond in the graph cannot
    inflate the score by visiting the same asset twice.
    """
    best: dict[int, float] = {}
    queue: deque[tuple[int, int, float]] = deque([(subject, 0, 1.0)])
    while queue:
        node, hops, weight = queue.popleft()
        if hops >= REACH_MAX_HOPS:
            continue
        for target, _impact, _redundancy in graph.get(node, []):
            contribution = weight * REACH_DECAY
            if contribution <= best.get(target, 0.0):
                continue
            best[target] = contribution
            queue.append((target, hops + 1, contribution))

    critical_reach = sum(w for node, w in best.items() if node in critical_ids)
    return critical_reach, sum(best.values()), len([n for n in best if n in critical_ids])


def _single_point_dependants(
    graph: dict[int, list[tuple[int, float, float]]],
    subject: int,
    assets: dict[int, InfrastructureAsset],
) -> list[int]:
    """Critical assets that depend on ``subject`` and have no other supplier.

    "No other supplier" is read from the graph: among the subject's direct
    dependants, one is a single point if every other predecessor edge into it is
    zero-impact or fully redundant. This is what distinguishes "the hospital has a
    second feeder" from "the hospital has only this substation".
    """
    incoming: dict[int, int] = {}
    for node, edges in graph.items():
        for target, impact, redundancy in edges:
            if impact * (1.0 - redundancy) > 0.0:
                incoming[target] = incoming.get(target, 0) + 1

    flagged: list[int] = []
    for target, impact, redundancy in graph.get(subject, []):
        effectively_dependent = impact * (1.0 - redundancy) > 0.0
        if not effectively_dependent:
            continue
        asset = assets.get(target)
        if asset is None or asset.category not in CRITICAL_CATEGORIES:
            continue
        if incoming.get(target, 0) <= 1:
            flagged.append(target)
    return flagged


def _rank(values: dict[int, float]) -> dict[int, float]:
    """Scale a metric to 0..100 across the fleet.

    A metric with no spread (every asset equal) maps to 0 for all of them rather
    than dividing by zero, and that is the honest answer: nothing distinguishes
    them, so the component cannot rank anything.
    """
    if not values:
        return {}
    low, high = min(values.values()), max(values.values())
    if high - low < 1e-9:
        return {key: 0.0 for key in values}
    return {key: 100.0 * (value - low) / (high - low) for key, value in values.items()}


def analyse(db: Session, *, limit: int = 25, refresh: bool = False) -> dict:
    """Rank every active asset by derived criticality, with consequences.

    ``limit`` bounds how many ranked rows are returned, not how many are scored:
    the whole fleet is measured and ranked, and the payload carries the head of
    that ranking.
    """
    nodes, edges = infra_service.simulation_inputs(db)
    if not nodes:
        raise ApiError(
            "There is no infrastructure to analyse yet.",
            status_code=409,
            code="empty_city",
        )

    assets = {
        a.id: a
        for a in db.scalars(
            select(InfrastructureAsset).where(InfrastructureAsset.is_archived.is_(False))
        ).all()
    }
    zone_by_id = {z.id: z for z in db.scalars(select(CityZone)).all()}
    critical_ids = {aid for aid, a in assets.items() if a.category in CRITICAL_CATEGORIES}
    population_by_id = {n.id: n.population_weight for n in nodes}

    adjacency: dict[int, list[tuple[int, float, float]]] = {}
    for edge in edges:
        adjacency.setdefault(edge.source, []).append(
            (edge.target, edge.impact_weight, edge.redundancy)
        )

    reach_raw: dict[int, float] = {}
    all_reach_raw: dict[int, float] = {}
    single_point_hits: dict[int, int] = {}
    for asset in assets.values():
        critical_reach, total_reach, _count = _decayed_reach(
            adjacency, asset.id, critical_ids
        )
        reach_raw[asset.id] = critical_reach
        all_reach_raw[asset.id] = total_reach
        single_point_hits[asset.id] = len(_single_point_dependants(adjacency, asset.id, assets))

    # Blast radius and population come from the engine, one single-asset failure
    # per subject -- the engine's own answer rather than a formula of ours.
    blast_raw: dict[int, float] = {}
    population_raw: dict[int, float] = {}
    consequences: dict[int, dict] = {}

    # Every asset is measured. A single-asset cascade over the seeded city costs
    # about 1.5 ms, so shortlisting would save nothing while leaving part of the
    # fleet with no consequence estimate -- which reads as "unknown risk" on a
    # heatmap that is supposed to rank the whole city.
    for asset_id in list(assets):
        result = simulate_cascade(
            nodes,
            edges,
            initial_failures=[asset_id],
            cascade_threshold=0.35,
            max_depth=6,
            failure_mode="total_failure",
            run_code=f"CRIT-{asset_id}",
            scenario_label=f"Criticality probe: {assets[asset_id].code}",
        )
        failed = [i for i in result.impacts if i.impact_level == "failed"]
        degraded = [i for i in result.impacts if i.impact_level == "degraded"]
        downstream_population = sum(
            population_by_id.get(i.asset_id, 0) for i in result.impacts
            if i.asset_id != asset_id
        )
        critical_lost = sorted(
            {
                assets[i.asset_id].category
                for i in result.impacts
                if i.asset_id in assets and assets[i.asset_id].category in CRITICAL_CATEGORIES
            }
        )
        blast_raw[asset_id] = float(len(result.impacts))
        population_raw[asset_id] = float(downstream_population)
        consequences[asset_id] = {
            "assets_failed": len(failed),
            "assets_degraded": len(degraded),
            "assets_affected": len(result.impacts),
            "population_affected": downstream_population,
            "max_depth_reached": result.summary.get("max_depth_reached", 0),
            "critical_services_lost": critical_lost,
            "critical_services_lost_count": len(critical_lost),
            "snapshot_hash": result.snapshot_hash,
            "explanation": (
                f"Losing {assets[asset_id].code} takes down {len(failed)} asset(s) to depth "
                f"{result.summary.get('max_depth_reached', 0)} and affects "
                f"{downstream_population:,} people"
                + (
                    f"; critical services lost: {', '.join(c.replace('_', ' ') for c in critical_lost)}."
                    if critical_lost
                    else "; no critical service is lost."
                )
            ),
        }

    # Components are ranked across the whole fleet so every asset gets a score.
    reach_scaled = _rank(reach_raw)
    blast_scaled = _rank(blast_raw)
    population_scaled = _rank(population_raw)
    single_point_scaled = _rank({k: float(v) for k, v in single_point_hits.items()})

    ranked: list[dict] = []
    for asset in assets.values():
        components = {
            "reach": reach_scaled.get(asset.id, 0.0),
            "blast": blast_scaled.get(asset.id, 0.0),
            "population": population_scaled.get(asset.id, 0.0),
            "single_point": single_point_scaled.get(asset.id, 0.0),
        }
        index = (
            WEIGHT_REACH * components["reach"]
            + WEIGHT_BLAST * components["blast"]
            + WEIGHT_POPULATION * components["population"]
            + WEIGHT_SINGLE_POINT * components["single_point"]
        )
        zone = zone_by_id.get(asset.zone_id) if asset.zone_id else None
        ranked.append(
            {
                "asset_id": asset.id,
                "code": asset.code,
                "name": asset.name,
                "category": asset.category,
                "status": asset.status,
                "criticality": asset.criticality,
                "zone": {"id": zone.id, "code": zone.code, "name": zone.name} if zone else None,
                "map_x": asset.map_x,
                "map_y": asset.map_y,
                "criticality_index": round(index, 1),
                "components": {k: round(v, 1) for k, v in components.items()},
                "dependants_direct": len(adjacency.get(asset.id, [])),
                "reach_score": round(reach_raw.get(asset.id, 0.0), 3),
                "reach_all": round(all_reach_raw.get(asset.id, 0.0), 3),
                "single_point_dependants": single_point_hits.get(asset.id, 0),
                "consequence": consequences.get(asset.id),
            }
        )

    ranked.sort(key=lambda row: (-row["criticality_index"], -row["reach_score"], row["code"]))

    top = ranked[: max(limit, 1)]
    return {
        "generated_at": None,  # filled by the route so the value is the response time
        "model": {
            "weights": MODEL_WEIGHTS,
            "critical_categories": list(CRITICAL_CATEGORIES),
            "reach_decay": REACH_DECAY,
            "reach_max_hops": REACH_MAX_HOPS,
            "assumptions": list(ASSUMPTIONS),
        },
        "fleet": {
            "assets": len(ranked),
            "total_dependencies": len(edges),
            "critical_assets": len(critical_ids),
        },
        "ranking": top,
    }


def consequence_of(db: Session, asset_id: int) -> dict:
    """Re-derive the consequence estimate for one asset on demand."""
    asset = db.get(InfrastructureAsset, asset_id)
    if asset is None or asset.is_archived:
        raise ApiError("Infrastructure asset not found.", status_code=404, code="not_found")

    nodes, edges = infra_service.simulation_inputs(db)
    known = {n.id for n in nodes}
    if asset_id not in known:
        raise ApiError(
            "This asset is not part of the active simulation graph.",
            status_code=409,
            code="asset_not_in_graph",
        )
    assets = {a.id: a for a in db.scalars(select(InfrastructureAsset)).all()}
    population = {n.id: n.population_weight for n in nodes}

    result = simulate_cascade(
        nodes,
        edges,
        initial_failures=[asset_id],
        cascade_threshold=0.35,
        max_depth=6,
        failure_mode="total_failure",
        run_code=f"CRIT-{asset_id}",
        scenario_label=f"Criticality probe: {asset.code}",
    )
    downstream_population = sum(
        population.get(i.asset_id, 0) for i in result.impacts if i.asset_id != asset_id
    )
    critical_lost = sorted(
        {
            assets[i.asset_id].category
            for i in result.impacts
            if i.asset_id in assets and assets[i.asset_id].category in CRITICAL_CATEGORIES
        }
    )
    return {
        "asset": {
            "id": asset.id,
            "code": asset.code,
            "name": asset.name,
            "category": asset.category,
        },
        "assumptions": list(ASSUMPTIONS),
        "summary": result.summary,
        "impacted": [
            {
                "asset_id": i.asset_id,
                "code": i.code,
                "name": i.name,
                "category": i.category,
                "impact_level": i.impact_level,
                "depth": i.depth,
                "impact_score": round(i.impact_score, 3),
                "population_affected": i.affected_population,
                "explanation": i.explanation,
            }
            for i in result.impacts
        ],
        "population_affected": downstream_population,
        "critical_services_lost": critical_lost,
        "snapshot_hash": result.snapshot_hash,
        "timeline": result.timeline,
    }
