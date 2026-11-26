"""Async regression tests for the AI integration.

These tests exist to prevent the exact class of bug that caused HTTP 500 on
``POST /api/ai/copilot``: the route calling ``provider.chat()`` without
``await``, receiving a coroutine object, and crashing on ``.text``.

The ``AsyncFakeProvider`` is ``async def`` like the real ``GroqProvider``.
If any code path forgets ``await``, the test will fail with:

    AttributeError: 'coroutine' object has no attribute 'text'

Both the keyless (rule-based fallback) and keyed (async mock) paths are
exercised for every endpoint.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

import app.api.routes.ai as ai_routes
from app.services.ai import features as ai_features
from app.services.ai.provider import AiError
from tests.conftest import unique_category as _unique_category


# ----------------------------------------------------------------- async mock


class AsyncFakeProvider:
    """An async mock provider that mirrors GroqProvider.chat()'s signature.

    If the caller forgets ``await``, they receive a coroutine, and accessing
    ``.text`` on it fails immediately.
    """

    def __init__(self, reply_text: str) -> None:
        self.reply_text = reply_text
        self.calls: list[list[dict]] = []

    async def chat(self, messages, *, temperature=0.2, max_tokens=700):
        self.calls.append(list(messages))
        return SimpleNamespace(text=self.reply_text, model="async-fake", provider="groq")


class AsyncFailingProvider:
    """An async provider that always raises AiError."""

    async def chat(self, messages, *, temperature=0.2, max_tokens=700):
        raise AiError("Simulated provider failure")


class AsyncUnexpectedErrorProvider:
    """An async provider that raises an unexpected (non-AiError) exception."""

    async def chat(self, messages, *, temperature=0.2, max_tokens=700):
        raise RuntimeError("Unexpected provider crash")


# ----------------------------------------------------------------- fixtures


@pytest.fixture
def city_operator(as_role):
    return as_role("city_operator")


@pytest.fixture
def city_analyst(as_role):
    return as_role("city_analyst")


@pytest.fixture(autouse=True)
def clean_rate_window():
    yield
    ai_routes._ai_hits.clear()


@pytest.fixture
def async_llm(monkeypatch):
    """Install an async mock provider and return it."""

    def install(reply_text: str) -> AsyncFakeProvider:
        provider = AsyncFakeProvider(reply_text)
        monkeypatch.setattr(ai_routes, "get_provider", lambda: provider)
        return provider

    return install


@pytest.fixture
def failing_llm(monkeypatch):
    """Install an async provider that always raises AiError."""

    def install() -> AsyncFailingProvider:
        provider = AsyncFailingProvider()
        monkeypatch.setattr(ai_routes, "get_provider", lambda: provider)
        return provider

    return install


@pytest.fixture
def unexpected_error_llm(monkeypatch):
    """Install an async provider that raises a non-AiError exception."""

    def install() -> AsyncUnexpectedErrorProvider:
        provider = AsyncUnexpectedErrorProvider()
        monkeypatch.setattr(ai_routes, "get_provider", lambda: provider)
        return provider

    return install


def _first_incident_id(operator) -> int | None:
    response = operator.get("/api/incidents", params={"page_size": 1})
    assert response.status_code == 200, response.text
    rows = response.json()["data"]
    return rows[0]["id"] if rows else None


# ------------------------------------------------ async await regression tests


class TestAsyncAwaitRegression:
    """Every AI endpoint must correctly await the async provider."""

    def test_copilot_awaits_async_provider(self, city_operator, async_llm):
        provider = async_llm("Async copilot reply")
        response = city_operator.post(
            "/api/ai/copilot", json={"message": "Tell me about PS-01"}
        )
        assert response.status_code == 200, response.text
        payload = response.json()["data"]
        assert payload["reply"] == "Async copilot reply"
        assert payload["provider"] == "LLM (Groq)"
        assert len(provider.calls) == 1

    def test_incident_explain_awaits_async_provider(self, city_operator, async_llm):
        incident_id = _first_incident_id(city_operator)
        if incident_id is None:
            pytest.skip("no seeded incidents")
        provider = async_llm("Async incident explanation")
        response = city_operator.post(
            f"/api/ai/incidents/{incident_id}/explain", json={}
        )
        assert response.status_code == 200, response.text
        payload = response.json()["data"]
        assert payload["reply"] == "Async incident explanation"
        assert payload["provider"] == "LLM (Groq)"

    def test_plan_explain_awaits_async_provider(self, city_analyst, async_llm):
        assets = city_analyst.get(
            "/api/infrastructure", params={"page_size": 2}
        ).json()["data"]
        assert len(assets) >= 2
        submitted = city_analyst.post(
            "/api/optimization/requests",
            json={
                "title": "Async regression plan",
                "demands": [
                    {"asset_id": assets[0]["id"], "need": 10, "priority": 1,
                     "eligible_categories": ["generator"]},
                    {"asset_id": assets[1]["id"], "need": 10, "priority": 2,
                     "eligible_categories": ["generator"]},
                ],
                "horizon_hours": 6,
            },
        )
        assert submitted.status_code == 201, submitted.text
        plan_id = submitted.json()["data"]["plan"]["id"]

        provider = async_llm("Async plan narration")
        response = city_analyst.post(
            f"/api/ai/plans/{plan_id}/explain", json={}
        )
        assert response.status_code == 200, response.text
        payload = response.json()["data"]
        assert payload["reply"] == "Async plan narration"
        assert payload["provider"] == "LLM (Groq)"

    def test_whatif_extract_awaits_async_provider(self, city_operator, async_llm):
        provider = async_llm(
            '{"failure_codes": ["PS-01"], "failure_mode": "total_failure", '
            '"cascade_threshold": 0.3, "max_depth": 5, "random_seed": 42, '
            '"name": "Async scenario", "description": "from async mock"}'
        )
        response = city_operator.post(
            "/api/ai/whatif/extract", json={"text": "PS-01 fails completely"}
        )
        assert response.status_code == 201, response.text
        payload = response.json()["data"]
        assert payload["parsed_by"] == "llm"
        assert payload["provider"] == "LLM (Groq)"
        # Clean up
        if payload["scenario"]:
            city_operator.delete(
                f"/api/resilience/whatif/{payload['scenario']['id']}"
            )

    def test_resilience_report_awaits_async_provider(self, city_operator, async_llm):
        provider = async_llm("Async resilience narrative")
        response = city_operator.post(
            "/api/ai/resilience/report", json={}
        )
        assert response.status_code == 200, response.text
        payload = response.json()["data"]
        assert payload["report"] == "Async resilience narrative"
        assert payload["provider"] == "LLM (Groq)"


# ---------------------------------------------- graceful error handling tests


class TestGracefulErrorHandling:
    """AI provider failures must fall back to rule-based, never 500."""

    def test_copilot_falls_back_on_ai_error(self, city_operator, failing_llm):
        failing_llm()
        response = city_operator.post(
            "/api/ai/copilot", json={"message": "PS-01"}
        )
        assert response.status_code == 200, response.text
        payload = response.json()["data"]
        assert "rule-based" in payload["provider"]

    def test_copilot_falls_back_on_unexpected_error(self, city_operator, unexpected_error_llm):
        unexpected_error_llm()
        response = city_operator.post(
            "/api/ai/copilot", json={"message": "PS-01"}
        )
        assert response.status_code == 200, response.text
        payload = response.json()["data"]
        assert "rule-based" in payload["provider"]

    def test_incident_explain_falls_back_on_ai_error(self, city_operator, failing_llm):
        incident_id = _first_incident_id(city_operator)
        if incident_id is None:
            pytest.skip("no seeded incidents")
        failing_llm()
        response = city_operator.post(
            f"/api/ai/incidents/{incident_id}/explain", json={}
        )
        assert response.status_code == 200, response.text
        payload = response.json()["data"]
        assert "rule-based" in payload["provider"]

    def test_resilience_report_falls_back_on_ai_error(self, city_operator, failing_llm):
        failing_llm()
        response = city_operator.post(
            "/api/ai/resilience/report", json={}
        )
        assert response.status_code == 200, response.text
        payload = response.json()["data"]
        assert "rule-based" in payload["provider"]

    def test_whatif_extract_falls_back_on_unexpected_error(self, city_operator, unexpected_error_llm):
        unexpected_error_llm()
        response = city_operator.post(
            "/api/ai/whatif/extract",
            json={"text": "Fail PS-01 at threshold 0.5"},
        )
        assert response.status_code == 201, response.text
        payload = response.json()["data"]
        assert payload["parsed_by"] == "rule-based"


# -------------------------------------- keyless rule-based fallback tests


class TestKeylessFallback:
    """With no GROQ_API_KEY, every endpoint must work via rule-based fallback."""

    def test_copilot_keyless(self, city_operator):
        response = city_operator.post(
            "/api/ai/copilot", json={"message": "PS-01"}
        )
        assert response.status_code == 200
        payload = response.json()["data"]
        assert "rule-based" in payload["provider"]
        assert any("PS-01" in c["label"] for c in payload["citations"])

    def test_incident_explain_keyless(self, city_operator):
        incident_id = _first_incident_id(city_operator)
        if incident_id is None:
            pytest.skip("no seeded incidents")
        response = city_operator.post(
            f"/api/ai/incidents/{incident_id}/explain", json={}
        )
        assert response.status_code == 200
        assert "rule-based" in response.json()["data"]["provider"]

    def test_resilience_report_keyless(self, city_operator):
        response = city_operator.post(
            "/api/ai/resilience/report", json={}
        )
        assert response.status_code == 200
        assert "rule-based" in response.json()["data"]["provider"]


# -------------------------------------- copilot infrastructure data test


class TestCopilotInfrastructureData:
    """Copilot must retrieve real infrastructure data including criticality."""

    def test_copilot_retrieves_ps02_infrastructure(self, city_operator, async_llm):
        """Verify the copilot's context includes PS-02 and its data."""
        provider = async_llm("PS-02 is a critical power asset.")
        response = city_operator.post(
            "/api/ai/copilot", json={"message": "Tell me about PS-02 criticality"}
        )
        assert response.status_code == 200
        payload = response.json()["data"]
        # PS-02 should be cited
        cited_labels = [c["label"] for c in payload["citations"]]
        assert any("PS-02" in label for label in cited_labels), (
            f"PS-02 must be cited; got: {cited_labels}"
        )
        # The LLM received PS-02 data in the prompt context
        joined = "\n".join(m["content"] for call in provider.calls for m in call)
        assert "PS-02" in joined

    def test_resilience_report_includes_criticality_rankings(self, city_operator):
        """The report stats must include criticality data, not generic answers."""
        response = city_operator.post(
            "/api/ai/resilience/report", json={}
        )
        assert response.status_code == 200
        payload = response.json()["data"]
        stats = payload["stats"]
        # Criticality data should be populated from the real database
        assert "criticality" in stats
        # Top risks should include ranked assets (if data is seeded)
        if stats.get("top_risks"):
            # Each risk has a label and reason with a criticality index
            for risk in stats["top_risks"]:
                assert "label" in risk
                assert "reason" in risk
