"""Request shapes for the AI feature endpoints."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class CopilotRequest(BaseModel):
    """City Copilot question. BN/EN are first-class: the reply echoes the
    language it was answered in."""

    message: str = Field(min_length=1, max_length=1200)
    lang: Literal["en", "bn"] = "en"


class LangMixin(BaseModel):
    lang: Literal["en", "bn"] = "en"


class IncidentExplainRequest(LangMixin):
    pass


class PlanExplainRequest(LangMixin):
    include_alternatives: bool = False


class WhatIfExtractRequest(BaseModel):
    """Free text describing a failure hypothesis; the AI parses it into the
    existing what-if scenario shape, which is then validated normally."""

    text: str = Field(min_length=3, max_length=4000)
    lang: Literal["en", "bn"] = "en"


class ResilienceReportRequest(LangMixin):
    pass


class CommanderRequest(BaseModel):
    """AI Disaster Commander natural-language query."""

    question: str = Field(min_length=2, max_length=1200)
    lang: Literal["en", "bn"] = "en"
    failure_mode: Literal["total_failure", "capacity_loss", "maintenance"] = "total_failure"
    cascade_threshold: float = Field(default=0.35, ge=0.05, le=0.95)
    max_depth: int = Field(default=6, ge=1, le=12)


class ScenarioSpec(BaseModel):
    """Explicit scenario specification for multi-scenario comparison."""

    label: str | None = Field(default=None, max_length=120)
    asset_codes: list[str] = Field(min_length=1, max_length=5)
    failure_mode: Literal["total_failure", "capacity_loss", "maintenance"] = "total_failure"
    cascade_threshold: float = Field(default=0.35, ge=0.05, le=0.95)
    max_depth: int = Field(default=6, ge=1, le=12)


class ScenarioCompareRequest(BaseModel):
    """Multi-Scenario AI Reasoning request: either natural-language comparison
    or 2–3 explicit scenario specs."""

    question: str | None = Field(default=None, max_length=1200)
    scenarios: list[ScenarioSpec] | None = Field(default=None, min_length=2, max_length=3)
    lang: Literal["en", "bn"] = "en"
