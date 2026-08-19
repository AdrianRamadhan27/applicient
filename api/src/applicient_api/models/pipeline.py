"""F7/F9 — pipeline tracking and the already-applied ledger.

Application, ApplicationEvent, AppliedLedgerEntry.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from applicient_api.db import Base, TimestampMixin, UUIDPKMixin, UserScopedMixin


class Application(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F7.1/F7.2 — one state-machine instance bound to a Job. `ghosted`
    is derived (F7.3: no event for N days after applying), computed at
    query time from ApplicationEvent, not stored as a separate flag
    that could drift out of sync."""

    __tablename__ = "applications"

    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False
    )
    persona_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("personas.id", ondelete="CASCADE"), nullable=False
    )
    state: Mapped[str] = mapped_column(String(20), nullable=False, default="discovered")  # ApplicationState
    autonomy_level: Mapped[str | None] = mapped_column(String(20))  # AutonomyLevel, set once a doc is prepared
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ApplicationEvent(UUIDPKMixin, Base):
    """F7.4 — per-application timeline. No TimestampMixin: `occurred_at`
    is the meaningful timestamp here, not a created/updated pair."""

    __tablename__ = "application_events"

    application_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False
    )
    actor: Mapped[str] = mapped_column(String(20), nullable=False)  # EventActor
    event_type: Mapped[str] = mapped_column(String(60), nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class AppliedLedgerEntry(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F9 — imported/derived application history, checked before
    scoring (F9.4) so already-applied roles never resurface."""

    __tablename__ = "applied_ledger_entries"

    company_name: Mapped[str] = mapped_column(String(250), nullable=False)
    role_title: Mapped[str] = mapped_column(String(250), nullable=False)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source: Mapped[str] = mapped_column(String(20), nullable=False)  # LedgerSource
    matched_application_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("applications.id", ondelete="SET NULL")
    )
