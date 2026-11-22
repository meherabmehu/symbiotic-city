"""Shared schema helpers."""
from __future__ import annotations

from datetime import datetime
from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Message(BaseModel):
    message: str


class PageMeta(BaseModel):
    total: int
    page: int
    page_size: int
    pages: int
    has_next: bool
    has_prev: bool


class Envelope(BaseModel, Generic[T]):
    success: bool = True
    data: T
    meta: dict | None = None


class Page(BaseModel, Generic[T]):
    success: bool = True
    data: list[T]
    meta: PageMeta


class ListQuery(BaseModel):
    search: str | None = None
    sort: str | None = None
    direction: str = Field(default="asc", pattern="^(asc|desc)$")


class Timestamped(ORMModel):
    created_at: datetime
    updated_at: datetime
