"""Cascading failure propagation engine.

Model
=====
The city is modelled as a directed graph ``G = (V, E)`` where every asset is a
node and every dependency is an edge ``source -> target`` meaning *"the target
requires the source to operate"*. Edges carry two numbers:

``impact_weight``
    How much of the target's capacity is lost when the source is completely
    down (0..1).
``redundancy``
    How much of that loss the target can absorb through its own fallbacks
    (0..1). A hospital on a diesel generator has high redundancy; a water pump
    with no backup has none.

Propagation
===========
Failures are propagated breadth first. A node enters the frontier when the
accumulated *supply deficit* it receives from its failed/dependent suppliers
exceeds its ``cascade_threshold``::

    deficit(node) = 1 - prod(1 - max(0, impact_weight_e * (1 - redundancy_e)))

That product form means two independent partially-failing feeds do not add
linearly, which matches how redundant infrastructure behaves better than a
naive sum. Nodes whose deficit exceeds the threshold are marked ``failed``;
nodes above 60 % of the threshold are marked ``degraded`` (they keep running
with reduced capacity). Every step records the propagation depth so the UI can
replay the cascade in order.

Determinism
===========
The engine performs no random sampling. ``random_seed`` is part of every run
record and of the snapshot hash so that results are reproducible byte for byte
for the same scenario + snapshot + parameters. The seed is used only by the
optional noise term in :func:`apply_load_sensitivity`, which is disabled by
default (``noise=0.0``), keeping the core deterministic.

Documented limitations
======================
* Steady-state only — no time-of-day load curves or repair races. The model is
  a resilience screening tool, not a validated electrical/water flow solver.
* Dependency weights are curated estimates for the fictional city of
  *Aurora Vale*, not measured engineering data.
* Cycles are detected and broken for traversal, but cyclic dependencies are a
  data quality error reported in the result payload rather than silently fixed.
"""
from __future__ import annotations

import hashlib
import json
import math
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime

import networkx as nx

from app.models.infrastructure import (
    CATEGORY_POPULATION_WEIGHT,
    AssetCategory,
)

FAILED = "failed"
DEGRADED = "degraded"
AFFECTED = "affected"
OPERATIONAL = "operational"

DEGRADED_RATIO = 0.6  # share of the threshold that marks a node "degraded"
CORE_CRITICAL_CATEGORIES = {
    AssetCategory.HOSPITAL,
    AssetCategory.WATER_TREATMENT,
    AssetCategory.WATER_PUMP,
}


@dataclass(slots=True)
class AssetNode:
    id: int
    code: str
    name: str
    category: str
    criticality: int
    status: str = OPERATIONAL
    capacity: float = 100.0
    load_percent: float = 50.0
    map_x: float = 50.0
    map_y: float = 50.0

    @property
    def population_weight(self) -> int:
        return CATEGORY_POPULATION_WEIGHT.get(self.category, 500)


@dataclass(slots=True)
class DependencyEdge:
    source: int
    target: int
    impact_weight: float = 1.0
    redundancy: float = 0.0
    dependency_type: str = "power"


@dataclass(slots=True)
class ImpactRecord:
    asset_id: int
    code: str
    name: str
    category: str
    impact_level: str
    depth: int
    impact_score: float
    capacity_loss_percent: float
    affected_population: int
    cause_asset_id: int | None
    explanation: str

    def as_dict(self) -> dict:
        return {
            "asset_id": self.asset_id,
            "code": self.code,
            "name": self.name,
            "category": self.category,
            "impact_level": self.impact_level,
            "depth": self.depth,
            "impact_score": round(self.impact_score, 4),
            "capacity_loss_percent": round(self.capacity_loss_percent, 2),
            "affected_population": self.affected_population,
            "cause_asset_id": self.cause_asset_id,
            "explanation": self.explanation,
        }


