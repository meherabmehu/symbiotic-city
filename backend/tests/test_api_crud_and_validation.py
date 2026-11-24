"""CRUD, pagination, filtering, sorting, validation and edge cases."""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.core.database import SessionLocal
from app.models.infrastructure import InfrastructureAsset
from tests.conftest import unique_category


def test_infrastructure_pagination_and_meta(as_role):
    operator = as_role("super_admin")
    first = operator.get("/api/infrastructure?page=1&page_size=5").json()
    assert len(first["data"]) == 5
    assert first["meta"]["total"] >= 20
    assert first["meta"]["has_next"] is True
    second = operator.get("/api/infrastructure?page=2&page_size=5").json()
    assert {a["id"] for a in first["data"]} & {a["id"] for a in second["data"]} == set()


def test_infrastructure_filter_by_category_and_status(as_role):
    admin = as_role("super_admin")
    hospitals = admin.get("/api/infrastructure?category=hospital").json()["data"]
    assert hospitals and all(a["category"] == "hospital" for a in hospitals)
    offline = admin.get("/api/infrastructure?status=offline").json()["data"]
    assert all(a["status"] == "offline" for a in offline)


def test_infrastructure_search_and_sort(as_role):
    admin = as_role("super_admin")
    result = admin.get("/api/infrastructure?search=hospital&page_size=50").json()["data"]
    assert result
    for asset in result:
        haystack = " ".join(
            filter(None, [asset["name"], asset["code"], asset.get("notes") or ""])
        ).lower()
        assert "hospital" in haystack
    desc = admin.get("/api/infrastructure?sort=capacity&direction=desc&page_size=5").json()["data"]
    capacities = [a["capacity"] for a in desc]
    assert capacities == sorted(capacities, reverse=True)


def test_create_update_and_archive_asset(as_role):
    admin = as_role("super_admin")
    code = f"TST-{uuid.uuid4().hex[:6].upper()}"
    created = admin.post(
        "/api/infrastructure",
        json={
            "code": code,
            "name": "Test Telemetry Station",
            "category": "telecom",
            "criticality": 3,
            "capacity": 12,
            "capacity_unit": "Racks",
            "load_percent": 42,
            "latitude": 23.8,
            "longitude": 90.4,
            "map_x": 33,
            "map_y": 44,
        },
    )
    assert created.status_code == 201, created.text
    asset = created.json()["data"]
    assert asset["code"] == code
    updated = admin.patch(f"/api/infrastructure/{asset['id']}", json={"load_percent": 55})
    assert updated.status_code == 200
    assert updated.json()["data"]["load_percent"] == 55
    archived = admin.delete(f"/api/infrastructure/{asset['id']}")
    assert archived.status_code == 200
    assert admin.get("/api/infrastructure?search=" + code).json()["meta"]["total"] == 0
    assert admin.get("/api/infrastructure?search=" + code + "&include_archived=true").json()["meta"]["total"] == 1


def test_duplicate_asset_code_is_rejected(as_role):
    admin = as_role("super_admin")
    payload = {
        "code": "PS-01",
        "name": "Duplicate power station",
        "category": "power_station",
        "latitude": 23.8,
        "longitude": 90.4,
    }
    response = admin.post("/api/infrastructure", json=payload)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "duplicate_code"


@pytest.mark.parametrize(
    ("payload", "field"),
    [
        ({"code": "bad code!", "name": "x"}, "code"),
        ({"code": "OK-1", "name": "y", "latitude": 500}, "latitude"),
        ({"code": "OK-2", "name": "z", "load_percent": 140}, "load_percent"),
        ({"code": "OK-3", "name": "w", "category": "not_a_category"}, "category"),
    ],
)
def test_invalid_infrastructure_payloads_are_rejected(as_role, payload, field):
    admin = as_role("super_admin")
    body = {
        "code": "VAL-1",
        "name": "Validation probe",
        "category": "school",
        "latitude": 23.8,
        "longitude": 90.4,
        **payload,
    }
    response = admin.post("/api/infrastructure", json=body)
    assert response.status_code == 422
    fields = [d["field"] for d in response.json()["error"]["details"]]
    assert field in fields


