"""Unit tests for the OR-Tools constrained recovery optimiser."""
from __future__ import annotations

from app.optimization.engine import (
    INFEASIBLE,
    MODEL_INVALID,
    OPTIMAL,
    Demand,
    OptimizationInput,
    ResourceOption,
    optimize,
)


def _resources() -> list[ResourceOption]:
    return [
        ResourceOption(1, "GEN-01", "Atlas 250", "generator", 100, 180, 25, ["hospital", "water_pump", "commercial"]),
        ResourceOption(2, "GEN-02", "Volt 120", "generator", 60, 120, 35, ["hospital", "water_pump"]),
        ResourceOption(3, "GEN-03", "Ampere 45", "generator", 30, 85, 45, ["commercial", "school"]),
    ]


def _demands() -> list[Demand]:
    return [
        Demand(1, "HO-01", "Central Hospital", "hospital", 60, 1, 900, ["generator"], 240, 3.0),
        Demand(2, "WP-01", "River Pump", "water_pump", 80, 2, 1500, ["generator"], 240, 2.5),
        Demand(3, "CM-01", "Galleria Mall", "commercial", 40, 5, 300, ["generator"], 480, 1.5),
    ]


def test_feasible_case_serves_everything_and_is_optimal():
    result = optimize(OptimizationInput(_demands(), _resources()))
    assert result.status == OPTIMAL
    assert result.coverage_percent == 100.0
    assert len({a.asset_id for a in result.assignments}) == 3


def test_scarce_capacity_prioritises_the_hospital_over_commercial():
    resources = [
        ResourceOption(1, "GEN-01", "Atlas", "generator", 70, 180, 25, ["hospital", "water_pump", "commercial"]),
        ResourceOption(3, "GEN-03", "Ampere", "generator", 30, 85, 45, ["commercial", "school"]),
    ]
    result = optimize(OptimizationInput(_demands(), resources, must_serve_priority=None))
    served = {a.asset_code for a in result.assignments}
    assert "HO-01" in served
    assert "CM-01" in served
    assert "WP-01" not in served
    assert result.coverage_percent < 100


def test_coverage_is_all_or_nothing():
    resources = [ResourceOption(1, "GEN-01", "Atlas", "generator", 50, 180, 25, ["hospital"])]
    demands = [Demand(1, "HO-01", "Hospital", "hospital", 60, 1, 900, ["generator"], 240, 2.0)]
    result = optimize(OptimizationInput(demands, resources, must_serve_priority=None))
    assert result.assignments == []
    assert result.covered_demand == 0
    assert result.unserved[0]["reason"]


def test_no_resources_is_infeasible():
    result = optimize(OptimizationInput(_demands(), []))
    assert result.status == INFEASIBLE
    assert result.infeasibility_reason == "no_resources"


def test_empty_demands_is_a_model_error():
    result = optimize(OptimizationInput([], _resources()))
    assert result.status == MODEL_INVALID
    assert "nothing to optimise" in result.explanation[0]


def test_must_serve_priority_makes_small_models_infeasible():
    resources = [ResourceOption(1, "GEN-01", "Atlas", "generator", 40, 180, 25, ["hospital", "water_pump"])]
    demands = [
        Demand(1, "HO-01", "Hospital", "hospital", 60, 1, 900, ["generator"], 240, 2.0),
        Demand(2, "WP-01", "Pump", "water_pump", 80, 2, 1500, ["generator"], 240, 2.0),
    ]
    strict = optimize(OptimizationInput(demands, resources, must_serve_priority=1))
    relaxed = optimize(OptimizationInput(demands, resources, must_serve_priority=None))
    assert strict.status == INFEASIBLE
    assert "HO-01" in (strict.infeasibility_reason or "")
    assert relaxed.status == OPTIMAL


def test_infeasible_result_never_contains_assignments():
    resources = [ResourceOption(1, "GEN-01", "Atlas", "generator", 10, 180, 25, ["hospital"])]
    demands = [Demand(1, "HO-01", "Hospital", "hospital", 90, 1, 900, ["generator"], 240, 2.0)]
    result = optimize(OptimizationInput(demands, resources, must_serve_priority=1))
    assert result.status == INFEASIBLE
    assert result.assignments == []
    assert result.explanation[-1]


def test_mobilisation_horizon_constrains_dispatch():
    resources = [ResourceOption(1, "GEN-01", "Atlas", "generator", 100, 180, 240, ["hospital"])]
    demands = [Demand(1, "HO-01", "Hospital", "hospital", 50, 1, 900, ["generator"], 600, 2.0)]
    impossible = optimize(OptimizationInput(demands, resources, horizon_hours=1.0, must_serve_priority=None))
    assert impossible.assignments == []


def test_ineligible_resource_is_not_used():
    resources = [ResourceOption(9, "TK-01", "Tanker", "water_tanker", 50, 90, 20, ["residential"])]
    result = optimize(OptimizationInput(_demands(), resources, must_serve_priority=None))
    assert result.assignments == []
    assert "No eligible resource" in result.unserved[0]["reason"]


def test_resource_capacity_is_never_oversubscribed():
    result = optimize(OptimizationInput(_demands(), _resources()))
    for resource in _resources():
        allocated = sum(
            a.quantity for a in result.assignments if a.resource_id == resource.resource_id
        )
        assert allocated <= resource.available + 1e-6


def test_objective_prefers_one_hospital_over_many_commercial_sites():
    resources = [ResourceOption(1, "GEN-01", "Atlas", "generator", 60, 500, 20, ["hospital", "commercial"])]
    demands = [
        Demand(1, "HO-01", "Hospital", "hospital", 60, 1, 900, ["generator"], 240, 2.0),
        *[
            Demand(10 + i, f"CM-0{i}", f"Mall {i}", "commercial", 60, 5, 100, ["generator"], 240, 0.5)
            for i in range(4)
        ],
    ]
    result = optimize(OptimizationInput(demands, resources, must_serve_priority=None))
    assert {a.asset_code for a in result.assignments} == {"HO-01"}


def test_explanation_is_human_readable_and_explainable():
    result = optimize(OptimizationInput(_demands(), _resources()))
    joined = " ".join(result.explanation)
    assert "Served" in joined
    assert "all-or-nothing" in joined
    for assignment in result.assignments:
        assert "priority P" in assignment.rationale
