"""Authentication, session and CSRF behaviour."""
from __future__ import annotations


def test_health_endpoint_is_public(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["data"]["status"] == "ok"


def test_login_with_valid_credentials_issues_session_cookies(client):
    response = client.post(
        "/api/auth/login",
        json={"email": "operator@symbiotic.city", "password": "Operator#2026"},
    )
    assert response.status_code == 200
    body = response.json()["data"]
    assert body["user"]["email"] == "operator@symbiotic.city"
    assert "incident:write" in body["permissions"]
    assert response.cookies.get("symbiotic_session")
    assert response.cookies.get("symbiotic_csrf")


def test_login_with_wrong_password_is_rejected(anonymous):
    response = anonymous.post(
        "/api/auth/login", json={"email": "operator@symbiotic.city", "password": "nope"}
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_credentials"


def test_login_with_unknown_email_is_indistinguishable(anonymous):
    response = anonymous.post(
        "/api/auth/login", json={"email": "ghost@symbiotic.city", "password": "whatever1"}
    )
    assert response.status_code == 401
    assert "incorrect" in response.json()["error"]["message"]


def test_inactive_account_cannot_sign_in(client, as_role, api):
    admin = as_role("super_admin")
    users = admin.get("/api/users?search=engineer2").json()["data"]
    engineer = users[0]
    assert admin.patch(f"/api/users/{engineer['id']}", json={"is_active": False}).status_code == 200
    response = client.post(
        "/api/auth/login",
        json={"email": "engineer2@symbiotic.city", "password": "Engineer#2026"},
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "account_inactive"
    admin.patch(f"/api/users/{engineer['id']}", json={"is_active": True})


def test_me_requires_a_session(anonymous):
    assert anonymous.get("/api/auth/me").status_code == 401


def test_me_returns_permissions(as_role):
    operator = as_role("city_operator")
    response = operator.get("/api/auth/me")
    assert response.status_code == 200
    payload = response.json()["data"]
    assert "city_operator" in payload["roles"]
    assert "incident:resolve" in payload["permissions"]
    assert "user:manage" not in payload["permissions"]


def test_registration_creates_account_and_rejects_duplicates(client, unique_email):
    payload = {
        "full_name": "Test Operator",
        "email": unique_email,
        "password": "Secret#1234",
        "role": "city_operator",
    }
    first = client.post("/api/auth/register", json=payload)
    assert first.status_code == 201
    assert first.json()["data"]["user"]["email"] == unique_email
    second = client.post("/api/auth/register", json=payload)
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "duplicate_email"


def test_registration_validates_password_strength(client, unique_email):
    response = client.post(
        "/api/auth/register",
        json={
            "full_name": "Weak Password",
            "email": unique_email,
            "password": "short",
            "role": "city_operator",
        },
    )
    assert response.status_code == 422
    fields = [e["field"] for e in response.json()["error"]["details"]]
    assert "password" in fields


def test_registration_cannot_self_assign_super_admin(client, unique_email):
    response = client.post(
        "/api/auth/register",
        json={
            "full_name": "Sneaky Admin",
            "email": unique_email,
            "password": "Secret#1234",
            "role": "super_admin",
        },
    )
    assert response.status_code == 422


def test_logout_revokes_the_session(as_role):
    operator = as_role("city_operator")
    assert operator.get("/api/auth/me").status_code == 200
    assert operator.post("/api/auth/logout").status_code == 200
    # the revoked token must no longer authenticate
    response = operator.get("/api/auth/me")
    assert response.status_code == 401


def test_csrf_token_is_required_for_state_changing_requests(client, as_role):
    operator = as_role("city_operator")
    response = client.post(
        "/api/incidents",
        json={
            "title": "CSRF test incident",
            "description": "should be blocked",
            "primary_asset_id": 1,
            "category": "power_outage",
            "severity": "low",
        },
        cookies={"symbiotic_session": operator._session},
        headers={"X-CSRF-Token": "not-the-cookie"},
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"


def test_password_reset_flow_is_one_time(client):
    request = client.post(
        "/api/auth/forgot-password", json={"email": "analyst@symbiotic.city"}
    )
    assert request.status_code == 200
    token = request.json()["data"]["reset_token"]
    assert token, "non-production demo mode must surface the token"
    reset = client.post(
        "/api/auth/reset-password", json={"token": token, "password": "BrandNew#2026"}
    )
    assert reset.status_code == 200
    reuse = client.post(
        "/api/auth/reset-password", json={"token": token, "password": "Another#2026"}
    )
    assert reuse.status_code == 400
    assert reuse.json()["error"]["code"] == "invalid_reset_token"
    # restore the demo password for other tests
    login = client.post(
        "/api/auth/login", json={"email": "analyst@symbiotic.city", "password": "BrandNew#2026"}
    )
    assert login.status_code == 200
    csrf = login.cookies.get("symbiotic_csrf")
    client.post(
        "/api/auth/change-password",
        json={"current_password": "BrandNew#2026", "new_password": "Analyst#2026"},
        cookies=login.cookies,
        headers={"X-CSRF-Token": csrf},
    )


def test_forgot_password_does_not_leak_account_existence(client):
    unknown = client.post("/api/auth/forgot-password", json={"email": "nobody@nowhere-mail.com"})
    known = client.post("/api/auth/forgot-password", json={"email": "admin@symbiotic.city"})
    assert unknown.status_code == known.status_code == 200
    assert unknown.json()["data"]["message"] == known.json()["data"]["message"]


def test_profile_update_and_password_change(as_role):
    analyst = as_role("city_operator")
    updated = analyst.patch("/api/auth/profile", json={"job_title": "Deputy Watch Commander"})
    assert updated.status_code == 200
    assert updated.json()["data"]["user"]["job_title"] == "Deputy Watch Commander"
    wrong = analyst.post(
        "/api/auth/change-password",
        json={"current_password": "wrong-password", "new_password": "Something#123"},
    )
    assert wrong.status_code == 422
    assert wrong.json()["error"]["code"] == "invalid_password"
