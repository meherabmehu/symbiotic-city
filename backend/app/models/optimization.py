"""Optimisation requests and their explainable plans / assignments."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    Float,
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


class OptimizationRequest(Base):
    __tablename__ = "optimization_requests"
    __table_args__ = (UniqueConstraint("code", name="uq_optimization_request_code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(30), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    objective: Mapped[str] = mapped_column(String(40), default="maximize_critical_coverage", nullable=False)
    incident_id: Mapped[int | None] = mapped_column(ForeignKey("incidents.id", ondelete="SET NULL"))
    simulation_run_id: Mapped[int | None] = mapped_column(
        ForeignKey("simulation_runs.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    demand_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    constraint_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    requested_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)

    plans: Mapped[list[OptimizationPlan]] = relationship(
        back_populates="request", cascade="all, delete-orphan"
    )


class OptimizationPlan(Base):
    __tablename__ = "optimization_plans"
    __table_args__ = (
        UniqueConstraint("code", name="uq_optimization_plan_code"),
        Index("ix_plan_status", "status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(30), nullable=False)
    request_id: Mapped[int] = mapped_column(
        ForeignKey("optimization_requests.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(30), default="proposed", nullable=False)
    solution_status: Mapped[str] = mapped_column(String(30), default="optimal", nullable=False)
    objective_value: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    covered_demand: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_demand: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    coverage_percent: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    solver_wall_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    explanation_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    infeasibility_reason: Mapped[str | None] = mapped_column(Text)
    approved_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    approved_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    rejection_reason: Mapped[str | None] = mapped_column(String(400))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, default=utcnow, onupdate=utcnow, nullable=False
    )

    request: Mapped[OptimizationRequest] = relationship(back_populates="plans")
    assignments: Mapped[list[OptimizationAssignment]] = relationship(
        back_populates="plan", cascade="all, delete-orphan"
    )


class OptimizationAssignment(Base):
    """One (demand, resource) pair chosen by the solver."""

    __tablename__ = "optimization_assignments"

    id: Mapped[int] = mapped_column(primary_key=True)
    plan_id: Mapped[int] = mapped_column(
        ForeignKey("optimization_plans.id", ondelete="CASCADE"), nullable=False
    )
    asset_id: Mapped[int] = mapped_column(
        ForeignKey("infrastructure_assets.id", ondelete="CASCADE"), nullable=False
    )
    resource_id: Mapped[int] = mapped_column(
        ForeignKey("resources.id", ondelete="CASCADE"), nullable=False
    )
    quantity: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)
    priority_weight: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    contribution: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    served: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    rationale: Mapped[str] = mapped_column(String(400), default="", nullable=False)
    repair_task_id: Mapped[int | None] = mapped_column(
        ForeignKey("repair_tasks.id", ondelete="SET NULL")
    )

    plan: Mapped[OptimizationPlan] = relationship(back_populates="assignments")