@dataclass
class CascadeResult:
    run_code: str
    status: str
    initial_failures: list[int]
    impacts: list[ImpactRecord]
    summary: dict
    timeline: list[dict]
    graph_warnings: list[str]
    snapshot_hash: str
    assumptions: list[str]
    duration_ms: int
    random_seed: int
    scenario_label: str
    generated_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_dict(self) -> dict:
        """Serialise the result.

        ``generated_at`` is excluded on purpose: two runs with identical inputs
        produce identical payloads, which is what the determinism guarantee
        covers. The timestamp is stored on the run record instead.
        """
        return {
            "run_code": self.run_code,
            "status": self.status,
            "initial_failures": self.initial_failures,
            "impacts": [i.as_dict() for i in self.impacts],
            "summary": self.summary,
            "timeline": self.timeline,
            "graph_warnings": self.graph_warnings,
            "snapshot_hash": self.snapshot_hash,
            "assumptions": self.assumptions,
            "duration_ms": self.duration_ms,
            "random_seed": self.random_seed,
            "scenario_label": self.scenario_label,
        }


ASSUMPTIONS = [
    "Steady-state cascade model: no time-of-day load curves, no repair-in-progress racing.",
    "Dependency weights and redundancy factors are curated estimates for the synthetic city of Aurora Vale.",
    "Two independent partially-failing feeds are combined multiplicatively, not additively.",
    "A node is 'failed' when its supply deficit exceeds the cascade threshold, 'degraded' above 60% of it.",
    "Simulation is deterministic for a fixed graph snapshot, parameters and seed; no ML model is involved.",
    "Results are decision support for the exercise and are not validated predictions of a real city.",
]


def build_graph(
    assets: list[AssetNode], edges: list[DependencyEdge]
) -> tuple[nx.DiGraph, list[str]]:
    """Build the dependency graph, reporting data-quality problems."""
    warnings: list[str] = []
    graph = nx.DiGraph()
    known = {a.id for a in assets}
    for asset in assets:
        graph.add_node(
            asset.id,
            code=asset.code,
            name=asset.name,
            category=asset.category,
            criticality=asset.criticality,
            status=asset.status,
            capacity=asset.capacity,
            load_percent=asset.load_percent,
            map_x=asset.map_x,
            map_y=asset.map_y,
            population_weight=asset.population_weight,
        )
    seen: set[tuple[int, int]] = set()
    for edge in edges:
        if edge.source not in known or edge.target not in known:
            warnings.append(
                f"Dependency {edge.source}->{edge.target} references a missing asset and was ignored."
            )
            continue
        if edge.source == edge.target:
            warnings.append(f"Self dependency on asset {edge.source} ignored.")
            continue
        if (edge.source, edge.target) in seen:
            warnings.append(f"Duplicate dependency {edge.source}->{edge.target} ignored.")
            continue
        seen.add((edge.source, edge.target))
        graph.add_edge(
            edge.source,
            edge.target,
            impact_weight=max(0.0, min(1.0, edge.impact_weight)),
            redundancy=max(0.0, min(1.0, edge.redundancy)),
            dependency_type=edge.dependency_type,
        )
    cycles = list(nx.simple_cycles(graph))
    for cycle in cycles[:5]:
        warnings.append(
            "Circular dependency detected: " + " -> ".join(str(n) for n in cycle + [cycle[0]])
        )
    return graph, warnings


def snapshot_hash(graph: nx.DiGraph, params: dict) -> str:
    payload = {
        "nodes": sorted(
            [n, {k: graph.nodes[n].get(k) for k in ("code", "category", "status", "criticality")}]
            for n in graph.nodes
        ),
        "edges": sorted(
            [u, v, round(d.get("impact_weight", 1.0), 4), round(d.get("redundancy", 0.0), 4)]
            for u, v, d in graph.edges(data=True)
        ),
        "params": params,
    }
    blob = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def _accumulated_deficit(
    graph: nx.DiGraph, node: int, failed: set[int], impacts: dict[int, ImpactRecord]
) -> tuple[float, int | None, list[str]]:
    """Combine every supplier deficit affecting ``node``."""
    survival = 1.0
    dominant: int | None = None
    dominant_share = 0.0
    reasons: list[str] = []
    for source in graph.predecessors(node):
        data = graph.edges[source, node]
        weight = float(data.get("impact_weight", 1.0))
        redundancy = float(data.get("redundancy", 0.0))
        if source in failed:
            loss = weight * (1.0 - redundancy)
        elif source in impacts:
            # degraded supplier only delivers the capacity it still has
            delivered = max(0.0, 1.0 - impacts[source].capacity_loss_percent / 100.0)
            loss = weight * (1.0 - redundancy) * (1.0 - delivered)
        else:
            continue
        if loss <= 0:
            continue
        survival *= 1.0 - min(1.0, loss)
        share = loss
        if share > dominant_share:
            dominant_share = share
            dominant = source
        reasons.append(
            f"{graph.nodes[source]['code']} "
            f"{'failed' if source in failed else 'degraded'} "
            f"(dependency weight {weight:.2f}, redundancy {redundancy:.2f})"
        )
    deficit = 1.0 - survival
    return deficit, dominant, reasons


