#!/usr/bin/env python3
"""End-to-end smoke test against a running SYMBIOTIC CITY stack.

Walks the real demo path over HTTP — no test client, no database access:

    health → twin → cascade simulation → demands → feasible preview →
    plan submit → incident → workflow start → approval → dispatch →
    field acceptance → verification → incident resolution → RBAC refusals

Usage:
    python3 scripts/smoke.py                      # http://127.0.0.1:8000/api
    python3 scripts/smoke.py http://host:3000/api # through the console proxy

Exit code is 0 only when every step behaves as documented. Requires a seeded
database and the demo accounts.

Re-runnable: each run drives its own plan through to completion, which turns its
reservations into `consumed` rather than `reserved`, so capacity is released as
the work is verified. Verified by four consecutive runs on one fresh database
(26/26 every time).

A run that is interrupted after approval -- or an approval whose tasks are never
completed -- leaves its reservations `reserved`, and those genuinely hold
capacity. A later plan can then be infeasible for a real reason. Reset with
`FORCE=1 ./scripts/seed.sh` (SQLite) or release the reservations through
`POST /api/resources/reservations/{id}/release` as an admin.

Line endings: written as UTF-8; the arrow glyphs are cosmetic.
"""
from __future__ import annotations

import http.cookiejar
import json
import sys
import uuid
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/api").rstrip("/")

PASS, FAIL = "\033[32mPASS\033[0m", "\033[31mFAIL\033[0m"
failures: list[str] = []


