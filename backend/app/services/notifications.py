"""Notification fan-out. Every notification is scoped to one recipient."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.identity import Role, User
from app.models.system import Notification


def push(
    db: Session,
    *,
    user_id: int,
    title: str,
    body: str = "",
    category: str = "general",
    severity: str = "info",
    link: str | None = None,
    entity_type: str | None = None,
    entity_id: int | None = None,
) -> Notification:
    note = Notification(
        user_id=user_id,
        title=title[:200],
        body=body,
        category=category,
        severity=severity,
        link=link,
        entity_type=entity_type,
        entity_id=entity_id,
    )
    db.add(note)
    return note


def push_to_role(db: Session, role_key: str, **kwargs) -> int:
    users = db.scalars(select(User).join(User.roles).where(Role.key == role_key)).unique().all()
    for user in users:
        if user.is_active:
            push(db, user_id=user.id, **kwargs)
    return len(users)


def push_to_roles(db: Session, role_keys: list[str], **kwargs) -> int:
    total = 0
    seen: set[int] = set()
    for role_key in role_keys:
        users = db.scalars(select(User).join(User.roles).where(Role.key == role_key)).unique().all()
        for user in users:
            if user.is_active and user.id not in seen:
                seen.add(user.id)
                push(db, user_id=user.id, **kwargs)
                total += 1
    return total
