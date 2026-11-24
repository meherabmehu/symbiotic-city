"""The frontier must show real trade-offs, and never invent one.

Three claims are tested. A plan on the frontier is a genuine decision: it serves
the sites it claims. A plan that is worse everywhere is not offered as a choice.
And when there is only one sensible plan, the result says so instead of
manufacturing a second option so the chart looks balanced.

The engine-level tests pin the two properties the search depends on: the default
objective is unchanged by the weights machinery (or every existing plan silently
changes), and a coverage floor is a requirement rather than a preference.
"""

from __future__ import annotations

import pytest

from app.optimization.engine import (
    OPTIMAL,
    Demand,
    OptimizationInput,
    ResourceOption,
    _weights,
    optimize,
)
from app.services import multiobjective


def _demand(asset_id, code, priority, population, need=100.0, category="clinic"):
    return Demand(
        asset_id=asset_id,
        asset_code=code,
        asset_name=code,
        category=category,
        need=need,
        priority=priority,
        population=population,
        eligible_categories=[],
        service_window_minutes=600,
        estimated_hours=1.0,
    )


def _crew_resource():
    # One crew that can only be in one place, sized to serve one clinic's need.
    return [
        ResourceOption(
            resource_id=1,
            code="CRW-1",
            name="Crew 1",
            category="crew",
            available=500.0,
            hourly_cost=100,
            mobilisation_minutes=15,
            serves_categories=["hospital", "clinic"],
        )
    ]


@pytest.fixture()
def tradeoff_input():
    """One crew, five clinics and one hospital: a real width-versus-priority choice."""
    return OptimizationInput(
        demands=[
            _demand(1, "HO-01", priority=1, population=30000, need=500.0, category="hospital"),
            _demand(2, "CL-01", priority=3, population=3000),
            _demand(3, "CL-02", priority=3, population=3000),
            _demand(4, "CL-03", priority=3, population=3000),
            _demand(5, "CL-04", priority=3, population=3000),
            _demand(6, "CL-05", priority=3, population=3000),
        ],
        resources=_crew_resource(),
        horizon_hours=20,
        must_serve_priority=None,
        time_limit_seconds=1.0,
    )


# --------------------------------------------------------------------------- #
# engine properties the search relies on
# --------------------------------------------------------------------------- #


def test_default_weights_leave_the_documented_objective_unchanged():
    weights, scale = _weights(None)
    assert weights == {"criticality": 1.0, "cost": 1.0, "population": 0.0, "coverage": 0.0}
    assert scale == 1


def test_unknown_objective_weight_is_rejected():
    with pytest.raises(ValueError, match="unknown objective weight"):
        _weights({"profit": 1.0})


def test_weights_are_normalised_so_only_ratios_matter():
    a, scale_a = _weights({"criticality": 2.0, "cost": 1.0})
    b, scale_b = _weights({"criticality": 200.0, "cost": 100.0})
    assert a == b and scale_a == scale_b


def test_a_coverage_floor_is_a_requirement_not_a_preference(tradeoff_input):
    """Asking for four sites must never be answered with two cleverer ones."""
    for floor in (1, 3, 5):
        attempt = OptimizationInput(
            demands=tradeoff_input.demands,
            resources=tradeoff_input.resources,
            horizon_hours=tradeoff_input.horizon_hours,
            must_serve_priority=None,
            time_limit_seconds=1.0,
            min_coverage=floor,
        )
        result = optimize(attempt)
        assert result.status in (OPTIMAL, "feasible")
        assert result.covered_demand >= floor, (
            f"a solution serving {result.covered_demand} sites does not meet a floor of {floor}"
        )


# --------------------------------------------------------------------------- #
# the frontier itself
# --------------------------------------------------------------------------- #


def test_frontier_finds_the_width_versus_criticality_tradeoff(tradeoff_input):
    search = multiobjective.search(tradeoff_input)
    frontier = search["frontier"]
    assert len(frontier) >= 2, [
        (p.direction, p.coverage, p.criticality) for p in frontier
    ]

    # The two ends of the trade-off must actually be different decisions: more
    # sites restored, or more criticality protected.
    widest = max(frontier, key=lambda p: p.coverage)
    sharpest = max(frontier, key=lambda p: p.criticality)
    assert widest.coverage > sharpest.coverage
    assert sharpest.served_population > widest.served_population, (
        "the narrow plan should protect the hospital's larger catchment"
    )
    assert "HO-01" in sharpest.served_codes
    assert "HO-01" not in widest.served_codes


def test_no_plan_on_the_frontier_is_dominated(tradeoff_input):
    search = multiobjective.search(tradeoff_input)
    for plan in search["frontier"]:
        for other in search["frontier"]:
            if other is plan:
                continue
            assert not multiobjective._dominates(other, plan), (
                f"{other.direction} dominates {plan.direction}, so the latter is not an option"
            )


def test_a_plan_that_serves_nothing_is_never_offered(tradeoff_input):
    """Saving money by restoring nothing is optimal and useless."""
    search = multiobjective.search(tradeoff_input)
    for plan in search["frontier"]:
        assert plan.coverage > 0, plan.direction
        assert plan.served_codes


