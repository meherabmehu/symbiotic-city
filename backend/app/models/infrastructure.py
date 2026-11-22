"""City zones, infrastructure assets, dependencies and status history."""
from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from sqlalchemy import (
    Boolean,
    CheckConstraint,
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


class AssetStatus(StrEnum):
    OPERATIONAL = "operational"
    DEGRADED = "degraded"
    OFFLINE = "offline"
    MAINTENANCE = "maintenance"
    ARCHIVED = "archived"


class AssetCategory(StrEnum):
    POWER_STATION = "power_station"
    SUBSTATION = "substation"
    HOSPITAL = "hospital"
    WATER_PUMP = "water_pump"
    WATER_TREATMENT = "water_treatment"
    SCHOOL = "school"
    RESIDENTIAL = "residential"
    COMMERCIAL = "commercial"
    TELECOM = "telecom"


CATEGORY_LABELS: dict[str, str] = {
    AssetCategory.POWER_STATION: "Power Station",
    AssetCategory.SUBSTATION: "Electrical Substation",
    AssetCategory.HOSPITAL: "Hospital",
    AssetCategory.WATER_PUMP: "Water Pumping Station",
    AssetCategory.WATER_TREATMENT: "Water Treatment Plant",
    AssetCategory.SCHOOL: "School",
    AssetCategory.RESIDENTIAL: "Residential Area",
    AssetCategory.COMMERCIAL: "Commercial Facility",
    AssetCategory.TELECOM: "Telecom Exchange",
}

# Priority used by the optimiser and impact scoring (1 = most critical).
CATEGORY_PRIORITY: dict[str, int] = {
    AssetCategory.HOSPITAL: 1,
    AssetCategory.WATER_TREATMENT: 2,
    AssetCategory.WATER_PUMP: 3,
    AssetCategory.POWER_STATION: 2,
    AssetCategory.SUBSTATION: 3,
    AssetCategory.TELECOM: 4,
    AssetCategory.RESIDENTIAL: 5,
    AssetCategory.SCHOOL: 6,
    AssetCategory.COMMERCIAL: 7,
}

# Weight used when translating outage into "affected people" impact.
CATEGORY_POPULATION_WEIGHT: dict[str, int] = {
    AssetCategory.HOSPITAL: 900,
    AssetCategory.WATER_TREATMENT: 1200,
    AssetCategory.WATER_PUMP: 1500,
    AssetCategory.POWER_STATION: 2400,
    AssetCategory.SUBSTATION: 1800,
    AssetCategory.TELECOM: 1600,
    AssetCategory.RESIDENTIAL: 3200,
    AssetCategory.SCHOOL: 700,
    AssetCategory.COMMERCIAL: 900,
}


class CityZone(Base):
    __tablename__ = "city_zones"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    district: Mapped[str] = mapped_column(String(120), nullable=False)
    population: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # normalised 0..100 map coordinates for the twin
    center_x: Mapped[float] = mapped_column(Float, default=50.0, nullable=False)
    center_y: Mapped[float] = mapped_column(Float, default=50.0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)

    assets: Mapped[list[InfrastructureAsset]] = relationship(back_populates="zone")


class InfrastructureAsset(Base):
    __tablename__ = "infrastructure_assets"
    __table_args__ = (
        UniqueConstraint("code", name="uq_asset_code"),
        CheckConstraint("capacity >= 0", name="ck_asset_capacity_positive"),
        CheckConstraint("load_percent >= 0 AND load_percent <= 100", name="ck_asset_load_range"),
        Index("ix_asset_category_status", "category", "status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(30), nullable=False)
    name: Mapped[str] = mapped_column(String(140), nullable=False)
    category: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    zone_id: Mapped[int | None] = mapped_column(
        ForeignKey("city_zones.id", ondelete="SET NULL"), index=True
    )
    status: Mapped[str] = mapped_column(String(20), default=AssetStatus.OPERATIONAL, nullable=False)
    criticality: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    capacity: Mapped[float] = mapped_column(Float, default=100.0, nullable=False)
    capacity_unit: Mapped[str] = mapped_column(String(30), default="MVA", nullable=False)
    load_percent: Mapped[float] = mapped_column(Float, default=50.0, nullable=False)
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    map_x: Mapped[float] = mapped_column(Float, default=50.0, nullable=False)
    map_y: Mapped[float] = mapped_column(Float, default=50.0, nullable=False)
    built_year: Mapped[int | None] = mapped_column(Integer)
    last_inspection_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    notes: Mapped[str | None] = mapped_column(Text)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, default=utcnow, onupdate=utcnow, nullable=False
    )

    zone: Mapped[CityZone | None] = relationship(back_populates="assets")
    outgoing: Mapped[list[InfrastructureDependency]] = relationship(
        foreign_keys="InfrastructureDependency.source_asset_id",
        back_populates="source",
        cascade="all, delete-orphan",
    )
    incoming: Mapped[list[InfrastructureDependency]] = relationship(
        foreign_keys="InfrastructureDependency.target_asset_id",
        back_populates="target",
        cascade="all, delete-orphan",
    )

    @property
    def category_label(self) -> str:
        return CATEGORY_LABELS.get(self.category, self.category.replace("_", " ").title())

    @property
    def is_serviceable(self) -> bool:
        return self.status == AssetStatus.OPERATIONAL


class InfrastructureDependency(Base):
    """Directed edge: ``target`` depends on ``source``.

    If the source fails, the target is impacted (water pumps depend on the
    substation that feeds them, substations depend on power stations, ...).
    """

    __tablename__ = "infrastructure_dependencies"
    __table_args__ = (
        UniqueConstraint("source_asset_id", "target_asset_id", name="uq_dependency_edge"),
        CheckConstraint("source_asset_id <> target_asset_id", name="ck_no_self_dependency"),
        Index("ix_dependency_source", "source_asset_id"),
        Index("ix_dependency_target", "target_asset_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    source_asset_id: Mapped[int] = mapped_column(
        ForeignKey("infrastructure_assets.id", ondelete="CASCADE"), nullable=False
    )
    target_asset_id: Mapped[int] = mapped_column(
        ForeignKey("infrastructure_assets.id", ondelete="CASCADE"), nullable=False
    )
    dependency_type: Mapped[str] = mapped_column(String(40), default="power", nullable=False)
    # 0..1: fraction of target capacity lost when the source is completely down
    impact_weight: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)
    # 0..1: susceptibility of the target to this dependency failing
    redundancy: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    description: Mapped[str | None] = mapped_column(String(240))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)

    source: Mapped[InfrastructureAsset] = relationship(
        foreign_keys=[source_asset_id], back_populates="outgoing"
    )
    target: Mapped[InfrastructureAsset] = relationship(
        foreign_keys=[target_asset_id], back_populates="incoming"
    )


class InfrastructureStatusHistory(Base):
    __tablename__ = "infrastructure_status_history"
    __table_args__ = (Index("ix_status_history_asset_time", "asset_id", "changed_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    asset_id: Mapped[int] = mapped_column(
        ForeignKey("infrastructure_assets.id", ondelete="CASCADE"), nullable=False
    )
    previous_status: Mapped[str | None] = mapped_column(String(20))
    new_status: Mapped[str] = mapped_column(String(20), nullable=False)
    reason: Mapped[str | None] = mapped_column(String(300))
    changed_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    changed_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)

    asset: Mapped[InfrastructureAsset] = relationship()
