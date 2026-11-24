"""Replay must show the city the record actually supports, and no more.

The point of time travel here is not animation. It is being able to say "this
asset was offline at 14:32, and here is the status change that says so". So the
tests check the exact claims: status comes from append-only history and walks
backwards correctly, a moment before any history falls back to the earliest
recorded previous status, a change between two moments is reported as worse or
better rather than as a bare difference, and a replay contains only moments where
something happened.

The service also has to be honest about what it cannot reconstruct. A test asserts
that the fidelity section names the gaps instead of quietly omitting them.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.core.types import utcnow


def _assets(api) -> dict[str, int]:
    return {a["code"]: a["id"] for a in api.get("/api/infrastructure?page_size=100").json()["data"]}


def _snapshot(api, at: str | None = None) -> dict:
    suffix = f"?at={at}" if at else ""
    response = api.get(f"/api/resilience/timetravel/snapshot{suffix}")
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_snapshot_reports_current_status_with_evidence(client, as_role):
    operator = as_role("city_operator")
    snapshot = _snapshot(operator)
    assert snapshot["status_counts"]["operational"] >= 1
    assert len(snapshot["assets"]) >= 20
    for asset in snapshot["assets"]:
        assert asset["status"], asset["code"]
        # Every status must be traceable, even when the evidence is "before history".
        assert asset["evidence"] is not None, f"{asset['code']} has no evidence for its status"


def test_a_status_change_is_visible_to_the_next_snapshot(client, as_role):
    """Mark an asset offline and the reconstruction must report it, with the entry
    that recorded it."""
    operator = as_role("city_operator")
    assets = _assets(operator)
    target = assets["WP-01"]
    response = operator.patch(f"/api/infrastructure/{target}", json={"status": "offline"})
    assert response.status_code == 200, response.text

    snapshot = _snapshot(operator)
    state = next(a for a in snapshot["assets"] if a["id"] == target)
    assert state["status"] == "offline"
    assert state["evidence"]["inferred"] is False
    assert state["evidence"]["at"]


def test_replay_reports_a_failure_as_a_worsening_change(client, as_role):
    operator = as_role("city_operator")
    assets = _assets(operator)
    operator.patch(f"/api/infrastructure/{assets['SS-03']}", json={"status": "offline"})

    now = utcnow()
    first = (now - timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    second = (now + timedelta(seconds=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
    response = operator.get(f"/api/resilience/timetravel/diff?first={first}&second={second}")
    assert response.status_code == 200, response.text
    data = response.json()["data"]

    changed = {c["asset_code"]: c for c in data["changes"]}
    assert "SS-03" in changed, [c["asset_code"] for c in data["changes"]]
    assert changed["SS-03"]["direction"] == "worse"
    assert data["worsened"]
    assert data["notes"]


def test_recovery_reads_as_an_improvement(client, as_role):
    """The same machinery must be able to say the city got better.

    The first moment is taken from the record itself -- just after the asset went
    offline -- because that is the only moment at which it was actually down.
    """
    operator = as_role("city_operator")
    assets = _assets(operator)
    operator.patch(f"/api/infrastructure/{assets['CM-02']}", json={"status": "offline"})
    replay = operator.get("/api/resilience/timetravel?limit=200").json()["data"]
    offline_step = next(
        step
        for step in replay["steps"]
        if step["kind"] == "status" and step.get("asset_id") == assets["CM-02"]
    )

    operator.patch(f"/api/infrastructure/{assets['CM-02']}", json={"status": "operational"})
    data = operator.get(
        "/api/resilience/timetravel/diff",
        params={
            "first": offline_step["at"],
            "second": utcnow().isoformat(),
        },
    ).json()["data"]
    improved = {c["asset_code"] for c in data["improved"]}
    assert "CM-02" in improved, data["notes"]
    assert any("got better" in note for note in data["notes"])


def test_a_round_trip_reads_as_no_change(client, as_role):
    """Offline and back again between two moments is not an improvement.

    A point-to-point comparison must report what is true at the two moments, not
    the story of what happened between them; the replay is where the story lives.
    """
    operator = as_role("city_operator")
    assets = _assets(operator)
    now = utcnow()
    before = (now - timedelta(seconds=2)).isoformat()
    operator.patch(f"/api/infrastructure/{assets['RE-01']}", json={"status": "offline"})
    operator.patch(f"/api/infrastructure/{assets['RE-01']}", json={"status": "operational"})
    data = operator.get(
        "/api/resilience/timetravel/diff",
        params={"first": before, "second": utcnow().isoformat()},
    ).json()["data"]
    changed = {c["asset_code"] for c in data["changes"]}
    assert "RE-01" not in changed


def test_snapshot_before_history_falls_back_honestly(client, as_role):
    """A moment earlier than every recorded change cannot be known exactly, and
    must say so rather than reporting today's status as if it were then."""
    analyst = as_role("city_analyst")
    snapshot = _snapshot(analyst, "2000-01-01T00:00:00Z")
    for asset in snapshot["assets"]:
        assert asset["evidence"]["inferred"] is True
        assert "before the first recorded change" in asset["evidence"]["reason"]


