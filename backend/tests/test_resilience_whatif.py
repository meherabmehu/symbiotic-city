"""What-if scenarios must persist, compare, and explain the difference.

Three claims are tested, because they are what separates this from "run a
simulation twice": a saved hypothesis survives as a record, a comparison is made
against the reading that was taken at the time, and the explanation attributes a
difference only when the inputs actually isolate it.
"""

from __future__ import annotations

import uuid

import pytest


def _assets(api) -> dict[str, int]:
    return {a["code"]: a["id"] for a in api.get("/api/infrastructure?page_size=100").json()["data"]}


def _new_scenario(api, asset_ids, **overrides):
    body = {
        "name": f"What-if probe {uuid.uuid4().hex[:6]}",
        "description": "regression probe",
        "initial_failure_ids": asset_ids,
        **overrides,
    }
    response = api.post("/api/resilience/whatif", json=body)
    assert response.status_code == 201, response.text
    return response.json()["data"]


def _observe(api, scenario_id, note=""):
    response = api.post(f"/api/resilience/whatif/{scenario_id}/observe", json={"note": note})
    assert response.status_code == 201, response.text
    return response.json()["data"]


def test_a_saved_scenario_survives_and_records_its_readings(client, as_role):
    analyst = as_role("city_analyst")
    assets = _assets(analyst)
    scenario = _new_scenario(analyst, [assets["PS-01"]], description="first hypothesis")
    assert scenario["code"].startswith("WI-")
    observation = _observe(analyst, scenario["id"], note="initial reading")
    assert observation["run_id"], "a reading must come from a stored run"

    listed = analyst.get("/api/resilience/whatif").json()["data"]
    stored = next(s for s in listed if s["id"] == scenario["id"])
    assert stored["description"] == "first hypothesis"
    assert len(stored["observations"]) >= 1
    assert stored["observations"][0]["note"] == "initial reading"
    assert stored["observations"][0]["metrics"]["assets_failed"] >= 1


def test_comparison_explains_a_single_input_difference(client, as_role):
    """Two scenarios differing only in the starting asset: one change, one cause."""
    analyst = as_role("city_analyst")
    assets = _assets(analyst)
    left = _new_scenario(analyst, [assets["PS-01"]])
    right = _new_scenario(analyst, [assets["PS-02"]])
    _observe(analyst, left["id"])
    _observe(analyst, right["id"])

    response = analyst.get(f"/api/resilience/whatif/compare?ids={left['id']}&ids={right['id']}")
    assert response.status_code == 200, response.text
    data = response.json()["data"]

    assert len(data["columns"]) == 2
    assert all(c["has_reading"] for c in data["columns"])

    explanation = data["explanation"]
    assert explanation["input_changes"], "different starting assets must be reported"
    fields = {c["field"] for c in explanation["input_changes"]}
    assert fields == {"initial_failure_ids"}, (
        "only the starting failure differs, so nothing else may be blamed"
    )
    assert any("single change" in n or "accounts for the divergence" in n for n in explanation["notes"])

    # The shared core and the divergent parts must both be reported.
    assert explanation["headline"]
    assert explanation["only_in"], "two different starting assets must diverge somewhere"


def test_comparison_refuses_to_attribute_when_several_inputs_differ(client, as_role):
    """Honesty over neatness: multiply-different inputs get no single cause."""
    analyst = as_role("city_analyst")
    assets = _assets(analyst)
    left = _new_scenario(analyst, [assets["SS-01"]], cascade_threshold=0.35)
    right = _new_scenario(analyst, [assets["SS-02"]], cascade_threshold=0.15, max_depth=3)
    _observe(analyst, left["id"])
    _observe(analyst, right["id"])

    data = analyst.get(
        f"/api/resilience/whatif/compare?ids={left['id']}&ids={right['id']}"
    ).json()["data"]
    fields = {c["field"] for c in data["explanation"]["input_changes"]}
    assert {"initial_failure_ids", "cascade_threshold", "max_depth"} <= fields
    assert any("cannot be attributed" in n for n in data["explanation"]["notes"])


