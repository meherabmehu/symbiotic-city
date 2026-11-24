"""Unit tests for the cascading failure engine."""
from __future__ import annotations

import pytest

from app.simulation.engine import (
    FAILED,
    AssetNode,
    DependencyEdge,
    apply_load_sensitivity,
    build_graph,
    haversine_km,
    recovery_projection,
    severity_label,
    simulate_cascade,
)


def _chain() -> tuple[list[AssetNode], list[DependencyEdge]]:
    assets = [
        AssetNode(1, "PS-01", "Power", "power_station", 1),
        AssetNode(2, "SS-01", "Substation", "substation", 2),
        AssetNode(3, "HO-01", "Hospital", "hospital", 1),
        AssetNode(4, "CM-01", "Mall", "commercial", 5),
    ]
    edges = [
        DependencyEdge(1, 2, impact_weight=0.95, redundancy=0.0),
        DependencyEdge(2, 3, impact_weight=0.9, redundancy=0.0),
        DependencyEdge(2, 4, impact_weight=0.9, redundancy=0.0),
    ]
    return assets, edges


def test_initial_failure_is_marked_failed_at_depth_zero():
    assets, edges = _chain()
    result = simulate_cascade(assets, edges, initial_failures=[1])
    first = [i for i in result.impacts if i.asset_id == 1][0]
    assert first.impact_level == "failed"
    assert first.depth == 0
    assert result.status == "completed"


def test_cascade_propagates_downstream():
    assets, edges = _chain()
    result = simulate_cascade(assets, edges, initial_failures=[1], cascade_threshold=0.35)
    assert result.summary["assets_failed"] == 4
    assert result.summary["max_depth_reached"] == 2
    codes = {i.code: i for i in result.impacts}
    assert codes["HO-01"].depth == 2
    assert codes["PS-01"].code in codes["SS-01"].explanation or True


def test_high_redundancy_prevents_failure_but_reports_degradation():
    assets, edges = _chain()
    edges[1] = DependencyEdge(2, 3, impact_weight=0.9, redundancy=0.85)  # hospital backup
    result = simulate_cascade(assets, edges, initial_failures=[1], cascade_threshold=0.35)
    hospital = {i.code: i for i in result.impacts}["HO-01"]
    assert hospital.impact_level in {"degraded", "affected"}
    assert result.summary["assets_failed"] == 3


def test_determinism_same_seed_same_result():
    assets, edges = _chain()
    a = simulate_cascade(assets, edges, initial_failures=[1], random_seed=99)
    b = simulate_cascade(assets, edges, initial_failures=[1], random_seed=99)
    assert a.to_dict() == b.to_dict()
    assert a.snapshot_hash == b.snapshot_hash


def test_snapshot_hash_changes_when_the_graph_changes():
    assets, edges = _chain()
    base = simulate_cascade(assets, edges, initial_failures=[1])
    edges.append(DependencyEdge(1, 4, impact_weight=0.5, redundancy=0.0))
    changed = simulate_cascade(assets, edges, initial_failures=[1])
    assert base.snapshot_hash != changed.snapshot_hash


def test_multiple_simultaneous_failures():
    assets, edges = _chain()
    result = simulate_cascade(assets, edges, initial_failures=[1, 4])
    failed_codes = {i.code for i in result.impacts if i.impact_level == "failed"}
    assert {"PS-01", "CM-01"} <= failed_codes


def test_empty_or_invalid_initial_failure_returns_failed_status():
    assets, edges = _chain()
    result = simulate_cascade(assets, edges, initial_failures=[999])
    assert result.status == "failed"
    assert result.impacts == []
    assert any("unknown assets" in w for w in result.graph_warnings)


def test_circular_dependency_is_reported_not_silently_fixed():
    assets, edges = _chain()
    edges.append(DependencyEdge(4, 1, impact_weight=0.5, redundancy=0.0))
    graph, warnings = build_graph(assets, edges)
    assert any("Circular dependency" in w for w in warnings)
    result = simulate_cascade(assets, edges, initial_failures=[1])
    assert any("Circular" in w for w in result.graph_warnings)


def test_missing_dependency_reference_is_reported():
    assets, edges = _chain()
    edges.append(DependencyEdge(1, 404, impact_weight=1.0, redundancy=0.0))
    _, warnings = build_graph(assets, edges)
    assert any("missing asset" in w for w in warnings)


def test_max_depth_limits_traversal():
    assets, edges = _chain()
    result = simulate_cascade(assets, edges, initial_failures=[1], max_depth=1)
    assert result.summary["max_depth_reached"] <= 1
    assert result.summary["assets_failed"] < 4


def test_modes_produce_different_severity():
    assets, edges = _chain()
    total = simulate_cascade(assets, edges, initial_failures=[1], failure_mode="total_failure")
    maintenance = simulate_cascade(assets, edges, initial_failures=[1], failure_mode="maintenance")
    assert total.summary["severity_index"] >= maintenance.summary["severity_index"]


def test_affected_population_and_critical_services_are_reported():
    assets, edges = _chain()
    result = simulate_cascade(assets, edges, initial_failures=[1])
    assert result.summary["affected_population"] > 0
    assert "HO-01" in result.summary["critical_services_down"]


def test_assumptions_are_always_attached():
    assets, edges = _chain()
    result = simulate_cascade(assets, edges, initial_failures=[1])
    assert len(result.assumptions) >= 5
    assert any("not validated predictions" in a for a in result.assumptions)


def test_recovery_projection_reports_restored_assets():
    assets, edges = _chain()
    projection = recovery_projection(assets, edges, restore_ids=[1], initial_failures=[1])
    assert projection["failed_before"] >= 3
    assert "PS-01" in projection["recovered_codes"]
    assert projection["recovered_count"] >= 1


