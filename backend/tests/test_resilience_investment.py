"""Investment ranking must be measured, and must not overstate the portfolio.

Three claims are tested, because each is a way this feature could mislead a budget
holder:

1. A benefit is real. Every option on the list is scored by re-running the cascade
   with that intervention applied, so an option claiming to protect people must
   actually reduce the population at risk in a second run.
2. A no-op is admitted. Interventions that change nothing are listed as changing
   nothing, not ranked as quiet wins.
3. A portfolio is measured as a package. Adding individual benefits on overlapping
   paths claims more people than were ever at risk; the reported figure is the
   result of applying them together.

The cost figures are planning constants, and the tests assert they are published
rather than that they are correct -- correctness of a capital cost is not something
this repository can know.
"""

from __future__ import annotations

import pytest

from app.core.types import utcnow
from app.services import investment


@pytest.fixture()
def plan_for_city(client, as_role):
    """One planning run, reused: each run simulates a cascade per candidate."""
    cache: dict[str, dict] = {}

    def _factory(**kwargs) -> dict:
        key = repr(sorted(kwargs.items()))
        if key not in cache:
            operator = as_role("city_operator")
            response = operator.get("/api/resilience/investment", params=kwargs)
            assert response.status_code == 200, response.text
            cache[key] = response.json()["data"]
        return cache[key]

    return _factory


def test_plan_reports_a_baseline_it_actually_simulated(client, as_role):
    operator = as_role("city_operator")
    data = operator.get("/api/resilience/investment").json()["data"]
    baseline = data["baseline"]
    assert baseline["trigger_codes"], "a plan must name the failure it is planning against"
    assert baseline["assets_failed"] >= 1
    assert baseline["population_at_risk"] > 0
    assert data["notes"]


def test_published_cost_constants_and_method(client, as_role):
    data = as_role("city_operator").get("/api/resilience/investment").json()["data"]
    method = data["method"]
    assert method["costs_are"] == "annualised planning constants, not quotes"
    assert set(method["cost_basis"]) == set(investment.INTERVENTION_TYPES)
    assert "measured difference" in method["approach"]


def test_every_benefit_is_a_measured_difference(plan_for_city):
    """Re-derive one option by hand and check the reported numbers match."""
    from app.services import investment as svc
    from app.services import infrastructure as infra_service
    from app.core.database import SessionLocal

    data = plan_for_city()
    option = next(o for o in data["options"] if o["changes_anything"])

    db = SessionLocal()
    try:
        nodes, edges = infra_service.simulation_inputs(db)
        initial = data["baseline"]["trigger_asset_ids"]
        base = svc._run(nodes, edges, initial)
        applied_nodes, applied_edges, _ = svc._apply(
            nodes, edges, option["asset_id"], option["intervention"]
        )
        improved = svc._run(applied_nodes, applied_edges, initial)
    finally:
        db.close()

    assert option["benefit"]["population_protected"] == (
        base.population_at_risk - improved.population_at_risk
    )
    assert option["benefit"]["assets_saved"] == len(base.failed_ids) - len(improved.failed_ids)


def test_options_that_change_nothing_are_admitted(plan_for_city):
    data = plan_for_city()
    no_ops = [o for o in data["options"] if not o["changes_anything"]]
    assert no_ops, "some interventions on some assets must be measured as doing nothing"
    for option in no_ops:
        assert option["benefit"]["resilience_score"] == 0
        assert option["benefit"]["population_protected"] == 0
    # And they must be ranked below every option that does something.
    effective = [o for o in data["options"] if o["changes_anything"]]
    if effective:
        last_effective = max(data["options"].index(o) for o in effective)
        first_noop = min(data["options"].index(o) for o in no_ops)
        assert first_noop > last_effective, (
            "a measured no-op must never be offered ahead of a measured benefit"
        )
    assert any("change nothing" in note for note in data["notes"])


def test_portfolio_is_measured_together_not_summed(plan_for_city):
    data = plan_for_city(budget=100000)
    portfolio = data["portfolio"]
    assert portfolio["selected"], data["notes"]

    together = portfolio["measured_together"]["population_protected"]
    individual = portfolio["individual_benefits_sum"]

    assert together <= data["baseline"]["population_at_risk"], (
        "a package cannot protect more people than were at risk"
    )
    if len(portfolio["selected"]) > 1:
        assert individual >= together, "overlapping interventions cannot protect more together"
        assert portfolio["overlap_clawback"] == individual - together
    assert any("counted twice" in note or "Measured together" in note for note in data["notes"])


def test_budget_is_respected(plan_for_city):
    data = plan_for_city(budget=60000)
    portfolio = data["portfolio"]
    assert portfolio["spent"] <= 60000
    assert portfolio["unspent"] >= 0
    assert portfolio["spent"] + portfolio["unspent"] == pytest.approx(60000)


def test_a_budget_below_any_option_is_reported_not_ignored(plan_for_city):
    data = plan_for_city(budget=1000)
    portfolio = data["portfolio"]
    assert portfolio["spent"] == 0
    assert portfolio["selected"] == []
    assert any("Nothing fits" in note for note in data["notes"])


def test_objectives_change_the_order(plan_for_city):
    balanced = plan_for_city()
    critical = plan_for_city(objective="critical")
    assert balanced["objective"] == "balanced"
    assert critical["objective"] == "critical"

    def first_key(data):
        option = data["options"][0]
        return (
            option["asset_code"],
            option["intervention"],
            tuple(option["benefit"]["critical_services_protected"]),
        )

    # The critical-first ordering must put an option that protects critical
    # services at the top whenever one exists.
    if any(o["benefit"]["critical_services_protected"] for o in critical["options"]):
        assert critical["options"][0]["benefit"]["critical_services_protected"], first_key(critical)


def test_at_most_one_intervention_per_asset(plan_for_city):
    data = plan_for_city(budget=1_000_000)
    assets = [c["asset_id"] for c in data["portfolio"]["selected"]]
    assert len(assets) == len(set(assets))


def test_unknown_objective_and_type_are_rejected(client, as_role):
    operator = as_role("city_operator")
    bad_objective = operator.get(
        "/api/resilience/investment", params={"objective": "cheapest"}
    )
    assert bad_objective.status_code == 422
    bad_type = operator.get("/api/resilience/investment", params={"types": ["teleport"]})
    assert bad_type.status_code == 422
    assert bad_type.json()["error"]["code"] == "invalid_intervention"


def test_restricting_types_changes_the_candidate_set(plan_for_city):
    only_harden = plan_for_city(types=["harden"])
    assert {o["intervention"] for o in only_harden["options"]} == {"harden"}


def test_investment_requires_planning_permission(client, as_role):
    engineer = as_role("field_engineer")
    assert engineer.get("/api/resilience/investment").status_code == 403
    analyst = as_role("city_analyst")
    assert analyst.get("/api/resilience/investment").status_code == 200


def test_anonymous_cannot_plan_investment(anonymous):
    assert anonymous.get("/api/resilience/investment").status_code == 401


def test_trigger_can_be_forced(client, as_role):
    """A planner must be able to ask about a specific failure, not only the worst."""
    operator = as_role("city_operator")
    assets = {a["code"]: a["id"] for a in operator.get("/api/infrastructure?page_size=100").json()["data"]}
    data = operator.get(
        "/api/resilience/investment",
        params={"trigger_asset_ids": [assets["SS-01"]]},
    ).json()["data"]
    assert data["baseline"]["trigger_codes"] == ["SS-01"]