def test_replay_only_contains_recorded_moments(client, as_role):
    analyst = as_role("city_analyst")
    response = analyst.get("/api/resilience/timetravel?limit=200")
    assert response.status_code == 200, response.text
    data = response.json()["data"]

    assert data["steps"], data["notes"]
    times = [step["at"] for step in data["steps"]]
    assert times == sorted(times), "a replay must run forwards"
    kinds = {step["kind"] for step in data["steps"]}
    assert "status" in kinds or "simulation" in kinds
    for step in data["steps"]:
        assert step["summary"]
        assert step["kind"] in {"status", "simulation", "incident", "design", "dispatch", "response"}


def test_replay_limit_is_reported_not_silent(client, as_role):
    analyst = as_role("city_analyst")
    data = analyst.get("/api/resilience/timetravel?limit=1").json()["data"]
    if data["total_changes"] > 1:
        assert data["truncated"] is True
        assert len(data["steps"]) == 1
        assert any("limit" in note for note in data["notes"]), (
            "a truncated replay must say it was truncated"
        )


def test_fidelity_declares_what_cannot_be_reconstructed(client, as_role):
    analyst = as_role("city_analyst")
    fidelity = _snapshot(analyst)["fidelity"]
    assert fidelity["exact"]
    assert fidelity["inferred"]
    assert any("resource" in item for item in fidelity["not_reconstructed"])
    assert any("status" in item for item in fidelity["exact"])


def test_population_at_risk_counts_offline_and_failed(client, as_role):
    """Both words for "not delivering service" must count, or a lost substation
    reports as zero risk."""
    operator = as_role("city_operator")
    assets = _assets(operator)
    operator.patch(f"/api/infrastructure/{assets['WT-01']}", json={"status": "offline"})
    snapshot = _snapshot(operator)
    assert snapshot["population_at_risk"] >= 1000
    offline = [a for a in snapshot["assets"] if a["status"] == "offline"]
    assert offline
    assert snapshot["population_at_risk"] == sum(a["population_weight"] for a in offline)


def test_bad_timestamp_is_a_clear_error(client, as_role):
    analyst = as_role("city_analyst")
    response = analyst.get("/api/resilience/timetravel/diff?first=yesterday&second=now")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_timestamp"


def test_timestamps_with_an_unescaped_offset_are_accepted(client, as_role):
    """``isoformat()`` emits ``+00:00``; unescaped in a query string the ``+``
    becomes a space. That must not be reported as bad formatting."""
    analyst = as_role("city_analyst")
    now = utcnow().replace(microsecond=0)
    response = analyst.get(
        "/api/resilience/timetravel/diff",
        params={"first": now.isoformat(), "second": (now + timedelta(seconds=1)).isoformat()},
    )
    assert response.status_code == 200, response.text


def test_anonymous_cannot_replay(anonymous):
    assert anonymous.get("/api/resilience/timetravel").status_code == 401
    assert anonymous.get("/api/resilience/timetravel/snapshot").status_code == 401


def test_field_engineer_may_read_history(client, as_role):
    engineer = as_role("field_engineer")
    assert engineer.get("/api/resilience/timetravel?limit=5").status_code == 200
    assert engineer.get("/api/resilience/timetravel/snapshot").status_code == 200