def test_malformed_json_body_returns_422(as_role):
    admin = as_role("super_admin")
    response = admin.client.post(
        "/api/infrastructure",
        content=b"{not-json",
        headers={**admin.headers, "Content-Type": "application/json"},
    )
    assert response.status_code == 422


def test_status_change_writes_history_and_propagates(as_role):
    admin = as_role("super_admin")
    assets = admin.get("/api/infrastructure?search=SS-03").json()["data"]
    asset = assets[0]
    response = admin.post(
        f"/api/infrastructure/{asset['id']}/status",
        json={"status": "offline", "reason": "Transformer failure drill"},
    )
    assert response.status_code == 200
    detail = admin.get(f"/api/infrastructure/{asset['id']}").json()["data"]
    assert detail["status"] == "offline"
    assert detail["history"][0]["new_status"] == "offline"
    restored = admin.post(
        f"/api/infrastructure/{asset['id']}/status",
        json={"status": "operational", "reason": "Drill complete"},
    )
    assert restored.status_code == 200


def test_circular_dependency_is_blocked(as_role):
    admin = as_role("super_admin")
    assets = {a["code"]: a["id"] for a in admin.get("/api/infrastructure?page_size=100").json()["data"]}
    # PS-01 -> SS-01 exists; adding SS-01 -> PS-01 would close a cycle
    response = admin.post(
        "/api/dependencies",
        json={
            "source_asset_id": assets["SS-01"],
            "target_asset_id": assets["PS-01"],
            "dependency_type": "power",
            "impact_weight": 0.5,
            "redundancy": 0.0,
        },
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "circular_dependency"


def test_self_dependency_is_rejected(as_role):
    admin = as_role("super_admin")
    asset = admin.get("/api/infrastructure?search=HO-01").json()["data"][0]
    response = admin.post(
        "/api/dependencies",
        json={"source_asset_id": asset["id"], "target_asset_id": asset["id"]},
    )
    assert response.status_code == 422


def test_duplicate_incident_for_same_asset_and_category_is_blocked(as_role):
    operator = as_role("city_operator")
    asset = operator.get("/api/infrastructure?search=TX-02").json()["data"][0]
    category = unique_category()
    body = {
        "title": "Duplicate prevention probe",
        "description": "First incident of this category.",
        "primary_asset_id": asset["id"],
        "category": category,
        "severity": "low",
    }
    first = operator.post("/api/incidents", json=body)
    assert first.status_code == 201
    second = operator.post("/api/incidents", json={**body, "title": "Second identical incident"})
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "duplicate_incident"


def test_invalid_incident_transitions_are_rejected(as_role):
    operator = as_role("city_operator")
    asset = operator.get("/api/infrastructure?search=CM-02").json()["data"][0]
    incident = operator.post(
        "/api/incidents",
        json={
            "title": "Transition validation probe",
            "description": "Reported incidents cannot jump straight to resolved.",
            "primary_asset_id": asset["id"],
            "category": unique_category(),
            "severity": "medium",
        },
    ).json()["data"]
    response = operator.post(
        f"/api/incidents/{incident['id']}/transition",
        json={"status": "resolved", "note": "skipping steps"},
    )
    assert response.status_code == 409
    error = response.json()["error"]
    assert error["code"] == "invalid_transition"
    assert "resolved" in error["message"]


def test_incident_search_filters_and_summary(as_role):
    operator = as_role("city_operator")
    critical = operator.get("/api/incidents?severity=critical&page_size=50").json()
    assert all(i["severity"] == "critical" for i in critical["data"])
    summary = operator.get("/api/incidents/summary").json()["data"]
    assert summary["total"] >= summary["active"]
    search = operator.get("/api/incidents?search=failure&page_size=50").json()
    assert all("failure" in i["title"].lower() for i in search["data"])


def test_resource_capacity_cannot_drop_below_reserved(as_role):
    admin = as_role("super_admin")
    operator = admin  # super admin holds resource:write
    resource = admin.get("/api/resources?category=generator").json()["data"][0]
    reserved = operator.post(
        f"/api/resources/{resource['id']}/reserve",
        json={"quantity": resource["capacity"] - 10},
    )
    assert reserved.status_code == 200, reserved.text
    shrink = admin.patch(
        f"/api/resources/{resource['id']}", json={"capacity": resource["capacity"] - 20}
    )
    assert shrink.status_code == 409
    assert shrink.json()["error"]["code"] == "capacity_below_reserved"
    release = operator.post(
        f"/api/resources/reservations/{reserved.json()['data']['id']}/release",
        json={"reason": "Test cleanup"},
    )
    assert release.status_code == 200


def test_over_reservation_is_rejected(as_role):
    operator = as_role("super_admin")
    resource = operator.get("/api/resources?category=crew").json()["data"][0]
    first = operator.post(f"/api/resources/{resource['id']}/reserve", json={"quantity": 1})
    assert first.status_code == 200
    second = operator.post(f"/api/resources/{resource['id']}/reserve", json={"quantity": 1})
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "insufficient_capacity"
    operator.post(
        f"/api/resources/reservations/{first.json()['data']['id']}/release",
        json={"reason": "Test cleanup"},
    )


def test_twin_graph_reflects_database_state(as_role):
    admin = as_role("super_admin")
    graph = admin.get("/api/twin/graph").json()["data"]
    assert graph["stats"]["nodes"] == len(graph["nodes"]) == 23
    assert graph["stats"]["edges"] >= 20
    assert all(edge["source"] != edge["target"] for edge in graph["edges"])


def test_notifications_flow(as_role):
    engineer = as_role("field_engineer")
    inbox = engineer.get("/api/notifications").json()
    assert "unread_count" in inbox
    if inbox["data"]:
        first = inbox["data"][0]
        read = engineer.post(f"/api/notifications/{first['id']}/read")
        assert read.status_code == 200
        refreshed = engineer.get("/api/notifications").json()
        assert refreshed["unread_count"] <= inbox["unread_count"]


def test_analytics_reflect_stored_records(as_role):
    analyst = as_role("city_analyst")
    overview = analyst.get("/api/analytics/overview").json()["data"]
    categories = analyst.get("/api/analytics/categories").json()["data"]
    assert overview["assets_total"] == sum(row["total"] for row in categories)
    assert 0 <= overview["health_index"] <= 100
    assert overview["generated_at"]


def test_analytics_export_returns_csv(as_role):
    analyst = as_role("city_analyst")
    response = analyst.get("/api/analytics/export?kind=categories")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "attachment" in response.headers["content-disposition"]
    assert response.text.splitlines()[0].startswith("category")
    bad = analyst.get("/api/analytics/export?kind=nonsense")
    assert bad.status_code == 422


def test_operator_cannot_export_reports(as_role):
    operator = as_role("city_operator")
    assert operator.get("/api/analytics/export?kind=categories").status_code == 403


def test_settings_are_validated(as_role):
    admin = as_role("super_admin")
    bad = admin.patch("/api/settings/cascade_threshold?value=abc")
    assert bad.status_code == 422
    good = admin.patch("/api/settings/cascade_threshold?value=0.35")
    assert good.status_code == 200


def test_last_super_admin_cannot_be_demoted(as_role):
    admin = as_role("super_admin")
    me = admin.get("/api/auth/me").json()["data"]["user"]["id"]
    response = admin.patch(f"/api/users/{me}", json={"role": "city_operator"})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "self_role_change"


def test_user_management_create_and_deactivate(as_role, unique_email):
    admin = as_role("super_admin")
    created = admin.post(
        "/api/users",
        json={
            "full_name": "Managed Account",
            "email": unique_email,
            "password": "Managed#2026",
            "role": "city_analyst",
            "job_title": "Junior Analyst",
        },
    )
    assert created.status_code == 201, created.text
    user_id = created.json()["data"]["id"]
    deactivated = admin.patch(f"/api/users/{user_id}", json={"is_active": False})
    assert deactivated.status_code == 200
    assert deactivated.json()["data"]["is_active"] is False


def test_database_transaction_is_rolled_back_on_error(as_role):
    """A rejected write must not leave partial rows behind."""
    operator = as_role("city_operator")
    asset = operator.get("/api/infrastructure?search=RE-03").json()["data"][0]
    before = operator.get("/api/incidents?page_size=100").json()["meta"]["total"]
    # duplicate code triggers a service error after validation passed
    response = operator.post(
        "/api/incidents",
        json={
            "title": "Rollback probe",
            "description": "This request fails validation on the asset id.",
            "primary_asset_id": 999_999,
            "category": unique_category(),
            "severity": "low",
        },
    )
    assert response.status_code == 422
    after = operator.get("/api/incidents?page_size=100").json()["meta"]["total"]
    assert after == before
    with SessionLocal() as session:
        assert session.scalar(
            select(InfrastructureAsset).where(InfrastructureAsset.id == asset["id"])
        ) is not None


def test_analytics_csv_export_for_every_kind(as_role):
    """Regression: the incidents export called a service helper that never existed,
    so the whole endpoint answered 500. Every advertised kind must produce CSV."""
    analyst = as_role("city_analyst")
    for kind in ("overview", "categories", "incidents", "tasks", "recovery", "simulations"):
        response = analyst.get(f"/api/analytics/export?kind={kind}")
        assert response.status_code == 200, (kind, response.text)
        assert response.headers["content-type"].startswith("text/csv")
        body = response.text
        assert "," in body or body.strip() == "no data", (kind, body[:200])
        assert 'filename="symbiotic-city-' in response.headers["content-disposition"]


def test_analytics_export_rejects_unknown_kind(as_role):
    analyst = as_role("city_analyst")
    response = analyst.get("/api/analytics/export?kind=secrets")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_export"


def test_second_open_incident_for_same_asset_is_refused(as_role):
    """Idempotency guard: an operator cannot open a duplicate incident for the
    same asset and category while the first one is still open."""
    operator = as_role("city_operator")
    payload = {
        "title": "Duplicate guard probe",
        "description": "first",
        "category": "power_outage",
        "severity": "high",
        "primary_asset_id": 6,
    }
    first = operator.post("/api/incidents", json=payload)
    assert first.status_code == 201, first.text
    second = operator.post("/api/incidents", json={**payload, "title": "Duplicate guard probe 2"})
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "duplicate_incident"
    assert second.json()["error"]["details"]["incident_code"] == first.json()["data"]["code"]


# --------------------------------------------------------------------------- #
# CSV export must not hand a spreadsheet a formula written by a user.
#
# Incident titles, asset names and notes are free text. A title starting with
# "=" becomes a live formula when the exported file is opened: HYPERLINK and DDE
# payloads are the usual carriers. Quoting the CSV does not prevent evaluation,
# so the value itself has to be neutralised. Reachable as a crossed-permission
# attack: an operator writes incidents, an analyst opens the export.
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "payload",
    [
        '=HYPERLINK("http://evil.example/x","payroll")',
        "@SUM(1+1)*cmd|calc",
        "+1-1",
        "-2+3",
    ],
)
def test_export_csv_neutralises_formula_titles(as_role, payload):
    import uuid as _uuid

    operator = as_role("city_operator")
    assets = operator.get("/api/infrastructure?page_size=1").json()["data"]
    created = operator.post(
        "/api/incidents",
        json={
            "title": payload,
            "description": "csv injection probe",
            "primary_asset_id": assets[0]["id"],
            "category": f"inject_{_uuid.uuid4().hex[:8]}",
            "severity": "low",
        },
    )
    assert created.status_code == 201, created.text

    analyst = as_role("city_analyst")
    body = analyst.get("/api/analytics/export?kind=incidents").text

    for line in body.splitlines():
        for cell in line.split(","):
            value = cell.strip().strip('"').strip()
            if len(value) > 1 and value[0] in "=+-@":
                assert value.lstrip("+-").replace(".", "").isdigit(), (
                    f"a spreadsheet would evaluate {value[:60]!r} as a formula"
                )


def test_export_csv_keeps_genuine_numbers_as_numbers():
    """Neutralising must not turn every negative number into text."""
    from app.services.analytics import export_csv

    text = export_csv("probe", [{"label": "delta", "value": -3.5, "rise": "+12"}])
    line = text.splitlines()[1]
    assert "'-3.5" not in line, "a real number was quoted into text"
    assert "'+12" not in line


def test_export_csv_leaves_ordinary_text_alone():
    from app.services.analytics import export_csv

    text = export_csv("probe", [{"title": "Central substation feeder 3 overload"}])
    assert text.splitlines()[1] == "Central substation feeder 3 overload"
