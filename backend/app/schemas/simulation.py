"""Simulation schemas."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import ORMModel


class ScenarioCreate(BaseModel):
    name: str = Field(min_length=3, max_length=160)
    description: str = Field(default="", max_length=2000)
    failure_mode: Literal["total_failure", "capacity_loss", "maintenance"] = "total_failure"
    initial_failure_ids: list[int] = Field(min_length=1, max_length=10)
    cascade_threshold: float = Field(default=0.35, ge=0.05, le=1.0)
    max_depth: int = Field(default=6, ge=1, le=12)
    random_seed: int = Field(default=42, ge=0, le=2**31 - 1)
    save_as_template: bool = False

    @field_validator("initial_failure_ids")
    @classmethod
    def _unique(cls, v: list[int]) -> list[int]:
        return list(dict.fromkeys(v))


class ScenarioOut(ORMModel):
    id: int
    name: str
    description: str
    failure_mode: str
    cascade_threshold: float
    max_depth: int
    random_seed: int
    is_template: bool
    created_at: datetime
    initial_failure_ids: list[int] = []


class SimulationRunRequest(BaseModel):
    """Either reference a saved scenario or supply an ad-hoc one."""

    scenario_id: int | None = None
    name: str | None = Field(default=None, max_length=200)
    failure_mode: Literal["total_failure", "capacity_loss", "maintenance"] = "total_failure"
    initial_failure_ids: list[int] = Field(default_factory=list, max_length=10)
    cascade_threshold: float = Field(default=0.35, ge=0.05, le=1.0)
    max_depth: int = Field(default=6, ge=1, le=12)
    random_seed: int = Field(default=42, ge=0, le=2**31 - 1)
    incident_id: int | None = None
    create_incident: bool = False
    incident_title: str | None = Field(default=None, max_length=180)
    incident_severity: Literal["low", "medium", "high", "critical"] = "high"
    # optional load jitter (0 = fully deterministic default)
    load_noise: float = Field(default=0.0, ge=0, le=0.3)

    @field_validator("initial_failure_ids")
    @classmethod
    def _unique(cls, v: list[int]) -> list[int]:
        return list(dict.fromkeys(v))


class ImpactOut(BaseModel):
    asset_id: int
    code: str
    name: str
    category: str
    impact_level: str
    depth: int
    impact_score: float
    capacity_loss_percent: float
    affected_population: int
    cause_asset_id: int | None = None
    explanation: str


class RunSummary(BaseModel):
    assets_total: int = 0
    assets_impacted: int = 0
    assets_failed: int = 0
    assets_degraded: int = 0
    assets_affected: int = 0
    max_depth_reached: int = 0
    affected_population: int = 0
    critical_services_down: list[str] = []
    severity_index: float = 0.0
    cascade_category_breakdown: dict[str, int] = {}
    failure_mode: str = ""
    cascade_threshold: float = 0.0


class SimulationRunOut(ORMModel):
    id: int
    code: str
    name: str
    status: str
    failure_mode: str
    cascade_threshold: float
    max_depth: int
    random_seed: int
    started_at: datetime
    completed_at: datetime | None
    duration_ms: int | None
    triggered_by_id: int | None
    incident_id: int | None
    summary_json: str
    initial_failure_ids_json: str


class SimulationRunDetail(SimulationRunOut):
    summary: RunSummary
    initial_failure_ids: list[int]
    impacts: list[ImpactOut]
    timeline: list[dict]
    graph_warnings: list[str]
    assumptions: list[str]
    snapshot_hash: str


class SimulationComparison(BaseModel):
    runs: list[SimulationRunOut]
    metrics: list[dict]


class WhatIfScenarioCreate(BaseModel):
    """A named failure hypothesis to keep and compare later."""

    name: str = Field(min_length=3, max_length=200)
    description: str = Field(default="", max_length=1000)
    initial_failure_ids: list[int] = Field(min_length=1, max_length=10)
    failure_mode: Literal["total_failure", "capacity_loss", "maintenance"] = "total_failure"
    cascade_threshold: float = Field(default=0.35, ge=0.05, le=1.0)
    max_depth: int = Field(default=6, ge=1, le=12)
    random_seed: int = Field(default=42, ge=0, le=2**31 - 1)
    is_baseline: bool = False

    @field_validator("initial_failure_ids")
    @classmethod
    def _unique(cls, v: list[int]) -> list[int]:
        return list(dict.fromkeys(v))


class WhatIfObserveRequest(BaseModel):
    note: str = Field(default="", max_length=1000)
