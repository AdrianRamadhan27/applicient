"""Phase 9 (v2 plan) — CalendarEvent: interview/deadline scheduling.

Deliberately separate from ApplicationEvent (models/pipeline.py) —
that's a per-application audit log of state transitions with no
scheduling semantics, this is a genuinely new concept (a thing with a
date the user needs to show up for or hit). `event_type` is a
free-form string validated at the router layer (same discipline as
ApplicationEvent.event_type), not a DB enum, so the vocabulary can
grow without a migration.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from applicient_api.db import Base, TimestampMixin, UUIDPKMixin, UserScopedMixin


class CalendarEvent(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    __tablename__ = "calendar_events"

    # Both nullable and independent (not one derived from the other) —
    # a manually-added event may not be tied to any application yet
    # (e.g. a bare deadline noted from a job posting), and job_id lets
    # an event outlive/predate an Application existing at all.
    application_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE")
    )
    job_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"))
    event_type: Mapped[str] = mapped_column(String(30), nullable=False)  # interview / assessment_deadline / application_deadline / custom
    title: Mapped[str] = mapped_column(String(250), nullable=False)
    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
