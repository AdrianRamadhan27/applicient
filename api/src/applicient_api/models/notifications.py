"""F8.7/§3.1 — Notification delivery record."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from applicient_api.db import Base, TimestampMixin, UUIDPKMixin, UserScopedMixin


class Notification(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    __tablename__ = "notifications"

    channel: Mapped[str] = mapped_column(String(20), nullable=False)  # NotificationChannel
    subject: Mapped[str] = mapped_column(String(300), nullable=False)
    body: Mapped[str | None] = mapped_column(Text)
    related_type: Mapped[str | None] = mapped_column(String(60))  # e.g. "application", "source_run"
    related_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
