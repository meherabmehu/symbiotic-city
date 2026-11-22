"""Shared fixtures: an isolated database and an authenticated API client factory."""
from __future__ import annotations

import os
import tempfile
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest

# Configure the environment *before* the app package is imported.
_TMP = Path(tempfile.mkdtemp(prefix="symbiotic-tests-"))
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP / 'test.db'}"
os.environ["SEED_DEMO_DATA"] = "1"
os.environ["ENVIRONMENT"] = "test"
os.environ["AUTH_RATE_LIMIT_PER_MINUTE"] = "10000"


@pytest.fixture(scope="session")
def app_module():
    from app.main import create_app

    return create_app()


@pytest.fixture(scope="session")
def client(app_module) -> Iterator["object"]:
    from fastapi.testclient import TestClient

    with TestClient(app_module) as test_client:
        yield test_client


class Api:
    """Small helper that behaves like a browser for one logged-in user."""

    def __init__(self, client, jar_owner: "Api | None" = None) -> None:
        self.client = client
        self.email: str | None = None
        self._csrf: str | None = None
        self._session: str | None = None
        # Sessions are carried explicitly in the Cookie header so that several
        # actors can be exercised against one TestClient without leaking state.
        client.cookies.clear()

    def login(self, email: str, password: str) -> "Api":
        # Each Api keeps its own cookie jar by storing cookies explicitly.
        response = self.client.post(
            "/api/auth/login", json={"email": email, "password": password}
        )
        assert response.status_code == 200, response.text
        self.email = email
        self._csrf = response.cookies.get("symbiotic_csrf")
        self._session = response.cookies.get("symbiotic_session")
        return self

    @property
    def headers(self) -> dict[str, str]:
        headers = {"X-CSRF-Token": self._csrf or "", "Cookie": ""}
        if self.email:
            headers["Cookie"] = (
                f"symbiotic_session={self._session}; symbiotic_csrf={self._csrf}"
            )
        return headers

    def get(self, url: str, **kwargs):
        return self.client.get(url, headers=self.headers, **kwargs)

    def post(self, url: str, **kwargs):
        return self.client.post(url, headers=self.headers, **kwargs)

    def patch(self, url: str, **kwargs):
        return self.client.patch(url, headers=self.headers, **kwargs)

    def delete(self, url: str, **kwargs):
        return self.client.delete(url, headers=self.headers, **kwargs)


CREDENTIALS = {
    "super_admin": ("admin@symbiotic.city", "Admin#2026"),
    "city_operator": ("operator@symbiotic.city", "Operator#2026"),
    "field_engineer": ("engineer@symbiotic.city", "Engineer#2026"),
    "field_engineer_2": ("engineer2@symbiotic.city", "Engineer#2026"),
    "city_analyst": ("analyst@symbiotic.city", "Analyst#2026"),
}


@pytest.fixture
def api(client) -> Api:
    return Api(client)


@pytest.fixture
def as_role(client):
    def _factory(role: str) -> Api:
        email, password = CREDENTIALS[role]
        return Api(client).login(email, password)

    return _factory


@pytest.fixture
def anonymous(client) -> Api:
    return Api(client)


@pytest.fixture
def unique_email() -> str:
    return f"user-{uuid.uuid4().hex[:8]}@example.com"


TEST_CATEGORY = "test_suite"


def unique_category() -> str:
    """A fresh incident category per scenario.

    Incident creation deliberately rejects a second *active* incident for the
    same asset + category (duplicate-action prevention). Tests therefore use a
    unique category when they need more than one live incident on one asset.
    """
    return f"{TEST_CATEGORY}_{uuid.uuid4().hex[:10]}"