class Client:
    """Cookie-jar HTTP client that mirrors the console: /auth/me then CSRF header."""

    def __init__(self) -> None:
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def cookie(self, name: str) -> str:
        for cookie in self.jar:
            if cookie.name == name:
                return cookie.value
        return ""

    def call(self, method: str, path: str, body: dict | None = None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(BASE + path, data=data, method=method)
        request.add_header("Accept", "application/json, text/csv")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        token = self.cookie("symbiotic_csrf")
        if token:
            request.add_header("X-CSRF-Token", token)
        try:
            with self.opener.open(request, timeout=60) as response:
                return self._decode(response.status, response.read())
        except urllib.error.HTTPError as exc:
            return self._decode(exc.code, exc.read())

    @staticmethod
    def _decode(status: int, raw: bytes):
        """CSV exports are not JSON; return the text so callers can assert on it."""
        if not raw:
            return status, {}
        try:
            return status, json.loads(raw)
        except ValueError:
            return status, {"text": raw.decode("utf-8", "replace")}


def check(label: str, condition: bool, detail: object = "") -> bool:
    print(f"  {PASS if condition else FAIL}  {label}" + ("" if condition else f"  → {detail}"))
    if not condition:
        failures.append(label)
    return condition


def login(email: str, password: str) -> Client:
    client = Client()
    client.call("GET", "/auth/me")          # issues the CSRF cookie
    status, body = client.call("POST", "/auth/login", {"email": email, "password": password})
    if status != 200:
        raise SystemExit(f"login failed for {email}: {status} {body}")
    return client


def section(title: str) -> None:
    print(f"\n\033[1m{title}\033[0m")


def main() -> int:
    section("1 · health and catalogue")
    anon = Client()
    status, body = anon.call("GET", "/health")
    check("GET /health → 200 ok", status == 200, body)

    operator = login("operator@symbiotic.city", "Operator#2026")
    analyst = login("analyst@symbiotic.city", "Analyst#2026")
    engineer = login("engineer@symbiotic.city", "Engineer#2026")
    admin = login("admin@symbiotic.city", "Admin#2026")

    status, body = analyst.call("GET", "/twin/graph")
    graph = body.get("data") or {}
    nodes, edges = len(graph.get("assets") or graph.get("nodes") or []), len(graph.get("dependencies") or graph.get("edges") or [])
    check(f"twin graph loaded ({nodes} assets, {edges} dependencies)", status == 200 and nodes >= 20 and edges >= 20, body)

    status, body = analyst.call("GET", "/infrastructure?page_size=50")
    assets = body.get("data") or []
    check(f"asset registry lists {len(assets)} assets", status == 200 and len(assets) >= 20, body)

    section("2 · cascade simulation")
    status, body = analyst.call(
        "POST",
        "/simulations/run",
        {
            "failure_mode": "total_failure",
            "initial_failure_ids": [1],
            "cascade_threshold": 0.35,
            "max_depth": 6,
            "random_seed": 42,
        },
    )
    run = body.get("data") or {}
    run_id = run.get("id")
    summary = run.get("summary") or {}
    check(f"simulation run {run.get('code')} → 201", status == 201, body)
    failed = summary.get("assets_failed")
    check(
        f"cascade reported {failed} failed assets affecting {summary.get('affected_population')} people",
        bool(summary) and isinstance(failed, int) and failed > 1,
        summary,
    )

    status, body = analyst.call("GET", f"/simulations/{run_id}/demands")
    demands = body.get("data") or []
    if isinstance(demands, dict):
        demands = demands.get("demands") or []
    check(f"{len(demands)} recovery demands derived from the run", status == 200 and len(demands) > 0, body)

    section("3 · constrained optimisation")
    payload = {
        "simulation_run_id": run_id,
        "demands": [
            {
                "asset_id": d.get("asset_id"),
                "need": d.get("need") or d.get("required_capacity"),
                "priority": d.get("priority", 3),
            }
            for d in demands
        ],
        "title": "Smoke test recovery plan",
    }
    status, body = analyst.call("POST", "/optimization/preview", payload)
    preview = (body.get("data") or {}).get("result") or {}
    check(
        f"feasibility preview → {status} status={preview.get('status')} "
        f"({preview.get('covered_demand')}/{preview.get('total_demand')} demands)",
        status == 200 and preview.get("status") in {"feasible", "infeasible"},
        body,
    )

    status, body = analyst.call("POST", "/optimization/requests", payload)
    plan = (body.get("data") or {}).get("plan") or {}
    plan_id = plan.get("id")
    check(f"plan {plan.get('code')} persisted (status={plan.get('status')})", status in (200, 201) and plan_id, body)
    infeasible = (plan.get("status") or "").lower() == "infeasible"

    status, body = analyst.call("POST", "/optimization/requests", {**payload, "force_infeasible_demo": True})
    demo = (body.get("data") or {}).get("plan") or {}
    explanation = demo.get("explanation") or {}
    steps = explanation.get("steps") if isinstance(explanation, dict) else explanation
    check(
        "deliberately impossible plan is refused with an explanation",
        status in (200, 201) and (demo.get("status") or "").lower() == "infeasible"
        and bool(demo.get("infeasibility_reason") and steps),
        body,
    )

    section("4 · incident and recovery workflow")
    # The API allows one open incident per (asset, category) and a workflow refuses
    # to start twice for one incident. Clear this script's own leftovers first so it
    # stays re-runnable without wiping seeded history.
    status, body = operator.call("GET", "/incidents?page_size=100")
    for stale in body.get("data") or []:
        if stale.get("title", "").startswith("Smoke test") and stale.get("status") not in {"resolved", "cancelled"}:
            operator.call(
                "POST",
                f"/incidents/{stale['id']}/transition",
                {"status": "cancelled", "note": "superseded by a fresh smoke run"},
            )

    status, body = operator.call(
        "POST",
        "/incidents",
        {
            "title": "Smoke test: Meridian East feeder trip",
            "description": "Automated end-to-end verification of the recovery loop.",
            "category": "power_outage",
            "severity": "critical",
            "primary_asset_id": 1,
        },
    )
    incident = body.get("data") or {}
    incident_id = incident.get("id")
    check(f"incident {incident.get('code')} created → 201", status == 201 and incident_id, body)

    status, body = operator.call("POST", f"/workflows/start?incident_id={incident_id}")
    workflow = body.get("data") or {}
    workflow_id = workflow.get("id")
    check(
        f"workflow {workflow.get('code')} parked at {workflow.get('current_step')} ({workflow.get('status')})",
        status == 201 and workflow.get("status") == "awaiting_approval",
        body,
    )

    # The workflow generates its own plan for the incident; approving the analyst's
    # standalone plan would leave this workflow parked, which is correct behaviour
    # but not what this script is exercising.
    workflow_plan_id = workflow.get("plan_id") or plan_id
    if workflow_plan_id and workflow_id:
        status, body = operator.call(
            "POST",
            f"/optimization/plans/{workflow_plan_id}/approve",
            {"approve": True, "note": "smoke test approval"},
        )
        check(f"plan {workflow_plan_id} approved → 200", status == 200, body)

        status, body = operator.call("GET", f"/tasks?incident_id={incident_id}&page_size=50")
        tasks = body.get("data") or []
        check(f"{len(tasks)} repair tasks dispatched to the field", status == 200 and len(tasks) > 0, body)

        # Only the assignee may accept, and dispatch splits work across engineers,
        # so key the sessions by user id instead of guessing.
        second_engineer = login("engineer2@symbiotic.city", "Engineer#2026")

        def user_id(client: Client):
            return ((client.call("GET", "/auth/me")[1].get("data") or {}).get("user") or {}).get("id")

        by_user_id = {user_id(engineer): engineer, user_id(second_engineer): second_engineer}
        for task in tasks:
            if task.get("status") in {"assigned", "rejected"}:
                assignee = by_user_id.get(task.get("assignee_id"), engineer)
                assignee.call(
                    "POST", f"/tasks/{task['id']}/transition", {"status": "accepted", "note": "en route"}
                )
        accepted = [
            t for t in (operator.call("GET", f"/tasks?incident_id={incident_id}&page_size=50")[1].get("data") or [])
            if t.get("status") in {"accepted", "in_progress"}
        ]
        check(f"engineer accepted {len(accepted)} task(s) → workflow reaches engineer_accepted",
              len(accepted) > 0, accepted)
        status, body = operator.call("GET", f"/workflows/{workflow_id}")
        wf = body.get("data") or {}
        check(f"workflow step now {wf.get('current_step')}", wf.get("current_step") in {"engineer_accepted", "repair_verified", "incident_resolved"}, body)

        for task in accepted:
            assignee = by_user_id.get(task.get("assignee_id"), engineer)
            assignee.call("POST", f"/tasks/{task['id']}/transition", {"status": "in_progress", "note": "on site"})
            assignee.call(
                "POST",
                f"/tasks/{task['id']}/transition",
                {"status": "completed", "note": "repair complete", "actual_hours": 2},
            )
        status, body = operator.call("GET", f"/tasks?incident_id={incident_id}&page_size=50")
        for task in body.get("data") or []:
            if task.get("status") == "completed":
                operator.call("POST", f"/tasks/{task['id']}/transition", {"status": "verified", "note": "verified"})

        status, body = operator.call("GET", f"/workflows/{workflow_id}")
        wf = body.get("data") or {}
        check("all tasks verified → workflow reaches incident_resolved",
              wf.get("status") == "completed" and wf.get("current_step") == "incident_resolved", body)

        status, body = operator.call("GET", f"/incidents/{incident_id}")
        check("incident closed as resolved", (body.get("data") or {}).get("status") == "resolved", body)

        status, body = operator.call("GET", f"/resources/reservations?plan_id={workflow_plan_id}")
        reservations = body.get("data") or []
        check(f"reservations accounted for ({len(reservations)} rows, none stranded active)",
              all(r.get("status") != "active" for r in reservations), reservations)

    section("5 · analytics and audit")
    status, body = operator.call("GET", "/dashboard")
    bundle = body.get("data") or {}
    check(f"dashboard bundle returned {len(bundle)} sections", status == 200 and "overview" in bundle, body)

    status, body = analyst.call("GET", "/analytics/export?kind=incidents&format=csv")
    rows = (body.get("text") or "").splitlines()
    check(
        f"CSV export returned {max(len(rows) - 1, 0)} incident rows",
        status == 200 and len(rows) > 1 and "," in rows[0],
        body,
    )

    status, body = admin.call("GET", "/audit-logs?page_size=10")
    check("audit trail readable by admin", status == 200 and len(body.get("data") or []) > 0, body)

    section("6 · authorisation boundaries")
    status, _ = analyst.call("GET", "/users")
    check("analyst blocked from the user directory (403)", status == 403, status)
    status, _ = engineer.call("GET", "/audit-logs")
    check("engineer blocked from the audit log (403)", status == 403, status)
    # Unique category keeps the idempotency guard from rejecting a re-run.
    probe_category = f"rbac_probe_{uuid.uuid4().hex[:6]}"
    status, _ = operator.call(
        "POST",
        "/incidents",
        {"title": "Permission probe", "description": "rbac", "category": probe_category,
         "severity": "low", "primary_asset_id": 2},
    )
    check("operator may create incidents (201)", status == 201, status)
    status, _ = analyst.call("POST", "/optimization/requests", {"demands": []})
    check("empty optimisation request rejected as invalid", status == 422, status)
    status, _ = anon.call(
        "POST",
        "/incidents",
        {"title": "Anonymous probe", "description": "rbac", "category": f"{probe_category}_anon",
         "severity": "low", "primary_asset_id": 2},
    )
    check("anonymous write refused (401/403)", status in (401, 403), status)

    print()
    if failures:
        print(f"\033[31m{len(failures)} check(s) failed:\033[0m")
        for name in failures:
            print(f"  · {name}")
        return 1
    print("\033[32mAll smoke checks passed.\033[0m")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
