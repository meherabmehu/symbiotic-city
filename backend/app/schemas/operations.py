"""Incident, task, resource, workflow and notification schemas."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.models.operations import IncidentStatus, ResourceCategory, TaskStatus
from app.schemas.common import ORMModel

# --------------------------------------------------------------------------- #
# resources
# --------------------------------------------------------------------------- #


class ResourceBase(BaseModel):
    code: str = Field(min_length=2, max_length=30, pattern=r"^[A-Z0-9][A-Z0-9\-_]{1,29}$")
    name: str = Field(min_length=2, max_length=140)
    category: ResourceCategory
    capacity: float = Field(default=1, gt=0, le=10_000)
    capacity_unit: str = Field(default="units", max_length=30)
    status: str = Field(default="available", pattern="^(available|assigned|maintenance|unavailable)$")
    home_zone_id: int | None = None
    hourly_cost: int = Field(default=120, ge=0, le=100_000)
    mobilisation_minutes: int = Field(default=30, ge=0, le=1440)
    notes: str | None = Field(default=None, max_length=1000)


class ResourceCreate(ResourceBase):
    pass


class ResourceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=140)
    category: ResourceCategory | None = None
    capacity: float | None = Field(default=None, gt=0, le=10_000)
    capacity_unit: str | None = Field(default=None, max_length=30)
    status: str | None = Field(default=None, pattern="^(available|assigned|maintenance|unavailable)$")
    home_zone_id: int | None = None
    hourly_cost: int | None = Field(default=None, ge=0, le=100_000)
    mobilisation_minutes: int | None = Field(default=None, ge=0, le=1440)
    notes: str | None = Field(default=None, max_length=1000)
    is_archived: bool | None = None


class ReservationOut(ORMModel):
    id: int
    resource_id: int
    repair_task_id: int | None
    plan_id: int | None
    workflow_id: int | None
    quantity: float
    status: str
    reserved_at: datetime
    released_at: datetime | None
    release_reason: str | None


class ResourceOut(ORMModel):
    id: int
    code: str
    name: str
    category: str
    capacity: float
    capacity_unit: str
    status: str
    home_zone_id: int | None
    hourly_cost: int
    mobilisation_minutes: int
    notes: str | None
    is_archived: bool
    created_at: datetime
    updated_at: datetime
    reserved_quantity: float = 0.0
    available_quantity: float = 0.0
    active_reservations: int = 0


class ReserveRequest(BaseModel):
    repair_task_id: int | None = None
    plan_id: int | None = None
    quantity: float | None = Field(default=None, gt=0)
    idempotency_key: str | None = Field(default=None, max_length=120)


class ReleaseRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=240)


# --------------------------------------------------------------------------- #
# incidents
# --------------------------------------------------------------------------- #
class IncidentCreate(BaseModel):
    title: str = Field(min_length=4, max_length=180)
    description: str = Field(default="", max_length=4000)
    category: str = Field(default="power_outage", max_length=40)
    severity: str = Field(default="high", pattern="^(low|medium|high|critical)$")
    primary_asset_id: int
    simulation_run_id: int | None = None
    affected_asset_ids: list[int] = Field(default_factory=list, max_length=60)


class IncidentUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=4, max_length=180)
    description: str | None = Field(default=None, max_length=4000)
    severity: str | None = Field(default=None, pattern="^(low|medium|high|critical)$")
    assigned_operator_id: int | None = None


class IncidentTransition(BaseModel):
    status: IncidentStatus
    note: str = Field(default="", max_length=1000)
    resolution_notes: str | None = Field(default=None, max_length=2000)


class IncidentAssetOut(ORMModel):
    id: int
    asset_id: int
    impact_level: str
    impact_score: float


class IncidentEventOut(ORMModel):
    id: int
    event_type: str
    from_status: str | None
    to_status: str | None
    message: str
    actor_id: int | None
    created_at: datetime


class IncidentOut(ORMModel):
    id: int
    code: str
    title: str
    description: str
    category: str
    severity: str
    status: str
    primary_asset_id: int
    reported_by_id: int | None
    assigned_operator_id: int | None
    affected_population: int
    simulation_run_id: int | None
    optimization_plan_id: int | None
    workflow_id: int | None
    reported_at: datetime
    resolved_at: datetime | None
    resolution_notes: str | None
    created_at: datetime
    updated_at: datetime
    primary_asset_code: str | None = None
    primary_asset_name: str | None = None
    task_count: int = 0
    open_task_count: int = 0


class IncidentDetail(IncidentOut):
    affected_assets: list[IncidentAssetOut] = []
    events: list[IncidentEventOut] = []
    allowed_transitions: list[str] = []


# --------------------------------------------------------------------------- #
# tasks
# --------------------------------------------------------------------------- #
class TaskCreate(BaseModel):
    title: str = Field(min_length=4, max_length=180)
    description: str = Field(default="", max_length=4000)
    asset_id: int
    incident_id: int | None = None
    assignee_id: int | None = None
    priority: int = Field(default=3, ge=1, le=5)
    estimated_hours: float = Field(default=2.0, gt=0, le=72)
    due_at: datetime | None = None


class TaskAssign(BaseModel):
    assignee_id: int
    note: str | None = Field(default=None, max_length=400)


class TaskTransition(BaseModel):
    status: TaskStatus
    note: str = Field(default="", max_length=1000)
    actual_hours: float | None = Field(default=None, ge=0, le=200)
    rejection_reason: str | None = Field(default=None, max_length=400)


class TaskOut(ORMModel):
    id: int
    code: str
    title: str
    description: str
    status: str
    priority: int
    incident_id: int | None
    asset_id: int
    assignee_id: int | None
    estimated_hours: float
    actual_hours: float | None
    due_at: datetime | None
    assigned_at: datetime | None
    accepted_at: datetime | None
    started_at: datetime | None
    completed_at: datetime | None
    verified_at: datetime | None
    completion_notes: str | None
    rejection_reason: str | None
    created_at: datetime
    updated_at: datetime
    asset_code: str | None = None
    asset_name: str | None = None
    incident_code: str | None = None
    assignee_name: str | None = None
    reservations: list[ReservationOut] = []


class TaskDetail(TaskOut):
    history: list[dict] = []
    allowed_transitions: list[str] = []


# --------------------------------------------------------------------------- #
# workflows & notifications
# --------------------------------------------------------------------------- #
class WorkflowEventOut(ORMModel):
    id: int
    step: str
    attempt: int
    outcome: str
    message: str
    actor_id: int | None
    created_at: datetime


class WorkflowOut(ORMModel):
    id: int
    code: str
    workflow_type: str
    title: str
    status: str
    current_step: str
    incident_id: int | None
    simulation_run_id: int | None
    plan_id: int | None
    failure_step: str | None
    failure_reason: str | None
    retry_count: int
    started_at: datetime
    completed_at: datetime | None
    updated_at: datetime
    completed_steps: list[str] = []


class WorkflowDetail(WorkflowOut):
    events: list[WorkflowEventOut] = []
    next_actions: list[str] = []


class NotificationOut(ORMModel):
    id: int
    title: str
    body: str
    category: str
    severity: str
    link: str | None
    entity_type: str | None
    entity_id: int | None
    is_read: bool
    read_at: datetime | None
    created_at: datetime


class NotificationSummary(BaseModel):
    unread: int
    total: int


class AuditOut(ORMModel):
    id: int
    actor_id: int | None
    actor_email: str
    actor_role: str
    action: str
    resource_type: str
    resource_id: str | None
    outcome: str
    message: str
    metadata_json: str
    ip_address: str | None
    created_at: datetime