def simulate_cascade(
    assets: list[AssetNode],
    edges: list[DependencyEdge],
    *,
    initial_failures: list[int],
    cascade_threshold: float = 0.35,
    max_depth: int = 6,
    failure_mode: str = "total_failure",
    random_seed: int = 42,
    run_code: str = "SIM",
    scenario_label: str = "Controlled failure",
    include_core_services: bool = True,
) -> CascadeResult:
    """Run a breadth-first cascade from ``initial_failures``.

    ``failure_mode`` is one of ``total_failure`` (node is fully down),
    ``capacity_loss`` (node loses ``min(threshold, 0.75)`` of its capacity) or
    ``maintenance`` (node is offline for maintenance and propagates less).
    """
    started = time.perf_counter()
    params = {
        "initial_failures": sorted(initial_failures),
        "cascade_threshold": round(cascade_threshold, 4),
        "max_depth": max_depth,
        "failure_mode": failure_mode,
        "random_seed": random_seed,
    }
    graph, warnings = build_graph(assets, edges)
    by_id = {a.id: a for a in assets}
    assumptions = list(ASSUMPTIONS)

    unknown = [a for a in initial_failures if a not in by_id]
    if unknown:
        warnings.append(f"Initial failures reference unknown assets: {unknown}.")
    initial = [a for a in dict.fromkeys(initial_failures) if a in by_id]
    if not initial:
        return CascadeResult(
            run_code=run_code,
            status="failed",
            initial_failures=[],
            impacts=[],
            summary={"error": "no_valid_initial_failure"},
            timeline=[],
            graph_warnings=warnings,
            snapshot_hash=snapshot_hash(graph, params),
            assumptions=assumptions,
            duration_ms=int((time.perf_counter() - started) * 1000),
            random_seed=random_seed,
            scenario_label=scenario_label,
        )

    threshold = max(0.01, min(1.0, cascade_threshold))
    mode_loss = {
        "total_failure": 1.0,
        "capacity_loss": 0.75,
        "maintenance": 0.4,
    }.get(failure_mode, 1.0)

    impacts: dict[int, ImpactRecord] = {}
    failed: set[int] = set()
    timeline: list[dict] = []

    def _mark(asset_id: int, level: str, depth: int, score: float, cause: int | None, why: str):
        node = by_id[asset_id]
        loss_percent = 100.0 if level == FAILED else round(100.0 * (1 - (1 - min(score, 0.95))), 2)
        record = ImpactRecord(
            asset_id=asset_id,
            code=node.code,
            name=node.name,
            category=node.category,
            impact_level=level,
            depth=depth,
            impact_score=min(1.0, score),
            capacity_loss_percent=loss_percent,
            affected_population=int(node.population_weight * (loss_percent / 100.0)),
            cause_asset_id=cause,
            explanation=why,
        )
        impacts[asset_id] = record
        if level == FAILED:
            failed.add(asset_id)

    for asset_id in initial:
        node = by_id[asset_id]
        _mark(
            asset_id,
            FAILED,
            0,
            mode_loss,
            None,
            f"Initial failure injected: {node.name} ({node.code}) taken down by the scenario operator.",
        )
        timeline.append(
            {
                "depth": 0,
                "asset_id": asset_id,
                "code": node.code,
                "level": FAILED,
                "reason": "initial failure",
                "affected_population": impacts[asset_id].affected_population,
            }
        )

    frontier: deque[tuple[int, int]] = deque((asset_id, 0) for asset_id in initial)

    while frontier:
        current, depth = frontier.popleft()
        if depth >= max_depth:
            continue
        for neighbour in graph.successors(current):
            if neighbour in failed:
                continue
            neighbour_depth = depth + 1
            # Re-evaluate this node even if it was reached earlier. A node first
            # touched at depth 1 may have had only one failed supplier then; a
            # deeper supplier that fails later adds to the same deficit and can
            # push it over the threshold. Pinning the first verdict made the
            # cascade depend on traversal order and under-reported failures.
            # The deficit is recomputed from the current failed set, so a node
            # already marked degraded is promoted to failed when it crosses.
            deficit, dominant, reasons = _accumulated_deficit(graph, neighbour, failed, impacts)
            if deficit <= 0:
                continue
            if deficit >= threshold:
                node = by_id[neighbour]
                cause = dominant if dominant is not None else current
                _mark(
                    neighbour,
                    FAILED,
                    neighbour_depth,
                    deficit,
                    cause,
                    "Cascading failure: supply deficit "
                    f"{deficit * 100:.0f}% exceeds threshold {threshold * 100:.0f}% — "
                    + "; ".join(reasons[:3]),
                )
                timeline.append(
                    {
                        "depth": neighbour_depth,
                        "asset_id": neighbour,
                        "code": node.code,
                        "level": FAILED,
                        "reason": f"deficit {deficit * 100:.0f}% vs threshold {threshold * 100:.0f}%",
                        "affected_population": impacts[neighbour].affected_population,
                    }
                )
                frontier.append((neighbour, neighbour_depth))
            elif deficit >= threshold * DEGRADED_RATIO and neighbour not in impacts:
                node = by_id[neighbour]
                _mark(
                    neighbour,
                    DEGRADED,
                    neighbour_depth,
                    deficit,
                    dominant or current,
                    "Residual capacity only: supply deficit "
                    f"{deficit * 100:.0f}% is above {DEGRADED_RATIO * 100:.0f}% of the "
                    f"{threshold * 100:.0f}% cascade threshold — " + "; ".join(reasons[:3]),
                )
                timeline.append(
                    {
                        "depth": neighbour_depth,
                        "asset_id": neighbour,
                        "code": node.code,
                        "level": DEGRADED,
                        "reason": f"deficit {deficit * 100:.0f}% below cascade threshold",
                        "affected_population": impacts[neighbour].affected_population,
                    }
                )

    # directly adjacent nodes with a small deficit are reported as "affected"
    for asset_id in list(impacts):
        if impacts[asset_id].impact_level == DEGRADED:
            continue
        if impacts[asset_id].depth >= max_depth:
            continue
        for neighbour in graph.successors(asset_id):
            if neighbour in impacts:
                continue
            node = by_id.get(neighbour)
            if node is None:
                continue
            impacts[neighbour] = ImpactRecord(
                asset_id=neighbour,
                code=node.code,
                name=node.name,
                category=node.category,
                impact_level=AFFECTED,
                depth=impacts[asset_id].depth + 1,
                impact_score=threshold * 0.5,
                capacity_loss_percent=0.0,
                affected_population=0,
                cause_asset_id=asset_id,
                explanation=(
                    f"Dependency on failed asset {by_id[asset_id].code} detected but still within "
                    "its redundancy envelope; no capacity loss modelled."
                ),
            )

    ordered = sorted(
        impacts.values(), key=lambda r: (r.depth, 0 if r.impact_level == FAILED else 1, r.code)
    )

    failed_nodes = [r for r in ordered if r.impact_level == FAILED]
    degraded_nodes = [r for r in ordered if r.impact_level == DEGRADED]
    affected_only = [r for r in ordered if r.impact_level == AFFECTED]
    critical_services_down = [
        r.code for r in failed_nodes if r.category in CORE_CRITICAL_CATEGORIES
    ]
    population = sum(r.affected_population for r in ordered)
    severity_index = 0.0
    if by_id:
        weighted = sum(
            (4 - min(3, by_id[r.asset_id].criticality)) * r.impact_score for r in ordered
        )
        severity_index = min(
            100.0, round(100.0 * weighted / max(1.0, 4.0 * len(by_id) / 3), 2)
        )
    category_breakdown: dict[str, int] = {}
    for record in ordered:
        category_breakdown[record.category] = category_breakdown.get(record.category, 0) + 1

    summary = {
        "assets_total": len(by_id),
        "assets_impacted": len(ordered),
        "assets_failed": len(failed_nodes),
        "assets_degraded": len(degraded_nodes),
        "assets_affected": len(affected_only),
        "max_depth_reached": max((r.depth for r in ordered), default=0),
        "affected_population": population,
        "critical_services_down": critical_services_down,
        "severity_index": severity_index,
        "cascade_category_breakdown": category_breakdown,
        "failure_mode": failure_mode,
        "cascade_threshold": threshold,
    }

    return CascadeResult(
        run_code=run_code,
        status="completed",
        initial_failures=initial,
        impacts=ordered,
        summary=summary,
        timeline=sorted(timeline, key=lambda t: (t["depth"], t["code"])),
        graph_warnings=warnings,
        snapshot_hash=snapshot_hash(graph, params),
        assumptions=assumptions,
        duration_ms=int((time.perf_counter() - started) * 1000),
        random_seed=random_seed,
        scenario_label=scenario_label,
    )


