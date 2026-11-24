"""The critical end-to-end demonstration plus workflow failure/retry recovery."""
from __future__ import annotations

import uuid

import pytest

from tests.conftest import Api, CREDENTIALS, unique_category


def _asset(api: Api, code: str) -> dict:
    return api.get(f"/api/infrastructure?search={code}").json()["data"][0]


def _start_failure(client, operator: Api, asset: dict, *, create_incident: bool = True) -> dict:
    response = operator.post(
        "/api/simulations/run",
        json={
            "name": "Major power infrastructure failure",
            "initial_failure_ids": [asset["id"]],
            "cascade_threshold": 0.35,
            "max_depth": 6,
            "random_seed": 42,
            "create_incident": create_incident,
            "incident_title": "Major power infrastructure failure at Vale Central",
            "incident_severity": "critical",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["data"]


def _demands_from_run(analyst: Api, run_id: int) -> list[dict]:
    rows = analyst.get(f"/api/simulations/{run_id}/demands").json()["data"]
    return [
        {
            "asset_id": row["asset_id"],
            "need": row["need"],
            "priority": row["priority"],
            "eligible_categories": ["generator"],
            "service_window_minutes": 240,
            "estimated_hours": 2.0,
        }
        for row in rows
    ]


def test_full_recovery_demonstration(client, as_role):
    """Steps 1-19 of the required demonstration, through the real API."""
    operator = as_role("city_operator")
    analyst = as_role("city_analyst")
    engineer_one = as_role("field_engineer")
    engineer_two = as_role("field_engineer_2")
    admin = as_role("super_admin")

    # 1-4: operator selects a power facility and injects a controlled failure
    power_station = _asset(operator, "PS-01")
    assert power_station["category"] == "power_station"
    run = _start_failure(client, operator, power_station)

    # 5-6: the engine identifies downstream impact and the twin exposes it
    summary = run["summary"]
    assert summary["assets_failed"] > 1, "a power station failure must cascade"
    assert summary["max_depth_reached"] >= 1
    downstream = {i["code"] for i in run["impacts"] if i["depth"] > 0}
    assert downstream & {"SS-01", "HO-01", "WT-01"}
    assert run["assumptions"], "simulation assumptions must be recorded"
    assert run["snapshot_hash"]

    # 7-8: analyst opens results and submits constrained demand
    incident_id = run["incident_id"]
    assert incident_id
    details = analyst.get(f"/api/simulations/{run['id']}").json()["data"]
    assert len(details["impacts"]) == len(run["impacts"])

    # 9: OR-Tools produces a plan (via the workflow, which also relaxes if needed)
    workflow = operator.post(f"/api/workflows/start?incident_id={incident_id}")
    assert workflow.status_code == 201, workflow.text
    wf = workflow.json()["data"]
    assert wf["status"] == "awaiting_approval"
    assert "recovery_plan_generated" in wf["completed_steps"]
    plan_id = wf["plan_id"]
    plan = operator.get(f"/api/optimization/plans/{plan_id}").json()["data"]
    assert plan["solution_status"] in ("optimal", "feasible")
    assert plan["assignments"], "a feasible plan must contain assignments"
    assert plan["explanation"]["steps"]

    # 10-12: operator approves, resources are reserved transactionally
    approval = operator.post(
        f"/api/optimization/plans/{plan_id}/approve",
        json={"approve": True, "note": "Approved for dispatch"},
    )
    assert approval.status_code == 200, approval.text
    wf = operator.get(f"/api/workflows/{wf['id']}").json()["data"]
    assert wf["status"] == "awaiting_field"
    assert {"plan_approved", "resources_reserved", "repair_tasks_assigned"} <= set(
        wf["completed_steps"]
    )
    reservations = operator.get("/api/resources/reservations?status=reserved").json()["data"]
    assert reservations, "approval must reserve resource capacity"

    # 13-15: engineers accept, progress and complete; operator verifies
    completed = 0
    for engineer in (engineer_one, engineer_two):
        queue = engineer.get("/api/tasks/my-queue").json()["data"]
        for task in [t for t in queue["tasks"] if t["status"] == "assigned"]:
            for step in ("accepted", "in_progress", "completed"):
                response = engineer.post(
                    f"/api/tasks/{task['id']}/transition",
                    json={"status": step, "note": f"{step} by field engineer", "actual_hours": 1.5},
                )
                assert response.status_code == 200, response.text
            completed += 1
    assert completed > 0

    for engineer in (engineer_one, engineer_two):
        for task in engineer.get("/api/tasks/my-queue").json()["data"]["tasks"]:
            if task["status"] == "completed":
                verified = operator.post(
                    f"/api/tasks/{task['id']}/transition",
                    json={"status": "verified", "note": "Verified on site"},
                )
                assert verified.status_code == 200, verified.text

    # 16-17: infrastructure status returns to operational and the incident closes.
    # Verifying the last task lets the workflow resolve the incident itself; the
    # manual transition is only needed when no workflow is driving it.
    incident = operator.get(f"/api/incidents/{incident_id}").json()["data"]
    if incident["status"] != "resolved":
        resolved = operator.post(
            f"/api/incidents/{incident_id}/transition",
            json={
                "status": "resolved",
                "note": "All repairs verified",
                "resolution_notes": "Feeder restored and load confirmed normal.",
            },
        )
        assert resolved.status_code == 200, resolved.text
        incident = resolved.json()["data"]
    assert incident["status"] == "resolved"

    # and resolving twice is refused rather than silently duplicated
    replayed = operator.post(
        f"/api/incidents/{incident_id}/transition", json={"status": "resolved"}
    )
    assert replayed.status_code == 409
    assert replayed.json()["error"]["code"] == "no_status_change"
    asset_after = operator.get(f"/api/infrastructure/{power_station['id']}").json()["data"]
    assert asset_after["status"] in ("operational", "degraded")

    wf = operator.get(f"/api/workflows/{wf['id']}").json()["data"]
    assert wf["status"] == "completed"
    assert "incident_resolved" in wf["completed_steps"]

    # 18: analytics refresh from stored data
    overview = analyst.get("/api/analytics/overview").json()["data"]
    assert overview["simulations_total"] >= 1
    assert overview["incidents_resolved"] >= 1

    # 19: audit trail records the significant operations
    logs = admin.get("/api/audit-logs?page_size=100").json()["data"]
    actions = {entry["action"] for entry in logs}
    assert {
        "auth.login",
        "simulation.run",
        "workflow.start",
        "optimization.plan_approved",
        "task.transition",
        "incident.transition",
    } <= actions


def test_verifying_the_last_task_closes_the_workflow_without_a_manual_resolve(client, as_role):
    """The field workspace must be able to finish the loop on its own.

    Regression: the join from task verification back into orchestration only
    looked for a workflow in status "running", but dispatch leaves it parked at
    "awaiting_field", so verifying every task silently failed to advance the
    workflow and the incident stayed in_progress forever.
    """
    operator = as_role("city_operator")
    engineers = (as_role("field_engineer"), as_role("field_engineer_2"))
    asset = _asset(operator, "SS-01")
    incident = operator.post(
        "/api/incidents",
        json={
            "title": f"Field closeout {uuid.uuid4().hex[:6]}",
            "description": "Verification-driven resolution fixture.",
            "primary_asset_id": asset["id"],
            "category": unique_category(),
            "severity": "high",
        },
    ).json()["data"]

    started = operator.post(f"/api/workflows/start?incident_id={incident['id']}")
    assert started.status_code == 201, started.text
    wf = started.json()["data"]
    approval = operator.post(
        f"/api/optimization/plans/{wf['plan_id']}/approve",
        json={"approve": True, "note": "Dispatch it"},
    )
    assert approval.status_code == 200, approval.text
    wf = operator.get(f"/api/workflows/{wf['id']}").json()["data"]
    assert wf["status"] == "awaiting_field"

    tasks = operator.get(f"/api/tasks?incident_id={incident['id']}&page_size=50").json()["data"]
    assert tasks, "approval must dispatch tasks"
    for task in tasks:
        owner = next(e for e in engineers if e.get("/api/auth/me").json()["data"]["user"]["id"] == task["assignee_id"])
        for step in ("accepted", "in_progress", "completed"):
            response = owner.post(
                f"/api/tasks/{task['id']}/transition",
                json={"status": step, "note": step, "actual_hours": 1.0},
            )
            assert response.status_code == 200, (task["code"], step, response.text)

    verified = 0
    for task in operator.get(f"/api/tasks?incident_id={incident['id']}&page_size=50").json()["data"]:
        if task["status"] == "completed":
            response = operator.post(
                f"/api/tasks/{task['id']}/transition", json={"status": "verified", "note": "ok"}
            )
            assert response.status_code == 200, response.text
            verified += 1
    assert verified == len(tasks)

    wf = operator.get(f"/api/workflows/{wf['id']}").json()["data"]
    assert wf["status"] == "completed", wf
    assert wf["current_step"] == "incident_resolved"
    assert {"engineer_accepted", "repair_verified", "incident_resolved"} <= set(wf["completed_steps"])
    closed = operator.get(f"/api/incidents/{incident['id']}").json()["data"]
    assert closed["status"] == "resolved"


def test_workflow_survives_an_injected_failure_and_recovers(client, as_role):
    """A07: failure after earlier steps succeeded, compensation, then retry."""
    operator = as_role("city_operator")
    asset = _asset(operator, "SS-02")
    incident = operator.post(
        "/api/incidents",
        json={
            "title": f"Injected failure scenario {uuid.uuid4().hex[:6]}",
            "description": "Workflow fault-injection fixture for the A07 demonstration.",
            "primary_asset_id": asset["id"],
            "category": unique_category(),
            "severity": "high",
        },
    ).json()["data"]

    failed = operator.post(
        f"/api/workflows/start?incident_id={incident['id']}&fail_at_step=recovery_plan_generated"
    )
    assert failed.status_code == 409
    body = failed.json()["error"]
    assert body["code"] == "injected_failure" or "Injected failure" in body["message"]

    # the workflow must exist in a failed state with earlier steps preserved
    workflows = [
        w
        for w in operator.get("/api/workflows?status=failed&page_size=50").json()["data"]
        if w["incident_id"] == incident["id"]
    ]
    assert workflows, "the failed workflow must be persisted"
    wf = workflows[0]
    assert wf["failure_step"] == "recovery_plan_generated"
    assert "incident_created" in wf["completed_steps"]
    assert "incident_validated" in wf["completed_steps"]
    assert "simulation_performed" in wf["completed_steps"]

    # retry resumes from where it stopped and preserves completion
    retried = operator.post(f"/api/workflows/{wf['id']}/retry")
    assert retried.status_code == 200, retried.text
    after = retried.json()["data"]
    assert after["status"] in ("awaiting_approval", "awaiting_field")
    assert after["retry_count"] >= 1
    assert after["failure_step"] is None
    assert "recovery_plan_generated" in after["completed_steps"]
    # no duplicate events for a step/attempt pair
    event_keys = [(e["step"], e["attempt"]) for e in after["events"]]
    assert len(event_keys) == len(set(event_keys))


def test_failure_during_reservation_rolls_back_and_releases_capacity(client, as_role):
    """Reservation fails after approval: no capacity is left committed."""
    operator = as_role("city_operator")
    asset = _asset(operator, "WT-01")
    incident = operator.post(
        "/api/incidents",
        json={
            "title": f"Reservation failure scenario {uuid.uuid4().hex[:6]}",
            "description": "Fails at the reservation step so rollback can be checked.",
            "primary_asset_id": asset["id"],
            "category": unique_category(),
            "severity": "critical",
        },
    ).json()["data"]
    before = operator.get("/api/resources/utilisation").json()["data"]
    wf = operator.post(f"/api/workflows/start?incident_id={incident['id']}").json()["data"]
    assert wf["status"] == "awaiting_approval"
    fault = operator.post(
        f"/api/workflows/{wf['id']}/simulate-failure?step=resources_reserved"
    )
    assert fault.status_code == 200

    approval = operator.post(
        f"/api/optimization/plans/{wf['plan_id']}/approve",
        json={"approve": True, "note": "Approved, then the reservation step fails"},
    )
    assert approval.status_code == 200, approval.text
    after_plan = operator.get(f"/api/optimization/plans/{wf['plan_id']}").json()["data"]
    assert after_plan["status"] == "approved", "the approval itself must be preserved"

    failed = operator.get(f"/api/workflows/{wf['id']}").json()["data"]
    assert failed["status"] == "failed"
    assert failed["failure_step"] == "resources_reserved"
    assert "plan_approved" in failed["completed_steps"]
    compensation = [e for e in failed["events"] if e["step"] == "compensation"]
    assert compensation, "a failed workflow must record its compensating action"
    assert not any(
        t for t in operator.get("/api/tasks").json()["data"]
        if t["incident_id"] == incident["id"] and t["status"] not in ("cancelled", "verified")
    ), "a failed reservation must not leave live tasks behind"

    after = operator.get("/api/resources/utilisation").json()["data"]
    committed_before = sum(row["reserved"] for row in before)
    committed_after = sum(row["reserved"] for row in after)
    assert committed_after <= committed_before + 1e-6, "a failed run must not hold capacity"

    # retry is safe: no duplicate reservations, tasks dispatched once
    retried = operator.post(f"/api/workflows/{wf['id']}/retry")
    assert retried.status_code == 200, retried.text
    resumed = retried.json()["data"]
    assert resumed["status"] in ("awaiting_field", "completed")
    assert "resources_reserved" in resumed["completed_steps"]
    assert "repair_tasks_assigned" in resumed["completed_steps"]
    reservations = operator.get("/api/resources/reservations").json()["data"]
    live = [r for r in reservations if r["status"] == "reserved"]
    keys = [(r["resource_id"], r["plan_id"]) for r in live]
    assert len(keys) == len(set(keys)), "retry must not double book a resource"


def test_cannot_start_two_active_workflows_for_one_incident(client, as_role):
    operator = as_role("city_operator")
    asset = _asset(operator, "WP-03")
    incident = operator.post(
        "/api/incidents",
        json={
            "title": f"Duplicate workflow guard {uuid.uuid4().hex[:6]}",
            "description": "Second workflow must be rejected.",
            "primary_asset_id": asset["id"],
            "category": unique_category(),
            "severity": "medium",
        },
    ).json()["data"]
    first = operator.post(f"/api/workflows/start?incident_id={incident['id']}")
    assert first.status_code == 201
    second = operator.post(f"/api/workflows/start?incident_id={incident['id']}")
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "workflow_exists"


def test_infeasible_optimisation_is_reported_and_not_approvable(client, as_role):
    operator = as_role("city_operator")
    analyst = as_role("city_analyst")
    asset = _asset(operator, "HO-03")
    demand = [
        {
            "asset_id": asset["id"],
            "need": 60,
            "priority": 1,
            "eligible_categories": ["generator"],
            "service_window_minutes": 120,
            "estimated_hours": 1.0,
        }
    ]
    response = analyst.post(
        "/api/optimization/requests",
        json={
            "title": "Deliberately infeasible allocation",
            "demands": demand,
            "horizon_hours": 1,
            "must_serve_priority": 1,
            "force_infeasible_demo": True,
        },
    )
    assert response.status_code == 201, response.text
    plan = response.json()["data"]["plan"]
    assert plan["solution_status"] == "infeasible"
    assert plan["assignments"] == []
    assert plan["infeasibility_reason"]
    approve = operator.post(
        f"/api/optimization/plans/{plan['id']}/approve", json={"approve": True, "note": "try"}
    )
    assert approve.status_code == 409
    assert approve.json()["error"]["code"] == "infeasible_plan"


def test_scarce_generator_allocation_prefers_the_hospital(client, as_role):
    operator = as_role("city_operator")
    analyst = as_role("city_analyst")
    hospital = _asset(operator, "HO-01")
    pump = _asset(operator, "WP-02")
    mall = _asset(operator, "CM-01")
    response = analyst.post(
        "/api/optimization/requests",
        json={
            "title": "A02 scarcity demonstration",
            "demands": [
                {"asset_id": hospital["id"], "need": 55, "priority": 1, "eligible_categories": ["generator"], "service_window_minutes": 240, "estimated_hours": 3.0},
                {"asset_id": pump["id"], "need": 40, "priority": 2, "eligible_categories": ["generator"], "service_window_minutes": 240, "estimated_hours": 2.5},
                {"asset_id": mall["id"], "need": 30, "priority": 5, "eligible_categories": ["generator"], "service_window_minutes": 480, "estimated_hours": 1.5},
            ],
            "horizon_hours": 12,
            "must_serve_priority": None,
        },
    )
    assert response.status_code == 201, response.text
    plan = response.json()["data"]["plan"]
    served = {row["asset_code"] for row in plan["assignments"]}
    assert "HO-01" in served, "the hospital must win the scarce generator"
    assert plan["coverage_percent"] <= 100
    assert plan["explanation"]["unserved"] or len(served) == 3


# --------------------------------------------------------------------------- #
# Retry is a recovery action, not a no-op that rewrites a healthy workflow.
# --------------------------------------------------------------------------- #


def test_retry_is_refused_for_a_workflow_that_did_not_fail(as_role):
    """A workflow waiting for approval must not be flipped to "running".

    retry_workflow used to accept any status in (failed, running, awaiting_field,
    awaiting_approval). Called on a healthy workflow it returned 200, set
    status="running" and incremented retry_count, leaving a workflow that no
    actor would ever advance because the operator was about to approve it. The
    console only offers Retry when status is "failed", so nothing depended on the
    permissive behaviour.
    """
    operator = as_role("city_operator")
    assets = operator.get("/api/infrastructure?page_size=100").json()["data"]
    substation = next(a for a in assets if a["category"] == "substation")
    incident = operator.post(
        "/api/incidents",
        json={
            "title": "Retry must not touch a healthy workflow",
            "description": "regression probe",
            "primary_asset_id": substation["id"],
            "category": f"retry_guard_{uuid.uuid4().hex[:8]}",
            "severity": "high",
        },
    ).json()["data"]
    started = operator.post(f"/api/workflows/start?incident_id={incident['id']}")
    assert started.status_code == 201, started.text
    workflow = started.json()["data"]
    assert workflow["status"] != "failed"

    attempt = operator.post(f"/api/workflows/{workflow['id']}/retry")
    assert attempt.status_code == 409, (
        f"retrying a {workflow['status']} workflow returned {attempt.status_code}"
    )
    assert attempt.json()["error"]["code"] == "invalid_state"

    unchanged = operator.get(f"/api/workflows/{workflow['id']}").json()["data"]
    assert unchanged["status"] == workflow["status"], "the refused retry still changed the status"
    assert unchanged["retry_count"] == workflow["retry_count"], "the refused retry was counted"


def test_retry_still_resumes_a_genuinely_failed_workflow(as_role):
    """The legitimate path must keep working: fail at a step, then retry."""
    operator = as_role("city_operator")
    assets = operator.get("/api/infrastructure?page_size=100").json()["data"]
    substation = next(a for a in assets if a["category"] == "substation")
    incident = operator.post(
        "/api/incidents",
        json={
            "title": "Retry must resume a failed workflow",
            "description": "positive control",
            "primary_asset_id": substation["id"],
            "category": f"retry_resume_{uuid.uuid4().hex[:8]}",
            "severity": "high",
        },
    ).json()["data"]
    operator.post(
        f"/api/workflows/start?incident_id={incident['id']}&fail_at_step=recovery_plan_generated"
    )
    failed = operator.get(f"/api/workflows?incident_id={incident['id']}").json()["data"][0]
    assert failed["status"] == "failed"
    before = set(failed["completed_steps"])

    retried = operator.post(f"/api/workflows/{failed['id']}/retry")
    assert retried.status_code == 200, retried.text
    after = retried.json()["data"]
    assert after["status"] != "failed", "the retry did not move the workflow past its failure"
    assert after["retry_count"] == failed["retry_count"] + 1
    assert before.issubset(set(after["completed_steps"])), "the retry lost completed work"
