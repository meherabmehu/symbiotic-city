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


# --------------------------------------------------------------------------- #
# The unserved report must name the constraint that actually bound the demand.
#
# It used to name capacity every time, producing sentences that contradicted
# themselves ("insufficient eligible capacity: 30 available against a requirement
# of 1") when the real limit was the mobilisation horizon. A plan explanation is
# part of the product: an operator decides what to escalate from it.
# --------------------------------------------------------------------------- #


def _single_demand(asset_id: int, need: float, eligible=("generator",)) -> Demand:
    return Demand(
        asset_id,
        f"AS-{asset_id:02d}",
        f"Asset {asset_id}",
        "hospital",
        need,
        2,
        500,
        list(eligible),
        600,
        2.0,
    )


def test_unserved_reason_names_the_horizon_when_the_clock_is_the_limit():
    """Plenty of capacity, but only enough mobilisation budget for one dispatch."""
    many = [_single_demand(i, 1.0) for i in range(1, 6)]
    # GEN-03 mobilises in 45 min, so a 60-minute horizon funds exactly one dispatch.
    resources = [ResourceOption(3, "GEN-03", "Ampere 45", "generator", 30, 85, 45, ["hospital"])]
    result = optimize(
        OptimizationInput(demands=many, resources=resources, horizon_hours=1.0)
    )
    assert result.status == OPTIMAL
    assert result.covered_demand == 1

    reason = result.unserved[0]["reason"].lower()
    assert "mobilisation budget" in reason or "horizon" in reason, (
        f"expected a horizon explanation, got: {result.unserved[0]['reason']}"
    )
    assert "insufficient eligible capacity" not in reason, (
        "capacity was 30 against a requirement of 1; blaming capacity is false"
    )


def test_unserved_reason_names_capacity_when_the_requirement_cannot_fit():
    """No horizon can help: the requirement exceeds every eligible resource."""
    huge = [_single_demand(i, 500.0) for i in range(1, 4)]
    resources = [ResourceOption(3, "GEN-03", "Ampere 45", "generator", 30, 85, 45, ["hospital"])]
    result = optimize(
        OptimizationInput(demands=huge, resources=resources, horizon_hours=72.0)
    )
    assert result.covered_demand == 0
    reason = result.unserved[0]["reason"]
    assert "exceeds total eligible capacity" in reason, f"got: {reason}"
    assert "500" in reason and "30" in reason, "the numbers that bound it must appear"


def test_unserved_reason_names_commitment_when_other_demands_hold_the_capacity():
    """One generator, two demands: the second loses the capacity to the first."""
    demands = [_single_demand(i, 90.0) for i in range(1, 3)]
    resources = [ResourceOption(1, "GEN-01", "Atlas 250", "generator", 100, 180, 25, ["hospital"])]
    result = optimize(
        OptimizationInput(demands=demands, resources=resources, horizon_hours=72.0)
    )
    assert result.covered_demand == 1
    reason = result.unserved[0]["reason"]
    assert "exhausted for this plan" in reason, f"got: {reason}"
