"""Resources, incidents, repair tasks and reservations."""
from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.core.types import UTCDateTime, utcnow


# --------------------------------------------------------------------------- #
# resources
# --------------------------------------------------------------------------- #
class ResourceCategory(StrEnum):
    GENERATOR = "generator"
    WATER_TANKER = "water_tanker"
    CREW = "crew"
    EQUIPMENT = "equipment"
    MEDICAL_SUPPLY = "medical_supply"


RESOURCE_CATEGORY_LABELS: dict[str, str] = {
    ResourceCategory.GENERATOR: "Backup Generator",
    ResourceCategory.WATER_TANKER: "Water Tanker",
    ResourceCategory.CREW: "Repair Crew",
    ResourceCategory.EQUIPMENT: "Heavy Equipment",
    ResourceCategory.MEDICAL_SUPPLY: "Medical Supply",
}


class Resource(Base):
    __tablename__ = "resources"
    __table_args__ = (
        UniqueConstraint("code", name="uq_resource_code"),
        CheckConstraint("capacity > 0", name="ck_resource_capacity_positive"),
        Index("ix_resource_category_status", "category", "status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(30), nullable=False)
    name: Mapped[str] = mapped_column(String(140), nullable=False)
    category: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    capacity: Mapped[float] = mapped_column(Numeric(10, 2), default=1, nullable=False)
    capacity_unit: Mapped[str] = mapped_column(String(30), default="units", nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="available", nullable=False)
    home_zone_id: Mapped[int | None] = mapped_column(
        ForeignKey("city_zones.id", ondelete="SET NULL")
    )
    # cost per hour in credits — used by the optimiser objective
    hourly_cost: Mapped[int] = mapped_column(Integer, default=120, nullable=False)
    # minutes needed before the resource can be on site
    mobilisation_minutes: Mapped[int] = mapped_column(Integer, default=30, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, default=utcnow, onupdate=utcnow, nullable=False
    )

    reservations: Mapped[list[ResourceReservation]] = relationship(back_populates="resource")


class ReservationStatus(StrEnum):
    RESERVED = "reserved"
    RELEASED = "released"
    CONSUMED = "consumed"
    ROLLED_BACK = "rolled_back"


class ResourceReservation(Base):
    __tablename__ = "resource_reservations"
    __table_args__ = (
        Index("ix_reservation_resource_status", "resource_id", "status"),
        Index("ix_reservation_task", "repair_task_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    resource_id: Mapped[int] = mapped_column(
        ForeignKey("resources.id", ondelete="RESTRICT"), nullable=False
    )
    repair_task_id: Mapped[int | None] = mapped_column(
        ForeignKey("repair_tasks.id", ondelete="SET NULL")
    )
    plan_id: Mapped[int | None] = mapped_column(ForeignKey("optimization_plans.id", ondelete="SET NULL"))
    workflow_id: Mapped[int | None] = mapped_column(
        ForeignKey("workflow_instances.id", ondelete="SET NULL")
    )
    quantity: Mapped[float] = mapped_column(Numeric(10, 2), default=1, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default=ReservationStatus.RESERVED, nullable=False)
    reserved_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    released_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    release_reason: Mapped[str | None] = mapped_column(String(240))
    reserved_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))

    resource: Mapped[Resource] = relationship(back_populates="reservations")
    task: Mapped[RepairTask | None] = relationship(back_populates="reservations")


# --------------------------------------------------------------------------- #
# incidents
# --------------------------------------------------------------------------- #
class IncidentStatus(StrEnum):
    REPORTED = "reported"
    VERIFIED = "verified"
    PLANNING = "planning"
    APPROVED = "approved"
    IN_PROGRESS = "in_progress"
    RESOLVED = "resolved"
    CANCELLED = "cancelled"


INCIDENT_TRANSITIONS: dict[str, set[str]] = {
    IncidentStatus.REPORTED: {IncidentStatus.VERIFIED, IncidentStatus.CANCELLED},
    IncidentStatus.VERIFIED: {IncidentStatus.PLANNING, IncidentStatus.CANCELLED},
    IncidentStatus.PLANNING: {IncidentStatus.APPROVED, IncidentStatus.VERIFIED, IncidentStatus.CANCELLED},
    IncidentStatus.APPROVED: {IncidentStatus.IN_PROGRESS, IncidentStatus.PLANNING, IncidentStatus.CANCELLED},
    IncidentStatus.IN_PROGRESS: {IncidentStatus.RESOLVED, IncidentStatus.APPROVED},
    IncidentStatus.RESOLVED: {IncidentStatus.VERIFIED},  # reopen
    IncidentStatus.CANCELLED: set(),
}

SEVERITY_LEVELS = {"low": 1, "medium": 2, "high": 3, "critical": 4}


class Incident(Base):
    __tablename__ = "incidents"
    __table_args__ = (
        UniqueConstraint("code", name="uq_incident_code"),
        # prevents duplicate *active* incidents of the same type on the same
        # primary asset — enforced in the service layer too (SQLite friendly).
        Index("ix_incident_status_severity", "status", "severity"),
        Index("ix_incident_primary_asset", "primary_asset_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(30), nullable=False)
    title: Mapped[str] = mapped_column(String(180), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    category: Mapped[str] = mapped_column(String(40), default="power_outage", nullable=False)
    severity: Mapped[str] = mapped_column(String(20), default="high", nullable=False)
    status: Mapped[str] = mapped_column(String(20), default=IncidentStatus.REPORTED, nullable=False)
    primary_asset_id: Mapped[int] = mapped_column(
        ForeignKey("infrastructure_assets.id", ondelete="RESTRICT"), nullable=False
    )
    reported_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    assigned_operator_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    affected_population: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    simulation_run_id: Mapped[int | None] = mapped_column(ForeignKey("simulation_runs.id", ondelete="SET NULL"))
    optimization_plan_id: Mapped[int | None] = mapped_column(
        ForeignKey("optimization_plans.id", ondelete="SET NULL")
    )
    workflow_id: Mapped[int | None] = mapped_column(ForeignKey("workflow_instances.id", ondelete="SET NULL"))
    reported_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    resolved_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    cancelled_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    resolution_notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, default=utcnow, onupdate=utcnow, nullable=False
    )

    primary_asset: Mapped["InfrastructureAsset"] = relationship()  # noqa: F821
    affected_assets: Mapped[list[IncidentAsset]] = relationship(
        back_populates="incident", cascade="all, delete-orphan"
    )
    events: Mapped[list[IncidentEvent]] = relationship(
        back_populates="incident", cascade="all, delete-orphan", order_by="IncidentEvent.created_at"
    )
    tasks: Mapped[list[RepairTask]] = relationship(back_populates="incident")


class IncidentAsset(Base):
    """Assets impacted by the incident (from simulation or manual report)."""

    __tablename__ = "incident_assets"
    __table_args__ = (UniqueConstraint("incident_id", "asset_id", name="uq_incident_asset"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    incident_id: Mapped[int] = mapped_column(
        ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False
    )
    asset_id: Mapped[int] = mapped_column(
        ForeignKey("infrastructure_assets.id", ondelete="CASCADE"), nullable=False
    )
    impact_level: Mapped[str] = mapped_column(String(20), default="affected", nullable=False)
    impact_score: Mapped[float] = mapped_column(default=0.0, nullable=False)

    incident: Mapped[Incident] = relationship(back_populates="affected_assets")
    asset: Mapped["InfrastructureAsset"] = relationship()  # noqa: F821


class IncidentEvent(Base):
    __tablename__ = "incident_events"
    __table_args__ = (Index("ix_incident_event_incident", "incident_id", "created_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    incident_id: Mapped[int] = mapped_column(
        ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False
    )
    event_type: Mapped[str] = mapped_column(String(40), nullable=False)
    from_status: Mapped[str | None] = mapped_column(String(20))
    to_status: Mapped[str | None] = mapped_column(String(20))
    message: Mapped[str] = mapped_column(String(400), default="", nullable=False)
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)

    incident: Mapped[Incident] = relationship(back_populates="events")
    actor: Mapped["User | None"] = relationship()  # noqa: F821


# --------------------------------------------------------------------------- #
# repair tasks
# --------------------------------------------------------------------------- #
class TaskStatus(StrEnum):
    PENDING = "pending"
    ASSIGNED = "assigned"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    VERIFIED = "verified"
    CANCELLED = "cancelled"


TASK_TRANSITIONS: dict[str, set[str]] = {
    TaskStatus.PENDING: {TaskStatus.ASSIGNED, TaskStatus.CANCELLED},
    TaskStatus.ASSIGNED: {TaskStatus.ACCEPTED, TaskStatus.REJECTED, TaskStatus.CANCELLED},
    TaskStatus.REJECTED: {TaskStatus.PENDING, TaskStatus.CANCELLED},
    TaskStatus.ACCEPTED: {TaskStatus.IN_PROGRESS, TaskStatus.CANCELLED},
    TaskStatus.IN_PROGRESS: {TaskStatus.COMPLETED, TaskStatus.CANCELLED},
    TaskStatus.COMPLETED: {TaskStatus.VERIFIED, TaskStatus.IN_PROGRESS},
    TaskStatus.VERIFIED: set(),
    TaskStatus.CANCELLED: set(),
}


class RepairTask(Base):
    __tablename__ = "repair_tasks"
    __table_args__ = (
        UniqueConstraint("code", name="uq_task_code"),
        Index("ix_task_assignee_status", "assignee_id", "status"),
        Index("ix_task_incident", "incident_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(30), nullable=False)
    title: Mapped[str] = mapped_column(String(180), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[str] = mapped_column(String(20), default=TaskStatus.PENDING, nullable=False)
    priority: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    incident_id: Mapped[int | None] = mapped_column(
        ForeignKey("incidents.id", ondelete="SET NULL"), index=True
    )
    asset_id: Mapped[int] = mapped_column(
        ForeignKey("infrastructure_assets.id", ondelete="RESTRICT"), nullable=False
    )
    assignee_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    verification_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    estimated_hours: Mapped[float] = mapped_column(default=2.0, nullable=False)
    actual_hours: Mapped[float | None] = mapped_column(default=None)
    rejection_reason: Mapped[str | None] = mapped_column(String(400))
    completion_notes: Mapped[str | None] = mapped_column(Text)
    due_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    assigned_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    accepted_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    verified_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, default=utcnow, onupdate=utcnow, nullable=False
    )

    incident: Mapped[Incident | None] = relationship(back_populates="tasks")
    asset: Mapped["InfrastructureAsset"] = relationship()  # noqa: F821
    assignee: Mapped["User | None"] = relationship(foreign_keys=[assignee_id])  # noqa: F821
    history: Mapped[list[TaskStatusHistory]] = relationship(
        back_populates="task", cascade="all, delete-orphan", order_by="TaskStatusHistory.changed_at"
    )
    reservations: Mapped[list[ResourceReservation]] = relationship(back_populates="task")


class TaskStatusHistory(Base):
    __tablename__ = "task_status_history"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(
        ForeignKey("repair_tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    from_status: Mapped[str | None] = mapped_column(String(20))
    to_status: Mapped[str] = mapped_column(String(20), nullable=False)
    note: Mapped[str | None] = mapped_column(String(400))
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    changed_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)

    task: Mapped[RepairTask] = relationship(back_populates="history")