def test_comparison_works_before_a_reading_is_recorded(client, as_role):
    """A fresh scenario must not break the comparison; it is reported as unread."""
    analyst = as_role("city_analyst")
    assets = _assets(analyst)
    read = _new_scenario(analyst, [assets["SS-03"]])
    _observe(analyst, read["id"])
    unread = _new_scenario(analyst, [assets["SS-04"]])

    data = analyst.get(
        f"/api/resilience/whatif/compare?ids={read['id']}&ids={unread['id']}"
    ).json()["data"]
    by_code = {c["scenario"]["code"]: c for c in data["columns"]}
    assert by_code[unread["code"]]["has_reading"] is False
    assert by_code[unread["code"]]["metrics"] is None
    assert data["explanation"]["notes"], "an unreadable column must be explained"


def test_scenario_validation(client, as_role):
    analyst = as_role("city_analyst")
    # no assets
    empty = analyst.post(
        "/api/resilience/whatif",
        json={"name": "no failure", "initial_failure_ids": []},
    )
    assert empty.status_code == 422
    # unknown asset
    bogus = analyst.post(
        "/api/resilience/whatif",
        json={"name": "ghost asset", "initial_failure_ids": [999999]},
    )
    assert bogus.status_code == 422
    assert bogus.json()["error"]["code"] == "invalid_asset"


def test_compare_requires_two_or_more(client, as_role):
    analyst = as_role("city_analyst")
    assets = _assets(analyst)
    one = _new_scenario(analyst, [assets["TX-01"]])
    response = analyst.get(f"/api/resilience/whatif/compare?ids={one['id']}")
    assert response.status_code == 422


def test_only_one_baseline_at_a_time(client, as_role):
    analyst = as_role("city_analyst")
    assets = _assets(analyst)
    first = _new_scenario(analyst, [assets["WP-01"]], is_baseline=True)
    second = _new_scenario(analyst, [assets["WP-02"]], is_baseline=True)
    listed = {s["id"]: s for s in analyst.get("/api/resilience/whatif").json()["data"]}
    assert listed[second["id"]]["is_baseline"] is True
    assert listed[first["id"]]["is_baseline"] is False, (
        "marking a new baseline must demote the previous one, or the comparison "
        "has no unambiguous reference"
    )


def test_deleting_a_scenario_removes_its_readings(client, as_role):
    analyst = as_role("city_analyst")
    assets = _assets(analyst)
    scenario = _new_scenario(analyst, [assets["CM-01"]])
    _observe(analyst, scenario["id"])
    deleted = analyst.delete(f"/api/resilience/whatif/{scenario['id']}")
    assert deleted.status_code == 200
    listed = {s["id"] for s in analyst.get("/api/resilience/whatif").json()["data"]}
    assert scenario["id"] not in listed


# --------------------------------------------------------------------------- #
# permissions: the four actors
# --------------------------------------------------------------------------- #


def test_field_engineer_can_read_but_not_create(client, as_role):
    engineer = as_role("field_engineer")
    assert engineer.get("/api/resilience/whatif").status_code == 200
    assets = _assets(engineer)
    attempt = engineer.post(
        "/api/resilience/whatif",
        json={"name": "engineer attempt", "initial_failure_ids": [assets["HO-01"]]},
    )
    assert attempt.status_code == 403, "reading the record is not owning the decision"


def test_operator_and_analyst_can_create(client, as_role):
    for role in ("city_operator", "city_analyst"):
        api = as_role(role)
        assets = _assets(api)
        scenario = _new_scenario(api, [assets["SS-01"]], name=f"{role} scenario")
        assert scenario["id"]


def test_anonymous_cannot_touch_what_if(anonymous):
    assert anonymous.get("/api/resilience/whatif").status_code == 401
    assert anonymous.post(
        "/api/resilience/whatif",
        json={"name": "anonymous", "initial_failure_ids": [1]},
    ).status_code == 401


def test_creating_a_scenario_is_audited(client, as_role):
    analyst = as_role("city_analyst")
    admin = as_role("super_admin")
    assets = _assets(analyst)
    _new_scenario(analyst, [assets["SC-01"]])
    logs = admin.get("/api/audit-logs?page_size=50").json()["data"]
    assert any(entry["action"] == "whatif.create" for entry in logs), (
        "a saved hypothesis is a decision and must appear in the audit trail"
    )
