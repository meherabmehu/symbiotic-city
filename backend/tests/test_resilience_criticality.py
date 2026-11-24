"""Dependency-aware criticality: the ranking must reflect the graph, not opinion.

The asset register carries a hand-assigned ``criticality`` 1-5. That is a
statement about the asset alone. This module derives a second number from the
dependency graph, and the tests below pin the two claims that make it useful:

* it flows **upstream** -- an asset is dangerous to lose when critical services
  sit downstream of it, not when it is itself important;
* it is **reproducible** -- the same graph produces the same ranking, and the
  consequence figures are the cascade engine's own output rather than a
  parallel formula that could drift away from the simulation lab.
"""

from __future__ import annotations

import pytest

from app.core.permissions import ROLE_PERMISSIONS


def test_criticality_ranks_a_feeder_above_the_service_it_feeds(client, as_role):
    """An upstream asset that supplies several critical services outranks a
    critical service that supplies nothing.

    This is the whole point of the feature: HO-01 is a hospital (hand
    criticality 1) with no dependants, while PS-02 is a power station (hand
    criticality 2) whose loss takes out the hospital, the water pumps and the
    telecom exchange.
    """
    analyst = as_role("city_analyst")
    response = analyst.get("/api/resilience/criticality")
    assert response.status_code == 200, response.text
    ranking = response.json()["data"]["ranking"]
    assert ranking, "the ranking must not be empty"

    by_code = {row["code"]: row for row in ranking}
    feeder = by_code["PS-02"]
    hospital = by_code["HO-01"]

    assert feeder["criticality_index"] > hospital["criticality_index"], (
        "the feeder that takes out the hospital must outrank the hospital itself"
    )
    # And the hand-assigned number says the opposite, which is the insight.
    assert hospital["criticality"] < feeder["criticality"]
    assert hospital["consequence"]["critical_services_lost"], (
        "losing the hospital is a critical-service loss for its own site"
    )


def test_every_asset_is_scored(client, as_role):
    """No row may come back with a null index.

    An earlier revision scored a shortlist and returned nulls for the rest, which
    reads as "unknown risk" on a heatmap whose job is to rank the whole city.
    """
    analyst = as_role("city_analyst")
    data = analyst.get("/api/resilience/criticality?limit=60").json()["data"]
    assert data["ranking"], "expected a ranking"
    for row in data["ranking"]:
        assert isinstance(row["criticality_index"], (int, float)), (
            f"{row['code']} came back without a derived index"
        )
        assert row["consequence"] is not None
        assert "assets_failed" in row["consequence"]


def test_ranking_is_stable_across_calls(client, as_role):
    """Same graph, same ranking -- the model has no random component."""
    analyst = as_role("city_analyst")
    first = analyst.get("/api/resilience/criticality").json()["data"]["ranking"]
    second = analyst.get("/api/resilience/criticality").json()["data"]["ranking"]
    assert [r["code"] for r in first] == [r["code"] for r in second]
    assert [r["criticality_index"] for r in first] == [r["criticality_index"] for r in second]


def test_consequence_estimate_matches_the_cascade_engine(client, as_role):
    """The reported blast radius is the simulation lab's answer, not a recount.

    Running the same single-asset failure through the public simulation endpoint
    must produce the same affected-asset count, so the two screens cannot
    disagree about the same event.
    """
    analyst = as_role("city_analyst")
    ranking = analyst.get("/api/resilience/criticality").json()["data"]["ranking"]
    subject = next(r for r in ranking if r["criticality_index"] > 0)

    direct = analyst.get(f"/api/resilience/criticality/{subject['asset_id']}/consequence")
    assert direct.status_code == 200, direct.text
    estimate = direct.json()["data"]

    run = analyst.post(
        "/api/simulations/run",
        json={
            "name": "cross-check the criticality estimate",
            "initial_failure_ids": [subject["asset_id"]],
            "cascade_threshold": 0.35,
            "max_depth": 6,
            "failure_mode": "total_failure",
        },
    )
    assert run.status_code == 201, run.text
    summary = run.json()["data"]["summary"]
    assert estimate["summary"]["assets_impacted"] == summary["assets_impacted"]
    assert estimate["summary"]["assets_failed"] == summary["assets_failed"]


def test_model_assumptions_are_reported(client, as_role):
    """A ranking nobody can explain is a ranking nobody should act on."""
    analyst = as_role("city_analyst")
    data = analyst.get("/api/resilience/criticality").json()["data"]
    model = data["model"]
    assert model["assumptions"], "the response must state its assumptions"
    assert set(model["weights"]) == {"reach", "blast", "population", "single_point"}
    assert sum(model["weights"].values()) == pytest.approx(1.0), (
        "weights must form a convex combination or the index is not 0..100"
    )
    assert model["critical_categories"]


def test_consequence_is_not_found_for_a_missing_asset(client, as_role):
    analyst = as_role("city_analyst")
    assert analyst.get("/api/resilience/criticality/999999/consequence").status_code == 404


# --------------------------------------------------------------------------- #
# permissions for all four actors
# --------------------------------------------------------------------------- #


def test_all_four_roles_can_read_criticality(client, as_role):
    for role in ("super_admin", "city_operator", "field_engineer", "city_analyst"):
        response = as_role(role).get("/api/resilience/criticality?limit=3")
        assert response.status_code == 200, f"{role} -> {response.status_code}"


def test_anonymous_cannot_read_criticality(anonymous):
    """The ranking is a map of which assets to attack; it is not public."""
    assert anonymous.get("/api/resilience/criticality").status_code == 401


def test_every_role_holds_resilience_read():
    for role in ("super_admin", "city_operator", "field_engineer", "city_analyst"):
        assert "resilience:read" in ROLE_PERMISSIONS[role], f"{role} cannot see the new screens"
