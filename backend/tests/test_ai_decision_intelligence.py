"""Tests for AI Disaster Commander, Multi-Scenario AI Reasoning, and
Explainable Recovery Intelligence."""

from __future__ import annotations

from app.services.ai.provider import AiError, AiReply, AiTruncated


class AsyncFakeGroq:
    def __init__(self, reply_text: str = "### Grounded Summary\nVerified output."):
        self.reply_text = reply_text
        self.calls: list[dict] = []

    async def chat(self, messages, *, max_tokens: int = 1200, temperature: float = 0.2):
        self.calls.append({"messages": messages, "max_tokens": max_tokens})
        return AiReply(
            text=self.reply_text,
            model="llama-3.3-70b-versatile",
            provider="groq",
            finish_reason="stop",
        )


class FailingProvider:
    async def chat(self, messages, *, max_tokens: int = 1200, temperature: float = 0.2):
        raise AiError("Groq rate limit reached")


class TruncatingProvider:
    async def chat(self, messages, *, max_tokens: int = 1200, temperature: float = 0.2):
        raise AiTruncated("Partial incomplete text...")


def _login(client, email: str, password: str):
    client.get("/api/auth/me")
    r = client.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200
    return client.cookies.get("symbiotic_csrf") or ""


def _count(client, path: str) -> int:
    r = client.get(path)
    assert r.status_code == 200
    body = r.json()
    meta = body.get("meta") or {}
    if "total" in meta:
        return int(meta["total"])
    data = body.get("data")
    return len(data) if isinstance(data, list) else len(data.get("items", []))


