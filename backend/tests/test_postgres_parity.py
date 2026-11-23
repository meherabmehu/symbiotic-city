"""The application on real PostgreSQL.

The default suite runs on SQLite, which hides a class of defect PostgreSQL
catches: deferred constraint checks, row-level locking, and DDL ordering. The
initial migration bug (``relation "users" does not exist``) survived every SQLite
run for exactly that reason.

Point ``POSTGRES_TEST_URL`` at a throwaway database to run this module; without
it the tests skip, so the normal suite stays green on a machine without Postgres.

    POSTGRES_TEST_URL=postgresql+psycopg2://postgres@/symbiotic_test \\
        python -m pytest tests/test_postgres_parity.py
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

POSTGRES_URL = os.environ.get("POSTGRES_TEST_URL")

pytestmark = pytest.mark.skipif(
    not POSTGRES_URL, reason="set POSTGRES_TEST_URL to run the PostgreSQL parity suite"
)


def _alembic_upgrade(url: str) -> None:
    backend = Path(__file__).resolve().parents[1]
    env = dict(os.environ, DATABASE_URL=url, PYTHONPATH=str(backend))
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=backend, env=env, capture_output=True, text=True, timeout=180,
    )
    assert result.returncode == 0, f"alembic upgrade failed on PostgreSQL:\n{result.stderr}"


@pytest.fixture(scope="module")
def pg_app():
    """An app backed by PostgreSQL, with the schema built by Alembic.

    Running the migration rather than ``metadata.create_all`` means these tests
    exercise the same DDL path production deployment uses.
    """
    _alembic_upgrade(POSTGRES_URL)

    # conftest.py pins DATABASE_URL to SQLite at import time, and app.core
    # .database builds its engine from that setting the moment it is imported —
    # which test_migrations.py may already have done. Rebind the engine rather
    # than only changing the setting, otherwise the app keeps seeding SQLite
    # while these assertions read PostgreSQL.
    os.environ["DATABASE_URL"] = POSTGRES_URL
    os.environ["SEED_DEMO_DATA"] = "1"

    from app.core import database
    from app.core.config import settings

    settings.database_url = POSTGRES_URL
    settings.seed_demo_data = True
    if database.engine.url.database != _database_name(POSTGRES_URL):
        database.engine.dispose()
        database.engine = database._build_engine()
        database.SessionLocal.configure(bind=database.engine)
    engine = database.engine

    import sys

    main_module = sys.modules.get("app.main")
    if main_module is not None:
        main_module.engine = engine
    from app.main import create_app as _create_app

    # create_app closes over app.main's module-level engine.
    main_module = sys.modules["app.main"]
    main_module.engine = engine

    application = _create_app()
    from fastapi.testclient import TestClient

    with TestClient(application) as client:
        yield client


def _database_name(url: str) -> str | None:
    from sqlalchemy.engine import make_url

    return make_url(url).database


def _actor(client, email: str, password: str) -> dict[str, str]:
    client.cookies.clear()
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    csrf = response.cookies.get("symbiotic_csrf") or ""
    session = response.cookies.get("symbiotic_session") or ""
    return {
        "X-CSRF-Token": csrf,
        "Cookie": f"symbiotic_session={session}; symbiotic_csrf={csrf}",
    }


def test_health_reports_a_live_database(pg_app):
    response = pg_app.get("/api/health")
    assert response.status_code == 200
    assert response.json()["success"] is True


def test_schema_built_by_migration_matches_the_models(pg_app):
    """Zero drift between the migrated schema and the declarative metadata."""
    from sqlalchemy import create_engine, inspect

    import app.models  # noqa: F401
    from app.core.database import Base

    inspector = inspect(create_engine(POSTGRES_URL))
    for name, table in Base.metadata.tables.items():
        assert inspector.has_table(name), f"{name} missing from the migrated schema"
        actual = {column["name"] for column in inspector.get_columns(name)}
        assert actual == {column.name for column in table.columns}, f"column drift in {name}"


def test_foreign_keys_are_enforced_by_the_database(pg_app):
    """The database must reject an orphan row, not just the application."""
    from sqlalchemy import create_engine, text
    from sqlalchemy.exc import IntegrityError

    engine = create_engine(POSTGRES_URL)
    with pytest.raises(IntegrityError):
        with engine.begin() as connection:
            connection.execute(
                text(
                    "insert into incidents (code, title, description, category, severity,"
                    " status, primary_asset_id, affected_population, reported_at,"
                    " created_at, updated_at) values"
                    " ('INC-ORPHAN', 'orphan', 'd', 'c', 'high', 'reported', 999999, 0,"
                    " now(), now(), now())"
                )
            )


def test_seeded_demo_data_is_present(pg_app):
    """The demo dataset must exist after startup, whatever ran before this test."""
    from app.core.database import session_scope
    from app.seed.demo import seed_all
    from sqlalchemy import create_engine, text

    with session_scope() as session:
        seed_all(session)

    engine = create_engine(POSTGRES_URL)
    with engine.begin() as connection:
        users = connection.execute(text("select count(*) from users")).scalar_one()
        assets = connection.execute(
            text("select count(*) from infrastructure_assets")
        ).scalar_one()
    assert users >= 5
    assert assets >= 23


def test_simulation_runs_on_postgres(pg_app):
    analyst = _actor(pg_app, "analyst@symbiotic.city", "Analyst#2026")
    scenario = pg_app.post(
        "/api/scenarios",
        json={
            "name": "PostgreSQL parity scenario",
            "description": "cascade from the central power station",
            "failure_mode": "total_failure",
            "initial_failure_ids": [1],
            "cascade_threshold": 0.35,
            "max_depth": 3,
            "random_seed": 42,
            "save_as_template": False,
        },
        headers=analyst,
    )
    assert scenario.status_code == 201, scenario.text

    run = pg_app.post(
        "/api/simulations/run",
        json={"scenario_id": scenario.json()["data"]["id"], "asset_id": 1, "seed": 42},
        headers=analyst,
    )
    assert run.status_code == 201, run.text
    assert run.json()["data"]["summary"]["assets_failed"] >= 1


def test_optimisation_returns_a_plan_on_postgres(pg_app):
    analyst = _actor(pg_app, "analyst@symbiotic.city", "Analyst#2026")
    response = pg_app.post(
        "/api/optimization/requests",
        json={
            "title": "PostgreSQL parity plan",
            "horizon_hours": 12,
            "demands": [{"asset_id": 6, "need": 40, "priority": 2}],
        },
        headers=analyst,
    )
    assert response.status_code == 201, response.text
    payload = response.json()["data"]
    assert payload["plan"]["code"].startswith("PLAN-")
    assert payload["solver"]["status"] in {"optimal", "feasible", "infeasible"}


def test_workflow_advances_on_plan_approval(pg_app):
    operator = _actor(pg_app, "operator@symbiotic.city", "Operator#2026")
    incident = pg_app.post(
        "/api/incidents",
        json={
            "title": "PostgreSQL workflow check",
            "description": "full lifecycle on the migrated schema",
            "category": f"pg_parity_{os.urandom(4).hex()}",
            "severity": "high",
            "primary_asset_id": 7,
        },
        headers=operator,
    )
    assert incident.status_code == 201, incident.text

    workflow = pg_app.post(
        f"/api/workflows/start?incident_id={incident.json()['data']['id']}", headers=operator
    )
    assert workflow.status_code == 201, workflow.text
    payload = workflow.json()["data"]
    assert payload["current_step"] == "plan_approved"

    approved = pg_app.post(
        f"/api/optimization/plans/{payload['plan_id']}/approve",
        json={"approve": True},
        headers=operator,
    )
    assert approved.status_code == 200, approved.text

    after = pg_app.get(f"/api/workflows/{payload['id']}", headers=operator).json()["data"]
    assert after["current_step"] != "plan_approved"


def test_pagination_metadata_survives_postgres(pg_app):
    operator = _actor(pg_app, "operator@symbiotic.city", "Operator#2026")
    response = pg_app.get("/api/incidents?page=1&page_size=5", headers=operator)
    assert response.status_code == 200
    assert set(response.json()["meta"]) == {
        "total", "page", "page_size", "pages", "has_next", "has_prev"
    }
    assert len(response.json()["data"]) <= 5


def test_concurrent_reservations_do_not_overbook(pg_app):
    """The row lock in services.resources.reserve is only real on PostgreSQL.

    SQLite serialises writers anyway, so it can never exercise this. Two threads
    each ask for three quarters of one resource's capacity at the same instant:
    exactly one may win, and the live reservation rows must not exceed capacity.
    """
    from concurrent.futures import ThreadPoolExecutor

    import app.models  # noqa: F401
    from app.core.database import session_scope
    from app.core.responses import ApiError
    from app.models.operations import ReservationStatus, Resource, ResourceReservation
    from app.services.resources import reserve
    from sqlalchemy import func, select

    with session_scope() as session:
        capacity = float(session.get(Resource, 1).capacity)
        for row in session.scalars(
            select(ResourceReservation).where(
                ResourceReservation.resource_id == 1,
                ResourceReservation.status == ReservationStatus.RESERVED,
            )
        ):
            row.status = ReservationStatus.RELEASED
        session.commit()

    def attempt(_: int) -> bool:
        try:
            with session_scope() as session:
                reserve(
                    session,
                    session.get(Resource, 1),
                    quantity=capacity * 0.75,
                    repair_task_id=None,
                    plan_id=None,
                    actor_id=None,
                )
                session.commit()
            return True
        except ApiError:
            return False

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(attempt, range(2)))

    assert sorted(outcomes) == [False, True], outcomes
    with session_scope() as session:
        total = float(
            session.scalar(
                select(func.coalesce(func.sum(ResourceReservation.quantity), 0)).where(
                    ResourceReservation.resource_id == 1,
                    ResourceReservation.status == ReservationStatus.RESERVED,
                )
            )
        )
    assert capacity * 0.75 - 1e-9 <= total <= capacity + 1e-9
