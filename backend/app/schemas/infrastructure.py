"""Infrastructure schemas."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, field_validator, model_validator

from app.models.infrastructure import AssetCategory, AssetStatus
from app.schemas.common import ORMModel


class ZoneOut(ORMModel):
    id: int
    code: str
    name: str
    district: str
    population: int
    center_x: float
    center_y: float


class ZoneCreate(BaseModel):
    code: str = Field(min_length=2, max_length=20)
    name: str = Field(min_length=2, max_length=120)
    district: str = Field(min_length=2, max_length=120)
    population: int = Field(default=0, ge=0, le=5_000_000)
    center_x: float = Field(default=50, ge=0, le=100)
    center_y: float = Field(default=50, ge=0, le=100)


class AssetBase(BaseModel):
    code: str = Field(min_length=2, max_length=30, pattern=r"^[A-Z0-9][A-Z0-9\-_]{1,29}$")
    name: str = Field(min_length=2, max_length=140)
    category: AssetCategory
    status: AssetStatus = AssetStatus.OPERATIONAL
    criticality: int = Field(default=3, ge=1, le=5)
    capacity: float = Field(default=100, ge=0, le=1_000_000)
    capacity_unit: str = Field(default="MVA", max_length=30)
    load_percent: float = Field(default=50, ge=0, le=100)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    map_x: float = Field(default=50, ge=0, le=100)
    map_y: float = Field(default=50, ge=0, le=100)
    zone_id: int | None = None
    built_year: int | None = Field(default=None, ge=1900, le=2100)
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator("code")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.strip().upper()

    @field_validator("name")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()


class AssetCreate(AssetBase):
    pass


class AssetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=140)
    category: AssetCategory | None = None
    status: AssetStatus | None = None
    criticality: int | None = Field(default=None, ge=1, le=5)
    capacity: float | None = Field(default=None, ge=0)
    capacity_unit: str | None = Field(default=None, max_length=30)
    load_percent: float | None = Field(default=None, ge=0, le=100)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    map_x: float | None = Field(default=None, ge=0, le=100)
    map_y: float | None = Field(default=None, ge=0, le=100)
    zone_id: int | None = None
    built_year: int | None = Field(default=None, ge=1900, le=2100)
    notes: str | None = Field(default=None, max_length=2000)


class StatusChange(BaseModel):
    status: AssetStatus
    reason: str = Field(min_length=3, max_length=300)


class AssetOut(ORMModel):
    id: int
    code: str
    name: str
    category: str
    category_label: str
    status: str
    criticality: int
    capacity: float
    capacity_unit: str
    load_percent: float
    latitude: float
    longitude: float
    map_x: float
    map_y: float
    zone_id: int | None
    zone: ZoneOut | None = None
    built_year: int | None
    last_inspection_at: datetime | None
    notes: str | None
    is_archived: bool
    created_at: datetime
    updated_at: datetime


class AssetWithMetrics(AssetOut):
    inbound_dependencies: int = 0
    outbound_dependencies: int = 0


class DependencyBase(BaseModel):
    source_asset_id: int
    target_asset_id: int
    dependency_type: str = Field(default="power", max_length=40)
    impact_weight: float = Field(default=1.0, ge=0, le=1)
    redundancy: float = Field(default=0.0, ge=0, le=1)
    description: str | None = Field(default=None, max_length=240)

    @model_validator(mode="after")
    def _no_self(self):
        if self.source_asset_id == self.target_asset_id:
            raise ValueError("An asset cannot depend on itself.")
        return self


class DependencyCreate(DependencyBase):
    pass


class DependencyOut(ORMModel):
    id: int
    source_asset_id: int
    target_asset_id: int
    dependency_type: str
    impact_weight: float
    redundancy: float
    description: str | None
    created_at: datetime


class DependencyDetail(DependencyOut):
    source_code: str = ""
    source_name: str = ""
    target_code: str = ""
    target_name: str = ""


class StatusHistoryOut(ORMModel):
    id: int
    previous_status: str | None
    new_status: str
    reason: str | None
    changed_at: datetime
    changed_by_id: int | None


class AssetDetail(AssetOut):
    inbound: list[DependencyDetail] = []
    outbound: list[DependencyDetail] = []
    history: list[StatusHistoryOut] = []


class GraphNode(BaseModel):
    id: int
    code: str
    name: str
    category: str
    status: str
    criticality: int
    map_x: float
    map_y: float
    zone: str | None = None
    capacity: float
    load_percent: float
    active_incidents: int = 0


class GraphEdge(BaseModel):
    id: int
    source: int
    target: int
    dependency_type: str
    impact_weight: float
    redundancy: float


class TwinGraph(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    zones: list[ZoneOut]
    generated_at: datetime
    stats: dict