def test_commander_valid_asset_is_readonly_and_grounded(client, monkeypatch):
    csrf = _login(client, "operator@symbiotic.city", "Operator#2026")
    fake = AsyncFakeGroq("### Situation Summary\nPS-01 simulated.")
    monkeypatch.setattr("app.api.routes.ai.get_provider", lambda: fake)

    before_runs = _count(client, "/api/simulations")
    before_inc = _count(client, "/api/incidents")

    resp = client.post(
        "/api/ai/commander",
        headers={"X-CSRF-Token": csrf},
        json={"question": "If PS-01 fails, what happens to Aurora Vale, and what should we do first?"},
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["provider"] == "LLM (Groq)"
    assert data["resolution"]["status"] == "resolved"
    assert data["resolution"]["assets"][0]["code"] == "PS-01"
    assert data["simulation"]["summary"]["assets_failed"] >= 1
    assert data["sections"]["population_at_risk"] == data["simulation"]["summary"]["affected_population"]
    assert any("/twin?highlight=" in a["href"] for a in data["next_actions"])
    assert len(fake.calls) == 1

    assert _count(client, "/api/simulations") == before_runs
    assert _count(client, "/api/incidents") == before_inc


def test_commander_unknown_and_ambiguous_assets(client, monkeypatch):
    csrf = _login(client, "analyst@symbiotic.city", "Analyst#2026")
    monkeypatch.setattr("app.api.routes.ai.get_provider", lambda: None)

    r_unknown = client.post(
        "/api/ai/commander",
        headers={"X-CSRF-Token": csrf},
        json={"question": "What happens if XX-99 fails?"},
    )
    assert r_unknown.status_code == 200
    assert r_unknown.json()["data"]["resolution"]["status"] == "unknown"

    r_ambig = client.post(
        "/api/ai/commander",
        headers={"X-CSRF-Token": csrf},
        json={"question": "What happens if a substation fails?"},
    )
    assert r_ambig.status_code == 200
    res_ambig = r_ambig.json()["data"]["resolution"]
    assert res_ambig["status"] == "ambiguous"
    assert len(res_ambig["candidates"]) >= 2


def test_commander_permissions_and_fallback_and_bangla(client, monkeypatch):
    csrf_eng = _login(client, "engineer@symbiotic.city", "Engineer#2026")
    r_eng = client.post(
        "/api/ai/commander",
        headers={"X-CSRF-Token": csrf_eng},
        json={"question": "If PS-01 fails?"},
    )
    assert r_eng.status_code == 403

    csrf_op = _login(client, "operator@symbiotic.city", "Operator#2026")
    monkeypatch.setattr("app.api.routes.ai.get_provider", lambda: FailingProvider())
    r_bn = client.post(
        "/api/ai/commander",
        headers={"X-CSRF-Token": csrf_op},
        json={"question": "If PS-01 fails?", "lang": "bn"},
    )
    assert r_bn.status_code == 200
    d_bn = r_bn.json()["data"]
    assert d_bn["provider"].startswith("rule-based")
    assert "PS-01" in d_bn["reply"]
    assert "পরিস্থিতি সারসংক্ষেপ" in d_bn["reply"]


def test_multi_scenario_compare_and_ties_and_readonly(client, monkeypatch):
    csrf = _login(client, "analyst@symbiotic.city", "Analyst#2026")
    monkeypatch.setattr("app.api.routes.ai.get_provider", lambda: AsyncFakeGroq("### Comparison\nPS-01 vs SS-01."))

    before_runs = _count(client, "/api/simulations")

    resp = client.post(
        "/api/ai/scenarios/compare",
        headers={"X-CSRF-Token": csrf},
        json={"question": "Compare the impact of PS-01 failure versus SS-01 failure"},
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["provider"] == "LLM (Groq)"
    assert len(data["scenarios"]) == 2
    assert len(data["metrics_table"]) >= 6
    assert "shared_failures" in data["set_differences"]
    assert _count(client, "/api/simulations") == before_runs

    # Identical scenarios must explicitly report 'tied'
    monkeypatch.setattr("app.api.routes.ai.get_provider", lambda: None)
    resp_tie = client.post(
        "/api/ai/scenarios/compare",
        headers={"X-CSRF-Token": csrf},
        json={
            "scenarios": [
                {"label": "Run A", "asset_codes": ["PS-01"]},
                {"label": "Run B", "asset_codes": ["PS-01"]},
            ]
        },
    )
    assert resp_tie.status_code == 200
    tie_data = resp_tie.json()["data"]
    assert tie_data["provider"].startswith("rule-based")
    assert all(row["higher_impact"] == "tied" for row in tie_data["metrics_table"])

    # Unknown asset code -> 422
    resp_bad = client.post(
        "/api/ai/scenarios/compare",
        headers={"X-CSRF-Token": csrf},
        json={
            "scenarios": [
                {"asset_codes": ["PS-01"]},
                {"asset_codes": ["ZZ-99"]},
            ]
        },
    )
    assert resp_bad.status_code == 422


def test_explainable_recovery_alternatives_and_truncation_and_rbac(client, monkeypatch):
    csrf_an = _login(client, "analyst@symbiotic.city", "Analyst#2026")
    # Create a simulation run and optimization plan so the test is self-contained
    sim_r = client.post(
        "/api/simulations/run",
        headers={"X-CSRF-Token": csrf_an},
        json={"initial_failure_ids": [1], "failure_mode": "total_failure", "cascade_threshold": 0.35, "max_depth": 6},
    )
    assert sim_r.status_code == 201
    run_id = sim_r.json()["data"]["id"]
    dem_r = client.get(f"/api/simulations/{run_id}/demands")
    assert dem_r.status_code == 200
    dem_data = dem_r.json()["data"]
    demands = dem_data if isinstance(dem_data, list) else dem_data["demands"]
    opt_r = client.post(
        "/api/optimization/requests",
        headers={"X-CSRF-Token": csrf_an},
        json={"title": "Explainable recovery test plan", "simulation_run_id": run_id, "demands": demands},
    )
    assert opt_r.status_code == 201
    plan = opt_r.json()["data"]["plan"]
    assert plan is not None
    before_plans = _count(client, "/api/optimization/plans")

    # Engineer lacks optimization:read
    csrf_eng = _login(client, "engineer@symbiotic.city", "Engineer#2026")
    r_forbidden = client.post(
        f"/api/ai/plans/{plan['id']}/explain",
        headers={"X-CSRF-Token": csrf_eng},
        json={"include_alternatives": True},
    )
    assert r_forbidden.status_code == 403

    csrf_op = _login(client, "operator@symbiotic.city", "Operator#2026")
    monkeypatch.setattr("app.api.routes.ai.get_provider", lambda: TruncatingProvider())
    resp = client.post(
        f"/api/ai/plans/{plan['id']}/explain",
        headers={"X-CSRF-Token": csrf_op},
        json={"include_alternatives": True},
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["truncated"] is True
    assert "incomplete" in data["provider"].lower()
    assert data["reasoning"]["optimality_status"] == plan["solution_status"]
    assert len(data["alternatives"]) == 3
    assert {a["strategy"] for a in data["alternatives"]} == {
        "priority_first",
        "coverage_max",
        "resource_conservative",
    }
    # Read-only: no plans were persisted
    assert _count(client, "/api/optimization/plans") == before_plans
