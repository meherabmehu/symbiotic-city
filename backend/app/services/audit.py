"""Audit trail writer. Every consequential action funnels through here."""
from __future__ import annotations

import json
from typing import Any

from fastapi import Request
from sqlalchemy.orm import Session

from app.models.identity import User
from app.models.system import AuditLog


def client_ip(request: Request | None) -> str | None:
    if request is None:
        return None
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()[:64]
    return request.client.host[:64] if request.client else None


def record(
    db: Session,
    *,
    action: str,
    actor: User | None = None,
    resource_type: str = "",
    resource_id: Any = None,
    outcome: str = "success",
    message: str = "",
    metadata: dict | None = None,
    request: Request | None = None,
    actor_email: str | None = None,
    actor_role: str | None = None,
) -> AuditLog:
    entry = AuditLog(
        actor_id=actor.id if actor else None,
        actor_email=(actor.email if actor else actor_email) or "anonymous",
        actor_role=(actor.primary_role if actor else actor_role) or "",
        action=action,
        resource_type=resource_type,
        resource_id=str(resource_id) if resource_id is not None else None,
        outcome=outcome,
        message=message[:500],
        metadata_json=json.dumps(metadata or {}, default=str),
        ip_address=client_ip(request),
        user_agent=(request.headers.get("user-agent") or "")[:255] if request else None,
    )
    db.add(entry)
    return entry
