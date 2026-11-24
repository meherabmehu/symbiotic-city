"""Dependency recovery must restore only what the cascade broke.

Changing an asset's status propagates to the assets that depend on it, so the
digital twin stays truthful. The recovery half of that propagation used to be
unconditional: restoring an upstream asset promoted every direct dependent that
was offline or degraded to operational, whatever the reason.

That produced two wrong answers, both observable through the API:

- a dependent in scheduled maintenance was silently returned to service;
- a dependent with its own unrelated outage was reported as fixed while its
  fault was still live.

The fix uses the status history to tell a status this module wrote from a status
someone else wrote, and it restores the asset to the state it held before the
cascade rather than to an invented "operational".
"""

from __future__ import annotations

import uuid

import pytest


def _create_asset(api, code: str, category: str = "hospital") -> int:
    response = api.post(
        "/api/infrastructure",
        json={
            "code": code,
            "name": f"Recovery probe {code}",
            "category": category,
            "criticality": 4,
            "capacity": 100,
            "capacity_unit": "units",
            "load_percent": 40,
            "latitude": 23.8,
            "longitude": 90.4,
            "map_x": 20,
            "map_y": 30,
            "commissioned_on": "2024-01-01",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["data"]["id"]


@pytest.fixture()
def feeder_and_dependent(as_role):
    """An upstream asset, a dependent with a single non-redundant feed to it."""
    admin = as_role("super_admin")
    tag = uuid.uuid4().hex[:6].upper()
    upstream = _create_asset(admin, f"REC-UP-{tag}", "power_station")
    dependent = _create_asset(admin, f"REC-DN-{tag}", "hospital")
    link = admin.post(
        "/api/dependencies",
        json={
            "source_asset_id": upstream,
            "target_asset_id": dependent,
            "dependency_type": "power",
            "impact_weight": 1.0,
            "redundancy": 0.0,
            "description": "sole feeder",
        },
    )
    assert link.status_code == 201, link.text
    return admin, upstream, dependent


def _set_status(api, asset_id: int, status: str, reason: str) -> None:
    response = api.post(
        f"/api/infrastructure/{asset_id}/status",
        json={"status": status, "reason": reason},
    )
    assert response.status_code == 200, response.text


def _status(api, asset_id: int) -> str:
    return api.get(f"/api/infrastructure/{asset_id}").json()["data"]["status"]


def test_upstream_failure_still_cascades_to_a_dependent(feeder_and_dependent):
    """The behaviour the fix must not break."""
    api, upstream, dependent = feeder_and_dependent
    _set_status(api, upstream, "offline", "storm damage")
    assert _status(api, dependent) == "offline"


def test_plain_recovery_still_restores_a_dependent(feeder_and_dependent):
    """A dependent the cascade took down must come back when the cause clears."""
    api, upstream, dependent = feeder_and_dependent
    _set_status(api, upstream, "offline", "storm damage")
    assert _status(api, dependent) == "offline"
    _set_status(api, upstream, "operational", "grid restored")
    assert _status(api, dependent) == "operational"


def test_recovery_does_not_cancel_scheduled_maintenance(feeder_and_dependent):
    """Maintenance is an independent decision, not a cascade artefact.

    The dependent was already in maintenance for its own reason before the
    upstream failure. Restoring the upstream must leave the maintenance alone:
    the outage did not service the generator.
    """
    api, upstream, dependent = feeder_and_dependent
    _set_status(api, dependent, "maintenance", "scheduled generator service")
    _set_status(api, upstream, "offline", "storm damage")
    _set_status(api, upstream, "operational", "grid restored")

    assert _status(api, dependent) == "maintenance", (
        "restoring the feeder put a hospital back into service while it was "
        "still in scheduled maintenance"
    )


def test_recovery_does_not_mask_an_unrelated_outage(feeder_and_dependent):
    """A dependent with its own fault must stay down when the feeder returns.

    Both assets went offline independently. Only the feeder was restored, so the
    hospital's own outage is still live and must still be reported.
    """
    api, upstream, dependent = feeder_and_dependent
    _set_status(api, upstream, "offline", "substation flooding")
    _set_status(api, dependent, "offline", "basement flooded")
    _set_status(api, upstream, "operational", "water pumped out")

    assert _status(api, dependent) == "offline", (
        "restoring the feeder reported a hospital outage as fixed while the "
        "hospital's own fault was still live"
    )
