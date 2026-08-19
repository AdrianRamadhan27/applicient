"""F4 — fit scoring. FitScore."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from applicient_api.db import Base, TimestampMixin, UUIDPKMixin, UserScopedMixin


class FitScore(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F4.2-F4.10 — structured, schema-validated, never a bare number.
    Recomputed when profile/persona changes, not frozen at discovery
    time (F4.10) — so this is an append-only history, not one row per
    job; callers read the latest by (job_id, persona_id)."""

    __tablename__ = "fit_scores"

    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False
    )
    persona_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("personas.id", ondelete="CASCADE"), nullable=False
    )
    profile_revision: Mapped[int] = mapped_column(Integer, nullable=False)

    recommendation: Mapped[str] = mapped_column(String(20), nullable=False)  # Recommendation
    overall_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False)

    hard_requirements_met: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    hard_requirements_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    hard_blocker: Mapped[str | None] = mapped_column(String(200))  # F4.5 — which blocker fired, if any

    experience_delta_years: Mapped[float | None] = mapped_column(Numeric(4, 1))
    skills_matched: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    skills_partial: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    skills_missing: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)

    seniority_fit: Mapped[str | None] = mapped_column(String(20))
    domain_fit: Mapped[str | None] = mapped_column(String(20))
    location_fit: Mapped[str | None] = mapped_column(String(20))
    # Nullable, and distinct from a real score: null means "unknown, excluded
    # from the weighted total" (F4.3) because the job's salary was never
    # stated (F3.1a) — never coerced to zero.
    salary_overlap: Mapped[str | None] = mapped_column(String(20))
    company_stage_fit: Mapped[str | None] = mapped_column(String(20))
    language_fit: Mapped[str | None] = mapped_column(String(20))

    evidence_spans: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)  # F4.6
    gap_closers: Mapped[str | None] = mapped_column(Text)  # F4.7
    red_flags: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)  # F4.8

    model_used: Mapped[str | None] = mapped_column(String(120))
    cost_usd: Mapped[float] = mapped_column(Numeric(10, 5), nullable=False, default=0)
