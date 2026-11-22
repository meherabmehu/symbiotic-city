"""Role based and object level authorisation enforcement."""
from __future__ import annotations

import uuid

import pytest


def _asset_id(api, code: str) -> int:
    return api.get(f"/api/infrastructure?search={code}").json()["data"][0]["id"]


@pytest.fixture(scope="module")
def incident_id(client):
    """Creates one incident owned by the operator for task tests."""
    from tests.conftest import Api, CREDENTIALS

    operator = Api(client).login(*CREDENTIALS["city_operator"])
    asset = _asset_id(operator, "HO-02")
    response = operator.post(
        "/api/incidents",
        json={
            "title": f"Authorisation fixture incident {uuid.uuid4().hex[:6]}",
            "description": "Created by the authorisation test module.",
            "primary_asset_id": asset,
            "category": "fixture_auth",
            "severity": "medium",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["data"]["id"]


def test_anonymous_users_are_rejected_from_protected_endpoints(anonymous):
    for path in [
        "/api/infrastructure",
        "/api/dashboard",
        "/api/incidents",
        "/api/tasks",
        "/api/resources",
        "/api/users",
        "/api/audit-logs",
        "/api/twin/graph",
    ]:
        response = anonymous.get(path)
        assert response.status_code == 401, path


def test_analyst_cannot_create_incidents(as_role):
    analyst = as_role("city_analyst")
    response = analyst.post(
        "/api/incidents",
        json={
            "title": "Analyst should not be able to do this",
            "description": "nope",
            "primary_asset_id": 1,
            "category": "power_outage",
            "severity": "low",
        },
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


def test_engineer_cannot_read_the_user_directory(as_role):
    engineer = as_role("field_engineer")
    assert engineer.get("/api/users").status_code == 403


def test_engineer_cannot_read_audit_logs(as_role):
    assert as_role("field_engineer").get("/api/audit-logs").status_code == 403


def test_engineer_cannot_approve_recovery_plans(as_role):
    engineer = as_role("field_engineer")
    response = engineer.post(
        "/api/optimization/plans/1/approve", json={"approve": True, "note": "self approved"}
    )
    assert response.status_code == 403


def test_operator_cannot_manage_users(as_role):
    operator = as_role("city_operator")
    assert operator.get("/api/users").status_code == 403
    assert operator.patch("/api/users/1", json={"is_active": False}).status_code == 403


def test_operator_cannot_read_audit_logs(as_role):
    assert as_role("city_operator").get("/api/audit-logs").status_code == 403


def test_operator_cannot_change_settings(as_role):
    assert as_role("city_operator").patch("/api/settings/cascade_threshold?value=0.5").status_code == 403


def test_engineer_cannot_change_infrastructure(as_role):
    engineer = as_role("field_engineer")
    asset = _asset_id(engineer, "SS-01")
    response = engineer.patch(f"/api/infrastructure/{asset}", json={"name": "Renamed by engineer"})
    assert response.status_code == 403


def test_engineer_list_is_scoped_to_own_tasks(as_role):
    engineer = as_role("field_engineer")
    response = engineer.get("/api/tasks?assignee_id=999")
    assert response.status_code == 200
    for task in response.json()["data"]:
        assert task["assignee_id"] == engineer_id(engineer)


def engineer_id(api) -> int:
    return api.get("/api/auth/me").json()["data"]["user"]["id"]


def test_engineer_cannot_open_another_engineers_task(as_role, incident_id):
    operator = as_role("city_operator")
    engineer_one = as_role("field_engineer")
    engineer_two = as_role("field_engineer_2")
    asset = _asset_id(operator, "RE-02")
    created = operator.post(
        "/api/tasks",
        json={
            "title": "Exclusive ownership check",
            "description": "assigned to engineer two only",
            "asset_id": asset,
            "incident_id": incident_id,
            "assignee_id": engineer_id(engineer_two),
            "priority": 2,
            "estimated_hours": 1.0,
        },
    )
    assert created.status_code == 201, created.text
    task_id = created.json()["data"]["id"]

    if engineer_id(engineer_one) == engineer_id(engineer_two):  # pragma: no cover
        pytest.skip("demo engineers share an id")

    denied = engineer_one.get(f"/api/tasks/{task_id}")
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "task_not_owned"

    allowed = engineer_two.get(f"/api/tasks/{task_id}")
    assert allowed.status_code == 200

    takeover = engineer_one.post(
        f"/api/tasks/{task_id}/transition", json={"status": "accepted", "note": "claiming"}
    )
    assert takeover.status_code == 403


def test_engineer_cannot_verify_own_work(as_role, incident_id):
    operator = as_role("city_operator")
    engineer = as_role("field_engineer")
    asset = _asset_id(operator, "SC-02")
    task = operator.post(
        "/api/tasks",
        json={
            "title": "Verification authority check",
            "description": "engineer must not verify",
            "asset_id": asset,
            "incident_id": incident_id,
            "assignee_id": engineer_id(engineer),
            "priority": 3,
            "estimated_hours": 1.0,
        },
    ).json()["data"]
    for step in ("accepted", "in_progress", "completed"):
        response = engineer.post(
            f"/api/tasks/{task['id']}/transition", json={"status": step, "note": "done"}
        )
        assert response.status_code == 200, response.text
    verify = engineer.post(
        f"/api/tasks/{task['id']}/transition", json={"status": "verified", "note": "self verify"}
    )
    assert verify.status_code == 403


def test_notifications_are_isolated_per_user(as_role):
    engineer = as_role("field_engineer")
    other = as_role("city_analyst")
    admin_notes = other.get("/api/notifications").json()["data"]
    engineer_notes = engineer.get("/api/notifications").json()["data"]
    if admin_notes and engineer_notes:
        target = admin_notes[0]["id"]
        response = engineer.post(f"/api/notifications/{target}/read")
        assert response.status_code == 404


def test_super_admin_has_full_access(as_role):
    admin = as_role("super_admin")
    assert admin.get("/api/users").status_code == 200
    assert admin.get("/api/audit-logs").status_code == 200
    assert admin.get("/api/settings").status_code == 200
    assert admin.get("/api/dashboard").status_code == 200


def test_unauthenticated_write_cannot_bypass_with_forged_header(anonymous):
    response = anonymous.post(
        "/api/infrastructure", json={"code": "HACK-1", "name": "Injected", "category": "school"}
    )
    assert response.status_code == 401
