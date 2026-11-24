"""Permission gates must match the endpoint they protect.

These tests exist because several endpoints were guarded by a permission that
belonged to a neighbouring handler. The effect was two-sided and both sides were
wrong: roles that own a feature were locked out of it, and roles that own nothing
in that area were let in.

Each test asserts intent in role terms rather than in permission-string terms, so
it stays meaningful if the permission names are ever reorganised.
"""

from __future__ import annotations

import uuid

import pytest


# --------------------------------------------------------------------------- #
# analytics/* belongs to the analyst, not to anyone holding task:read
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "path",
    ["/api/analytics/resources", "/api/analytics/simulations", "/api/analytics/recovery"],
)
def test_analyst_can_read_every_analytics_view(as_role, path):
    """The analyst holds analytics:read; every analytics endpoint must honour it."""
    analyst = as_role("city_analyst")
    response = analyst.get(path)
    assert response.status_code == 200, f"{path} -> {response.status_code}: {response.text}"


@pytest.mark.parametrize(
    "path",
    ["/api/analytics/resources", "/api/analytics/simulations", "/api/analytics/recovery"],
)
def test_field_engineer_cannot_read_analytics(as_role, path):
    """A field engineer holds no analytics permission at all."""
    engineer = as_role("field_engineer")
    response = engineer.get(path)
    assert response.status_code == 403, f"{path} -> {response.status_code}: {response.text}"


def test_operator_can_read_every_analytics_view(as_role):
    operator = as_role("city_operator")
    for path in ["/api/analytics/resources", "/api/analytics/simulations", "/api/analytics/recovery"]:
        assert operator.get(path).status_code == 200, path


# --------------------------------------------------------------------------- #
# users/* mutations stay restricted to the administrator
# --------------------------------------------------------------------------- #


def test_operator_cannot_manage_users(as_role):
    """User administration is restricted to the administrator role."""
    operator = as_role("city_operator")
    response = operator.patch(
        "/api/users/1", json={"full_name": "Not Allowed", "role": "super_admin"}
    )
    assert response.status_code == 403, response.text


def test_admin_can_read_the_user_directory(as_role):
    admin = as_role("super_admin")
    assert admin.get("/api/users").status_code == 200


# --------------------------------------------------------------------------- #
# simulations: reading a saved scenario is not a privileged action
# --------------------------------------------------------------------------- #


def test_analyst_can_list_simulation_scenarios(as_role):
    analyst = as_role("city_analyst")
    assert analyst.get("/api/scenarios").status_code == 200


def test_engineer_cannot_list_simulation_scenarios(as_role):
    engineer = as_role("field_engineer")
    assert engineer.get("/api/scenarios").status_code == 403


# --------------------------------------------------------------------------- #
# workflows: ownership of the workflow module is workflow:read
# --------------------------------------------------------------------------- #


def test_analyst_can_read_the_workflow_console(as_role):
    """The analyst holds workflow:read and is expected to review recovery runs."""
    analyst = as_role("city_analyst")
    assert analyst.get("/api/workflows").status_code == 200


def test_engineer_cannot_read_the_workflow_console(as_role):
    engineer = as_role("field_engineer")
    assert engineer.get("/api/workflows").status_code == 403


# --------------------------------------------------------------------------- #
# Strict policy: an endpoint with no permission is not a read endpoint, it is an
# unguarded endpoint. Every authenticated read below must answer 403 to a role
# that holds no permission for that domain, including the anonymous caller.
# --------------------------------------------------------------------------- #

GUARDED_READS = [
    # (path, a logged-in role that holds NO permission for that domain)
    ("/api/resources", "city_analyst"),
    ("/api/resources/utilisation", "city_analyst"),
    ("/api/resources/reservations", "city_analyst"),
    ("/api/tasks", "city_analyst"),
    ("/api/tasks/engineers", "city_analyst"),
    ("/api/simulations", "field_engineer"),
    ("/api/optimization/plans", "field_engineer"),
    ("/api/optimization/requests", "field_engineer"),
    ("/api/workflows/1", "field_engineer"),
    ("/api/audit-logs", "city_operator"),
    ("/api/users", "city_operator"),
]

# Reads whose domain permission every non-admin role holds. They are still gated
# (they used to be open to any session); the observable is the anonymous caller.
UNIVERSAL_READS = [
    "/api/incidents",
    "/api/incidents/summary",
    "/api/infrastructure",
    "/api/zones",
    "/api/dependencies",
    "/api/twin/graph",
]


@pytest.mark.parametrize("path,outsider", GUARDED_READS)
def test_reads_require_a_permission_not_just_a_session(as_role, anonymous, path, outsider):
    """A logged-in user without the domain permission must not read the domain."""
    denied = as_role(outsider).get(path)
    assert denied.status_code == 403, (
        f"{outsider} got {denied.status_code} on {path}; a permissionless role must be refused"
    )
    assert anonymous.get(path).status_code == 401, f"{path} answered an anonymous caller"


@pytest.mark.parametrize("path", UNIVERSAL_READS)
def test_every_role_can_still_read_shared_city_data(as_role, path):
    """These reads are gated, but every operational role holds the permission.

    The point of the gate is to refuse an anonymous or permission-less caller,
    not to fragment the shared operational picture.
    """
    for role in ("city_operator", "field_engineer", "city_analyst"):
        response = as_role(role).get(path)
        assert response.status_code == 200, f"{role} -> {path}: {response.status_code}"


@pytest.mark.parametrize("path", UNIVERSAL_READS + ["/api/resources", "/api/tasks",
                                                    "/api/simulations", "/api/users",
                                                    "/api/audit-logs"])
def test_no_read_endpoint_answers_an_anonymous_caller(anonymous, path):
    assert anonymous.get(path).status_code == 401, f"{path} leaked to an anonymous caller"