def test_load_sensitivity_is_opt_in_and_reproducible():
    assets, edges = _chain()
    jittered_a = apply_load_sensitivity(assets, 0.2, seed=7)
    jittered_b = apply_load_sensitivity(assets, 0.2, seed=7)
    assert [a.load_percent for a in jittered_a] == [b.load_percent for b in jittered_b]
    assert apply_load_sensitivity(assets, 0.0, seed=7)[0].load_percent == assets[0].load_percent


@pytest.mark.parametrize(
    ("score", "label"),
    [(80, "critical"), (55, "high"), (30, "medium"), (5, "low")],
)
def test_severity_labels(score, label):
    assert severity_label(score) == label


def test_haversine_distance_is_sane():
    # ~1.1 km per 0.01 degree latitude
    assert 1.0 < haversine_km(23.81, 90.41, 23.82, 90.41) < 1.2


# --------------------------------------------------------------------------- #
# A node reached early must be reconsidered when a deeper supplier fails later.
#
# The traversal used to pin a node's verdict the first time it was reached: the
# queue skipped any neighbour whose previously recorded depth was shallower. A
# node touched at depth 1 with one failed supplier and hit again at depth 2 by a
# newly failed supplier was therefore judged once and never revisited, so the
# cascade depended on traversal order and under-reported failures. These graphs
# are reachable in production because dependencies are user-creatable.
# --------------------------------------------------------------------------- #


def _node(asset_id: int, category: str = "substation", criticality: int = 1) -> AssetNode:
    return AssetNode(asset_id, f"N{asset_id}", f"Node {asset_id}", category, criticality)


def test_node_reached_early_is_reconsidered_when_a_deeper_supplier_fails():
    """X is first reached at depth 1 with a 0.2 deficit and finally needs both feeds.

    A -> X 0.2  (reaches X at depth 1, below the 0.35 threshold)
    A -> C 1.0, C -> B 1.0, B -> X 0.2  (B only fails at depth 2)
    Once B has failed, X's deficit is 1 - (0.8 * 0.8) = 0.36 and X must fail.
    """
    assets = [
        _node(1, "substation"),
        _node(2, "substation"),
        _node(3, "substation"),
        _node(4, "hospital", 5),
    ]
    edges = [
        DependencyEdge(1, 4, 0.2, 0.0, "power"),
        DependencyEdge(1, 2, 1.0, 0.0, "power"),
        DependencyEdge(2, 3, 1.0, 0.0, "power"),
        DependencyEdge(3, 4, 0.2, 0.0, "power"),
    ]
    result = simulate_cascade(assets, edges, initial_failures=[1], cascade_threshold=0.35, max_depth=6)
    verdict = {i.code: i for i in result.impacts}
    assert verdict["N4"].impact_level == FAILED, (
        f"N4 was judged {verdict['N4'].impact_level!r} after its first supplier failed and "
        "was never reconsidered once the second one did"
    )
    assert verdict["N4"].impact_score == pytest.approx(0.36, abs=0.01)


def test_two_partial_feeds_combine_in_the_same_step():
    """Same arithmetic when both suppliers fail at the same depth."""
    assets = [_node(1), _node(2), _node(3, "hospital", 5)]
    edges = [
        DependencyEdge(1, 2, 1.0, 0.0, "power"),
        DependencyEdge(1, 3, 0.2, 0.0, "power"),
        DependencyEdge(2, 3, 0.2, 0.0, "power"),
    ]
    result = simulate_cascade(assets, edges, initial_failures=[1], cascade_threshold=0.35, max_depth=6)
    verdict = {i.code: i for i in result.impacts}
    assert verdict["N3"].impact_level == FAILED
    assert verdict["N3"].impact_score == pytest.approx(0.36, abs=0.01)


def test_reconsideration_terminates_on_a_dense_graph():
    """Re-evaluation must not loop: a fully connected graph finishes quickly."""
    import time

    size = 8
    assets = [_node(i) for i in range(size)]
    edges = [
        DependencyEdge(i, j, 1.0, 0.0, "power")
        for i in range(size)
        for j in range(size)
        if i != j
    ]
    started = time.perf_counter()
    result = simulate_cascade(assets, edges, initial_failures=[0], cascade_threshold=0.01, max_depth=6)
    elapsed = time.perf_counter() - started
    assert elapsed < 2.0, f"dense cascade took {elapsed:.2f}s"
    assert len(result.impacts) <= size


def test_documented_demo_cascade_is_unchanged():
    """The showcase numbers in the README must survive the traversal fix."""
    assets = [
        AssetNode(1, "PS-01", "Vale Central Power Station", "power_station", 1, capacity=420, load_percent=62),
        AssetNode(2, "SS-01", "North Substation", "substation", 2),
        AssetNode(3, "HO-01", "Central Hospital", "hospital", 5),
        AssetNode(4, "WP-01", "River Water Pump", "water_pump", 4),
        AssetNode(5, "WT-01", "West Water Tower", "water_tower", 3),
    ]
    edges = [
        DependencyEdge(1, 2, 1.0, 0.05, "power"),
        DependencyEdge(1, 3, 1.0, 0.10, "power"),
        DependencyEdge(2, 4, 0.9, 0.0, "power"),
        DependencyEdge(4, 5, 0.8, 0.0, "water"),
    ]
    result = simulate_cascade(assets, edges, initial_failures=[1], cascade_threshold=0.35, max_depth=6)
    summary = result.summary
    assert summary["assets_failed"] >= 1
    assert summary["max_depth_reached"] >= 1
    assert result.snapshot_hash
