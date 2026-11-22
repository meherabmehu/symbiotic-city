"""Optimisation schemas."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, model_validator

from app.schemas.common import ORMModel


class DemandInput(BaseModel):
    asset_id: int
    need: float = Field(gt=0, le=1000)
    priority: int = Field(default=3, ge=1, le=5)
    eligible_categories: list[str] = Field(default_factory=lambda: ["generator"])
    service_window_minutes: int = Field(default=240, ge=15, le=1440)
    estimated_hours: float = Field(default=2.0, gt=0, le=72)


class OptimizationSubmitRequest(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    simulation_run_id: int | None = None
    incident_id: int | None = None
    objective: str = Field(default="maximize_critical_coverage", max_length=40)
    demands: list[DemandInput] = Field(min_length=1, max_length=40)
    horizon_hours: float = Field(default=12.0, gt=0, le=72)
    must_serve_priority: int | None = Field(default=1, ge=1, le=5)
    max_assignments_per_demand: int = Field(default=3, ge=1, le=5)
    resource_ids: list[int] | None = None
    # when true, the engine is re-run with a deliberately unsatisfiable floor;
    # used by the "show me an infeasible plan" demo path
    force_infeasible_demo: bool = False

    @model_validator(mode="after")
    def _unique_assets(self):
        ids = [d.asset_id for d in self.demands]
        if len(ids) != len(set(ids)):
            raise ValueError("Each infrastructure asset may appear only once in a demand set.")
        return self


class OptimizationPreviewRequest(OptimizationSubmitRequest):
    title: str = Field(default="Preview plan", max_length=200)


class AssignmentOut(ORMModel):
    id: int
    asset_id: int
    resource_id: int
    quantity: float
    priority_weight: int
    contribution: float
    served: bool
    rationale: str
    repair_task_id: int | None = None


class PlanOut(ORMModel):
    id: int
    code: str
    status: str
    solution_status: str
    objective_value: float
    covered_demand: int
    total_demand: int
    coverage_percent: float
    solver_wall_ms: int
    infeasibility_reason: str | None
    approved_at: datetime | None
    approved_by_id: int | None
    created_at: datetime
    assignments: list[AssignmentOut] = []


class PlanDetail(PlanOut):
    explanation: dict
    request: dict
    workflow_id: int | None = None


class RequestOut(ORMModel):
    id: int
    code: str
    title: str
    objective: str
    status: str
    requested_by_id: int | None
    created_at: datetime
    incident_id: int | None
    simulation_run_id: int | None


class ApprovalRequest(BaseModel):
    approve: bool = True
    note: str | None = Field(default=None, max_length=400)
    idempotency_key: str | None = Field(default=None, max_length=120)


class OptimizationOutcome(BaseModel):
    request: RequestOut
    plan: PlanDetail


class ResourceUsageRow(BaseModel):
    resource_id: int
    code: str
    name: str
    available: float
    allocated: float
    utilisation_percent: float
