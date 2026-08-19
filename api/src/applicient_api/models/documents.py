"""F5 — document tailoring and the truthfulness guarantee.

Document, ClaimVerification.
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from applicient_api.db import Base, TimestampMixin, UUIDPKMixin, UserScopedMixin


class Document(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F5.1/F5.8 — a JSON delta against the master profile, rendered by
    deterministic renderers (F5.2), versioned and bound to the profile
    revision that produced it. Cannot export until a passing
    ClaimVerification exists for this revision (F5.4/F5.5) — enforced
    in application logic, not the schema, but `verified` is kept
    denormalized here for fast list-view queries."""

    __tablename__ = "documents"

    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False
    )
    persona_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("personas.id", ondelete="CASCADE"), nullable=False
    )
    profile_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    doc_type: Mapped[str] = mapped_column(String(20), nullable=False)  # DocumentType
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    json_delta: Mapped[dict] = mapped_column(JSONB, nullable=False)
    rendered_pdf_key: Mapped[str | None] = mapped_column(String(512))
    rendered_docx_key: Mapped[str | None] = mapped_column(String(512))
    template: Mapped[str] = mapped_column(String(120), nullable=False, default="ats-plain")
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class ClaimVerification(UUIDPKMixin, TimestampMixin, Base):
    """F5.4 — the adversarial verifier's per-claim verdicts. Deliberately
    no job_id / JD reference anywhere on this table: the verifier is
    given the master profile and the document only, never the posting,
    so it can't be argued into a claim by what the role wants (§7.3)."""

    __tablename__ = "claim_verifications"

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    claim_text: Mapped[str] = mapped_column(Text, nullable=False)
    evidence_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(UUID(as_uuid=True)), nullable=False, default=list)
    verdict: Mapped[str] = mapped_column(String(20), nullable=False)  # ClaimVerdict
    rationale: Mapped[str | None] = mapped_column(Text)
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)  # capped at 2 (F5.5)
    model_used: Mapped[str | None] = mapped_column(String(120))
    verified_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
