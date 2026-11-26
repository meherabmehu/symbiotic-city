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
    pass


class WhatIfExtractRequest(BaseModel):
    """Free text describing a failure hypothesis; the AI parses it into the
    existing what-if scenario shape, which is then validated normally."""

    text: str = Field(min_length=3, max_length=4000)
    lang: Literal["en", "bn"] = "en"


class ResilienceReportRequest(LangMixin):
    pass