def recovery_projection(
    assets: list[AssetNode],
    edges: list[DependencyEdge],
    *,
    restore_ids: list[int],
    initial_failures: list[int],
    cascade_threshold: float = 0.35,
    max_depth: int = 6,
) -> dict:
    """Project how many assets come back if ``restore_ids`` are repaired first.

    Used to show operators the difference between repair orders.
    """
    before = simulate_cascade(
        assets,
        edges,
        initial_failures=initial_failures,
        cascade_threshold=cascade_threshold,
        max_depth=max_depth,
        run_code="SIM-PROJ-BEFORE",
    )
    base_failed = {i.asset_id for i in before.impacts if i.impact_level == FAILED}
    restored = sorted(set(restore_ids) & base_failed)
    # assets not in the restore set and not downstream of them stay down
    graph, _ = build_graph(assets, edges)
    still_down = set(base_failed) - set(restored)
    # removing a restore candidate may also clear nodes that only it fed
    changed = True
    while changed:
        changed = False
        for node in list(still_down):
            suppliers = [s for s in graph.predecessors(node) if s in still_down]
            other_suppliers = [
                s
                for s in graph.predecessors(node)
                if s not in still_down and s not in base_failed
            ]
            if not suppliers and other_suppliers:
                still_down.discard(node)
                changed = True
    after_failed = still_down
    recovered = sorted(base_failed - after_failed)
    code_of = {a.id: a.code for a in assets}
    return {
        "restored_assets": restored,
        "restored_asset_ids": restored,
        "recovered_asset_ids": recovered,
        "recovered_codes": [code_of.get(i, str(i)) for i in recovered],
        "failed_before": len(base_failed),
        "failed_after": len(after_failed),
        "recovered_assets": recovered,
        "recovered_count": len(recovered),
        "population_relieved": sum(
            CATEGORY_POPULATION_WEIGHT.get(_category_of(assets, i), 400) for i in recovered
        ),
        "explanation": (
            f"Repairing {len(restored)} asset(s) restores {len(recovered)} asset(s) and "
            f"relieves {sum(CATEGORY_POPULATION_WEIGHT.get(_category_of(assets, i), 400) for i in recovered)} "
            f"simulated residents. {len(after_failed)} asset(s) remain without service."
        ),
    }


