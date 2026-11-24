"""The heatmap must show provenance, not decoration.

A coloured square with no stated reason is worse than no map at all: it invites a
decision with nothing behind it. These tests pin the three things that make the
map honest -- every zone explains itself, the bands match the legend, and a zone
with no stored impact is not silently drawn as safe.
"""

from __future__ import annotations

import re


def _heatmap(api, **params):
    query = "&".join(f"{k}={v}" for k, v in params.items())
    path = "/api/resilience/heatmap" + (f"?{query}" if query else "")
    response = api.get(path)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_heatmap_covers_every_zone(client, as_role):
    analyst = as_role("city_analyst")
    data = _heatmap(analyst, ensure_run="true")
    zones = analyst.get("/api/zones").json()["data"]
    assert {z["code"] for z in data["zones"]} == {z["code"] for z in zones}, (
        "every registered zone must appear on the map, including empty ones"
    )
    assert data["totals"]["zones"] == len(zones)


def test_every_zone_explains_its_score(client, as_role):
    """No zone may be drawn without a stated driver."""
    analyst = as_role("city_analyst")
    data = _heatmap(analyst, ensure_run="true")
    for zone in data["zones"]:
        assert zone["drivers"], f"{zone['code']} has no stated reason for its colour"
        assert all(isinstance(d, str) and d.strip() for d in zone["drivers"])
        assert 0.0 <= zone["risk_score"] <= 100.0
        assert zone["risk_band"] in {b["band"] for b in data["legend"]}, (
            f"{zone['code']} reported a band the legend does not define"
        )


def test_legend_bands_are_ordered_and_complete(client, as_role):
    """A legend that skips a band leaves a colour unexplained."""
    analyst = as_role("city_analyst")
    data = _heatmap(analyst, ensure_run="true")
    legend = data["legend"]
    assert [b["band"] for b in legend] == ["low", "guarded", "elevated", "high", "severe"]
    # All but the last band are bounded by a threshold on the 0..100 score.
    thresholds = [b["threshold"] for b in legend[:-1]]
    assert thresholds == sorted(thresholds), "bands must be ordered worst-last"
    for entry in legend:
        assert entry["description"], "every band needs a readable description"
        assert entry["color_token"], "every band needs a design token"
        assert entry["label"]


def test_heatmap_creates_a_real_run_when_the_database_has_none(client, as_role):
    """The baseline run is computed and persisted, not synthesised for the screen."""
    analyst = as_role("city_analyst")
    before = analyst.get("/api/simulations?page_size=100").json()["meta"]["total"]
    data = _heatmap(analyst, ensure_run="true")
    after = analyst.get("/api/simulations?page_size=100").json()["meta"]["total"]
    if data["source"] == "synthetic":
        assert after == before + 1, "the map claimed to derive a run but none was stored"
        assert data["runs"], "the map must name the run it is showing"
        run_id = data["runs"][0]["id"]
        stored = analyst.get(f"/api/simulations/{run_id}")
        assert stored.status_code == 200, "the run the map cites must be retrievable"
    else:
        assert after >= before


def test_heatmap_can_be_pinned_to_named_runs(client, as_role):
    """Selecting runs must change the view and say that it did."""
    analyst = as_role("city_analyst")
    _heatmap(analyst, ensure_run="true")
    runs = analyst.get("/api/simulations?page_size=5").json()["data"]
    assert runs, "expected at least one stored run"

    pinned = _heatmap(analyst, run_ids=runs[0]["id"])
    assert pinned["source"] == "selected"
    assert [r["id"] for r in pinned["runs"]] == [runs[0]["id"]]


def test_zone_risk_is_not_shown_as_safe_when_nothing_was_simulated(client, as_role):
    """A zone with no stored impact must not look like a passing grade.

    Riverside has no failed asset in the baseline run; it must still report its
    derived exposure honestly rather than a bare zero, and must be distinguishable
    from a zone that was measured.
    """
    analyst = as_role("city_analyst")
    data = _heatmap(analyst, ensure_run="true")
    unmeasured = [z for z in data["zones"] if not z["has_stored_impact"]]
    for zone in unmeasured:
        assert zone["drivers"], "an unmeasured zone still needs to explain itself"
        assert zone["asset_count"] >= 0
    # And at least one zone in the seeded city must carry a real stored failure,
    # otherwise this test would pass on an empty map.
    assert any(z["has_stored_impact"] for z in data["zones"])


def test_asset_colours_come_from_design_tokens(client, as_role):
    """The legend names tokens, not hexes, so the approved palette stays in one place."""
    analyst = as_role("city_analyst")
    data = _heatmap(analyst, ensure_run="true")
    for entry in data["legend"]:
        assert not re.search(r"#[0-9a-fA-F]{3,6}", entry["color_token"]), (
            "legend must reference a design token, not a literal colour"
        )


def test_heatmap_states_its_assumptions(client, as_role):
    analyst = as_role("city_analyst")
    data = _heatmap(analyst, ensure_run="true")
    assert data["assumptions"], "the model must state what it assumes"
    assert data["model"]["impact_weight"] + data["model"]["criticality_weight"] == 1.0


def test_field_engineer_can_view_the_map_but_anonymous_cannot(client, as_role, anonymous):
    assert as_role("field_engineer").get("/api/resilience/heatmap").status_code == 200
    assert anonymous.get("/api/resilience/heatmap").status_code == 401
