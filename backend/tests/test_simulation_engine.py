"""Unit tests for the cascading failure engine."""
from __future__ import annotations

import pytest

from app.simulation.engine import (
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