def _category_of(assets: list[AssetNode], asset_id: int) -> str:
    for a in assets:
        if a.id == asset_id:
            return a.category
    return AssetCategory.COMMERCIAL


def apply_load_sensitivity(
    assets: list[AssetNode], noise: float, seed: int
) -> list[AssetNode]:
    """Optional Monte-Carlo style jitter for what-if exploration.

    Kept out of the default path so the core engine stays deterministic; the
    API exposes it behind an explicit flag and records the seed.
    """
    if noise <= 0:
        return assets
    import random

    rng = random.Random(seed)
    out: list[AssetNode] = []
    for asset in assets:
        factor = 1.0 + rng.uniform(-noise, noise)
        clone = AssetNode(
            id=asset.id,
            code=asset.code,
            name=asset.name,
            category=asset.category,
            criticality=asset.criticality,
            status=asset.status,
            capacity=asset.capacity,
            load_percent=asset.load_percent,
            map_x=asset.map_x,
            map_y=asset.map_y,
        )
        clone.load_percent = max(0.0, min(100.0, asset.load_percent * factor))
        out.append(clone)
    return out


def severity_label(score: float) -> str:
    if score >= 75:
        return "critical"
    if score >= 50:
        return "high"
    if score >= 25:
        return "medium"
    return "low"


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance, used for crew mobilisation estimates."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return round(2 * r * math.asin(math.sqrt(a)), 2)
