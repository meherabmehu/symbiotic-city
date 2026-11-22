"""Alembic environment.

The URL comes from the application settings so `alembic upgrade head` and the
running API always target the same database. Metadata is the single declarative
``Base`` used by the models, with every model module imported for autogenerate.
"""
from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool

from app.core.config import settings
from app.core.database import Base

# Importing the models package registers all 30 tables on Base.metadata.
import app.models  # noqa: F401,E402

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _render_item(type_, obj, autogen_context) -> str | bool:
    """Render our custom column types as portable SQLAlchemy types."""
    if type_ == "type" and obj.__class__.__name__ == "UTCDateTime":
        autogen_context.imports.add("import sqlalchemy as sa")
        return "sa.DateTime(timezone=True)"
    return False


def _url() -> str:
    url = settings.database_url
    if url.startswith("sqlite"):
        path = settings.sqlite_path
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            return f"sqlite:///{path}"
    return url


def run_migrations_offline() -> None:
    context.configure(
        url=_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        render_item=_render_item,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    from sqlalchemy import create_engine

    connectable = create_engine(_url(), poolclass=pool.NullPool, future=True)
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            render_item=_render_item,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