def test_served_sites_are_actually_supplied(tradeoff_input):
    """A plan must not claim a site it cannot feed; the count is checked against
    the model's own unserved list."""
    search = multiobjective.search(tradeoff_input)
    for plan in search["frontier"]:
        unserved_ids = {u["asset_id"] for u in plan.result.unserved}
        served_ids = {
            d.asset_id for d in tradeoff_input.demands if d.asset_id not in unserved_ids
        }
        assert int(plan.coverage) == len(served_ids), plan.direction
        assert plan.result.covered_demand == len(served_ids)


def test_unreachable_coverage_is_reported_not_approximated(tradeoff_input):
    search = multiobjective.search(tradeoff_input)
    infeasible = [s for s in search["skipped"] if s["status"] == "infeasible"]
    assert infeasible, "one crew cannot serve six sites, and that must be reported"
    assert all(s.get("requested_coverage") for s in infeasible)
    assert any("could not be met" in n for n in search["notes"])


def test_single_plan_is_explained_rather_than_padded():
    """When one plan wins everywhere, say so -- do not invent a rival."""
    demands = [_demand(1, "CL-01", 2, 1000), _demand(2, "CL-02", 2, 900)]
    resources = [
        ResourceOption(1, "GEN-1", "Generator", "generator", 500, 50, 10, ["clinic"]),
        ResourceOption(2, "GEN-2", "Generator 2", "generator", 500, 60, 10, ["clinic"]),
    ]
    search = multiobjective.search(
        OptimizationInput(demands=demands, resources=resources, horizon_hours=12, must_serve_priority=None)
    )
    assert len(search["frontier"]) == 1
    assert any("One plan" in note for note in search["notes"])


def test_empty_demand_does_not_crash():
    search = multiobjective.search(OptimizationInput(demands=[], resources=_crew_resource()))
    assert search["frontier"] == []
    assert search["notes"]


def test_duplicates_are_collapsed(tradeoff_input):
    """Different coverage requirements that reach the same decision are not choices."""
    search = multiobjective.search(tradeoff_input)
    signatures = [p.signature() for p in search["frontier"]]
    assert len(signatures) == len(set(signatures))
    widths = [int(p.coverage) for p in search["frontier"]]
    assert len(widths) == len(set(widths)), "two plans for one width is a false choice"


# --------------------------------------------------------------------------- #
# API surface
# --------------------------------------------------------------------------- #


_RUN_CACHE: dict[str, int] = {}


@pytest.fixture()
def seeded_run(client, as_role) -> int:
    """One real cascade run, so the endpoint is tested against real demands.

    Cached across tests: each solve takes seconds, and re-running the cascade for
    every test would only prove the same thing more slowly.
    """
    if "run" in _RUN_CACHE:
        return _RUN_CACHE["run"]
    api = as_role("city_operator")
    assets = {
        a["code"]: a["id"] for a in api.get("/api/infrastructure?page_size=100").json()["data"]
    }
    response = api.post(
        "/api/simulations/run",
        json={
            "name": "frontier fixture run",
            "initial_failure_ids": [assets["PS-02"]],
            "cascade_threshold": 0.35,
        },
    )
    assert response.status_code in (200, 201), response.text
    _RUN_CACHE["run"] = response.json()["data"]["id"]
    return _RUN_CACHE["run"]


def _frontier_body(api, run_id: int) -> dict:
    demands = api.get(f"/api/simulations/{run_id}/demands").json()["data"]
    resources = [r["id"] for r in api.get("/api/resources?page_size=50").json()["data"]]
    return {
        "title": "Frontier probe",
        "simulation_run_id": run_id,
        "demands": [
            {
                key: d[key]
                for key in (
                    "asset_id",
                    "category",
                    "need",
                    "priority",
                    "eligible_categories",
                    "service_window_minutes",
                    "estimated_hours",
                )
            }
            for d in demands
        ],
        "resource_ids": resources,
        "horizon_hours": 12,
        "must_serve_priority": None,
    }


def test_frontier_endpoint_returns_explained_plans(client, as_role, seeded_run):
    api = as_role("city_operator")
    response = api.post("/api/resilience/frontier", json=_frontier_body(api, seeded_run))
    assert response.status_code == 200, response.text
    data = response.json()["data"]

    assert data["plans"], data["notes"]
    assert data["frontier_size"] == len(data["plans"])
    first = data["plans"][0]
    for key in ("criticality", "coverage", "cost"):
        assert key in first["objectives"]
    assert first["served_assets"], "the first plan is returned in full"
    assert "assignments" in first, "the leading plan must be inspectable without a second call"
    assert data["notes"]
    assert data["objectives"]["cost"].startswith("mobilisation cost")


def test_frontier_requires_planning_permission(client, as_role, seeded_run):
    # Build the payload with a role that can read the resource inventory; the
    # question under test is who may *run* the comparison, not who can list kit.
    operator = as_role("city_operator")
    body = _frontier_body(operator, seeded_run)

    engineer = as_role("field_engineer")
    response = engineer.post("/api/resilience/frontier", json=body)
    assert response.status_code == 403, (
        "running a multi-solve comparison is a planning action, not a read"
    )
    # An analyst holds resilience:plan, so the same payload must be accepted.
    analyst = as_role("city_analyst")
    allowed = analyst.post("/api/resilience/frontier", json=body)
    assert allowed.status_code == 200, allowed.text