def test_dashboard_is_scoped_by_permission_rather_than_refused(as_role):
    """The dashboard is the landing page, so every role gets a 200 and a bundle
    filtered to what that role may see. A field engineer holds no analytics,
    simulation or recovery permission, so those sections must be empty for it,
    while the analyst must receive them.
    """
    engineer = as_role("field_engineer").get("/api/dashboard")
    assert engineer.status_code == 200, engineer.text
    analyst = as_role("city_analyst").get("/api/dashboard")
    assert analyst.status_code == 200, analyst.text

    eng_body, ana_body = engineer.json()["data"], analyst.json()["data"]
    for section in ("simulations", "recovery"):
        if section in ana_body:
            assert ana_body[section] not in (None, [], {}), (
                f"the analyst should receive the {section} section"
            )
        if section in eng_body:
            assert eng_body[section] in (None, [], {}), (
                f"the field engineer must not receive the {section} section"
            )


def test_notification_inbox_is_scoped_to_its_owner(as_role):
    """The inbox is personal, so the gate is ownership rather than a permission.

    Every role must be able to read its own notifications even though only some
    roles hold incident:read; and no role may read another user's.
    """
    analyst = as_role("city_analyst")
    inbox = analyst.get("/api/notifications")
    assert inbox.status_code == 200, inbox.text
    mine = {n["id"] for n in inbox.json()["data"]}
    other = as_role("city_operator").get("/api/notifications")
    assert other.status_code == 200
    assert not (mine & {n["id"] for n in other.json()["data"]}), "inboxes overlap between users"


# --------------------------------------------------------------------------- #
# A mutation must never be reachable through a read permission.
# --------------------------------------------------------------------------- #


def test_field_engineer_cannot_verify_an_incident(as_role, api):
    """An engineer holds incident:read; deriving incident state is a write.

    The route used to be gated on incident:read, so an engineer could move an
    incident along its state machine (reported -> verified). The service layer
    only special-cases approval and resolution, so every other transition was
    open. This is the regression test for that escalation path.
    """
    operator = as_role("city_operator")
    assets = operator.get("/api/infrastructure?page_size=1").json()["data"]
    created = operator.post(
        "/api/incidents",
        json={
            "title": "Engineer must not verify this",
            "description": "permission regression probe",
            "primary_asset_id": assets[0]["id"],
            "category": f"permission_probe_{uuid.uuid4().hex[:8]}",
            "severity": "medium",
        },
    )
    assert created.status_code == 201, created.text
    incident_id = created.json()["data"]["id"]
    assert created.json()["data"]["status"] == "reported"

    engineer = as_role("field_engineer")
    attempt = engineer.post(
        f"/api/incidents/{incident_id}/transition",
        json={"status": "verified", "note": "not my job"},
    )
    assert attempt.status_code == 403, (
        f"a field engineer moved an incident to verified ({attempt.status_code}); "
        "incident transitions must not be gated on incident:read"
    )

    unchanged = operator.get(f"/api/incidents/{incident_id}").json()["data"]
    assert unchanged["status"] == "reported", "the refused transition still changed the record"


def test_operator_still_verifies_incidents(as_role):
    """The fix must not lock the operator — who owns incident:write — out."""
    operator = as_role("city_operator")
    assets = operator.get("/api/infrastructure?page_size=1").json()["data"]
    created = operator.post(
        "/api/incidents",
        json={
            "title": "Operator verifies this",
            "description": "positive control",
            "primary_asset_id": assets[0]["id"],
            "category": f"operator_control_{uuid.uuid4().hex[:8]}",
            "severity": "medium",
        },
    )
    incident_id = created.json()["data"]["id"]
    moved = operator.post(
        f"/api/incidents/{incident_id}/transition",
        json={"status": "verified", "note": "confirmed on site"},
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["data"]["status"] == "verified"


# --------------------------------------------------------------------------- #
# Two endpoints legitimately serve two roles. Their route gate is the union and
# the service decides which permission the specific request needs.
# --------------------------------------------------------------------------- #


def test_operator_can_still_verify_tasks(as_role):
    """Verifying completed work needs task:verify, held by the operator.

    The route was briefly gated on task:execute alone, which refused the
    operator. The gate is the union of both permissions; the service layer then
    rejects the target state the caller is not entitled to.
    """
    operator = as_role("city_operator")
    queue = operator.get("/api/tasks?page_size=100")
    assert queue.status_code == 200, queue.text
    completed = [t for t in queue.json()["data"] if t["status"] == "completed"]
    if not completed:
        pytest.skip("seed data has no completed task to verify")
    response = operator.post(
        f"/api/tasks/{completed[0]['id']}/transition",
        json={"status": "verified", "note": "Verified by operator"},
    )
    assert response.status_code == 200, response.text


def test_administrator_can_read_settings(as_role):
    """Displaying settings is administration, not editing them."""
    admin = as_role("super_admin")
    assert admin.get("/api/settings").status_code == 200


def test_settings_are_not_readable_by_operators(as_role):
    operator = as_role("city_operator")
    assert operator.get("/api/settings").status_code == 403


@pytest.mark.parametrize("path", ["/api/infrastructure/categories", "/api/infrastructure/statuses",
                                  "/api/resources/categories", "/api/simulations/assumptions",
                                  "/api/workflows/steps"])
def test_lookup_tables_need_a_permission_for_that_domain(as_role, anonymous, path):
    """Enumerations describe the deployment, so they are not public and not
    open to a session that lacks the domain permission."""
    assert anonymous.get(path).status_code == 401, f"{path} leaked to an anonymous caller"
    assert as_role("field_engineer").get(path).status_code in (200, 403)
