"""Engine, session, and declarative base.

All tables carry user_id from day one (PRD §3.1 — deployment is
single-user/local-first for v1, but multi-tenancy should be an auth
layer added later, not a migration).
"""

import os
import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, MetaData, text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import UUID

# Consistent constraint naming so Alembic autogenerate produces stable,
# diffable migrations instead of Postgres's auto-generated names.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class UUIDPKMixin:
    """UUID primary key, generated server-side by Postgres (built-in
    gen_random_uuid(), verified available with no extension on this
    image — no pgcrypto/uuid-ossp dependency)."""

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=text("now()"),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class UserScopedMixin:
    """Every table carries user_id from day one — multi-tenancy is meant
    to be an auth layer added later, not a schema migration (PRD §3.1)."""

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True
    )


def get_database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set — copy .env.example to .env")
    return url


def make_engine():
    return create_engine(get_database_url(), pool_pre_ping=True)


def make_session_factory(engine=None):
    return sessionmaker(bind=engine or make_engine(), expire_on_commit=False)
