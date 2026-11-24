"""Simulation scenarios, runs and per-node results."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.core.types import UTCDateTime, utcnow


class SimulationScenario(Base):
    __tablename__ = "simulation_scenarios"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    failure_mode: Mapped[str] = mapped_column(String(40), default="total_failure", nullable=False)
    # JSON list of asset ids that fail at t=0
    initial_failure_ids_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    cascade_threshold: Mapped[float] = mapped_column(Float, default=0.35, nullable=False)
    max_depth: Mapped[int] = mapped_column(Integer, default=6, nullable=False)
    random_seed: Mapped[int] = mapped_column(Integer, default=42, nullable=False)
    is_template: Mapped[bool] = mapped_column(default=False, nullable=False)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)


class SimulationRun(Base):
    __tablename__ = "simulation_runs"
    __table_args__ = (UniqueConstraint("code", name="uq_simulation_code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(30), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    scenario_id: Mapped[int | None] = mapped_column(
        ForeignKey("simulation_scenarios.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(String(20), default="queued", nullable=False)
    failure_mode: Mapped[str] = mapped_column(String(40), default="total_failure", nullable=False)
    initial_failure_ids_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    cascade_threshold: Mapped[float] = mapped_column(Float, default=0.35, nullable=False)
    max_depth: Mapped[int] = mapped_column(Integer, default=6, nullable=False)
    random_seed: Mapped[int] = mapped_column(Integer, default=42, nullable=False)
    # snapshot of the graph at run time so results stay reproducible
    snapshot_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    summary_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text)
    triggered_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    incident_id: Mapped[int | None] = mapped_column(ForeignKey("incidents.id", ondelete="SET NULL"))
    started_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    duration_ms: Mapped[int | None] = mapped_column(Integer)

    results: Mapped[list[SimulationResult]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )


class SimulationResult(Base):
    __tablename__ = "simulation_results"
    __table_args__ = (Index("ix_sim_result_run", "run_id", "depth"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(
        ForeignKey("simulation_runs.id", ondelete="CASCADE"), nullable=False
    )
    asset_id: Mapped[int] = mapped_column(
        ForeignKey("infrastructure_assets.id", ondelete="CASCADE"), nullable=False
    )
    impact_level: Mapped[str] = mapped_column(String(20), nullable=False)  # failed|degraded|affected
    depth: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    impact_score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    capacity_loss_percent: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    affected_population: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cause_asset_id: Mapped[int | None] = mapped_column(
        ForeignKey("infrastructure_assets.id", ondelete="SET NULL")
    )
    explanation: Mapped[str] = mapped_column(String(400), default="", nullable=False)

    run: Mapped[SimulationRun] = relationship(back_populates="results")


class WhatIfScenario(Base):
    """A saved what-if: a named failure hypothesis with its run history.

    ``SimulationScenario`` holds the reusable template (where the failure starts,
    at what threshold). This holds an *investigation*: a question the city asked,
    the runs that answered it, and the notes that explain what changed between
    them. Keeping them apart matters because a template is edited, whereas a
    recorded investigation must stay exactly as it was when it was interpreted.
    """

    __tablename__ = "whatif_scenarios"
    __table_args__ = (UniqueConstraint("code", name="uq_whatif_code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(30), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # the hypothesis: which assets fail, under what model parameters
    initial_failure_ids_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    failure_mode: Mapped[str] = mapped_column(String(40), default="total_failure", nullable=False)
    cascade_threshold: Mapped[float] = mapped_column(Float, default=0.35, nullable=False)
    max_depth: Mapped[int] = mapped_column(Integer, default=6, nullable=False)
    random_seed: Mapped[int] = mapped_column(Integer, default=42, nullable=False)
    # ordering hint for the comparison view
    is_baseline: Mapped[bool] = mapped_column(default=False, nullable=False)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, default=utcnow, onupdate=utcnow, nullable=False
    )


class WhatIfObservation(Base):
    """One recorded run against a what-if, with the reading taken from it.

    The metrics are copied, not recomputed. A comparison that re-derives numbers
    from a run months later is a comparison of today's engine against yesterday's
    decision; storing the reading keeps the record honest.
    """

    __tablename__ = "whatif_observations"
    __table_args__ = (Index("ix_whatif_observation_scenario", "scenario_id", "created_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    scenario_id: Mapped[int] = mapped_column(
        ForeignKey("whatif_scenarios.id", ondelete="CASCADE"), nullable=False
    )
    run_id: Mapped[int | None] = mapped_column(
        ForeignKey("simulation_runs.id", ondelete="SET NULL")
    )
    headline: Mapped[str] = mapped_column(String(240), default="", nullable=False)
    note: Mapped[str] = mapped_column(Text, default="", nullable=False)
    metrics_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)

    scenario: Mapped[WhatIfScenario] = relationship()
    run: Mapped[SimulationRun | None] = relationship()
