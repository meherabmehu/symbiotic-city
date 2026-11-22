"""Multi-step recovery workflow instances and their event ledger."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.core.types import UTCDateTime, utcnow


class WorkflowInstance(Base):
    __tablename__ = "workflow_instances"
    __table_args__ = (UniqueConstraint("code", name="uq_workflow_code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(30), nullable=False)
    workflow_type: Mapped[str] = mapped_column(String(40), default="recovery", nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(String(30), default="running", nullable=False)
    current_step: Mapped[str] = mapped_column(String(60), default="incident_created", nullable=False)
    completed_steps_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    incident_id: Mapped[int | None] = mapped_column(ForeignKey("incidents.id", ondelete="SET NULL"))
    simulation_run_id: Mapped[int | None] = mapped_column(
        ForeignKey("simulation_runs.id", ondelete="SET NULL")
    )
    plan_id: Mapped[int | None] = mapped_column(ForeignKey("optimization_plans.id", ondelete="SET NULL"))
    failure_step: Mapped[str | None] = mapped_column(String(60))
    failure_reason: Mapped[str | None] = mapped_column(Text)
    retry_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    started_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    started_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, default=utcnow, onupdate=utcnow, nullable=False
    )

    events: Mapped[list[WorkflowEvent]] = relationship(
        back_populates="workflow", cascade="all, delete-orphan", order_by="WorkflowEvent.created_at"
    )


class WorkflowEvent(Base):
    __tablename__ = "workflow_events"
    __table_args__ = (
        Index("ix_workflow_event_wf", "workflow_id", "created_at"),
        # idempotency: the same step cannot be recorded twice for a run
        UniqueConstraint("workflow_id", "step", "attempt", name="uq_workflow_event_step_attempt"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    workflow_id: Mapped[int] = mapped_column(
        ForeignKey("workflow_instances.id", ondelete="CASCADE"), nullable=False
    )
    step: Mapped[str] = mapped_column(String(60), nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    outcome: Mapped[str] = mapped_column(String(20), default="succeeded", nullable=False)
    message: Mapped[str] = mapped_column(Text, default="", nullable=False)
    data_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)

    workflow: Mapped[WorkflowInstance] = relationship(back_populates="events")


class IdempotencyKey(Base):
    """Dedupes consequential POSTs (plan approval, reservation, dispatch)."""

    __tablename__ = "idempotency_keys"
    __table_args__ = (UniqueConstraint("key", name="uq_idempotency_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(120), nullable=False)
    scope: Mapped[str] = mapped_column(String(60), nullable=False)
    response_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
