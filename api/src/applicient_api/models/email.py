"""F8 — email intelligence. EmailMessage."""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from applicient_api.db import Base, TimestampMixin, UUIDPKMixin, UserScopedMixin


class EmailMessage(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F8.3/F8.4/F8.6 — one row per ingested message from the user's
    filtered Gmail label (F8.2: never the whole inbox). Unmatched
    messages go to a review queue (`review_needed`) rather than being
    dropped or guessed onto the wrong application."""

    __tablename__ = "email_messages"

    gmail_message_id: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    thread_id: Mapped[str | None] = mapped_column(String(120))
    subject: Mapped[str | None] = mapped_column(String(500))
    snippet: Mapped[str | None] = mapped_column(Text)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    classification: Mapped[str | None] = mapped_column(String(30))  # EmailClassification
    extracted_data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    matched_application_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("applications.id", ondelete="SET NULL")
    )
    match_confidence: Mapped[float | None] = mapped_column(Numeric(4, 3))
    review_needed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
