"""F2/F3 — discovery, normalization, dedup, enrichment.

SavedSearch, Source, SourceRun, Company, Job, JobSighting.
"""

import uuid
from datetime import datetime

from pgvector.sqlalchemy import HALFVEC
from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from applicient_api.db import Base, TimestampMixin, UUIDPKMixin, UserScopedMixin
from applicient_api.models.profile import EMBED_DIM


class SavedSearch(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F2.7 — each with its own sources, filters, schedule, persona binding."""

    __tablename__ = "saved_searches"

    persona_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("personas.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    role_titles: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    source_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(UUID(as_uuid=True)), nullable=False, default=list)
    schedule_cron: Mapped[str | None] = mapped_column(String(60))
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Source(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F2.1 — one adapter behind one interface, with its own rate limits,
    auth and circuit-breaker state (F11.2, F11.4)."""

    __tablename__ = "sources"

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    tier: Mapped[str] = mapped_column(String(20), nullable=False)  # SourceTier
    adapter_key: Mapped[str] = mapped_column(String(60), nullable=False)  # e.g. "greenhouse", "jsearch"
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    rate_limit_config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    circuit_breaker_tripped: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class SourceRun(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F2.8 — per-run telemetry: postings seen, new, deduped, errors, cost."""

    __tablename__ = "source_runs"

    saved_search_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("saved_searches.id", ondelete="SET NULL")
    )
    source_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sources.id", ondelete="CASCADE"), nullable=False
    )
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    postings_seen: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    postings_new: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    postings_deduped: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    errors: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    cost_usd: Mapped[float] = mapped_column(Numeric(10, 4), nullable=False, default=0)


class Company(UUIDPKMixin, TimestampMixin, Base):
    """F3.6 — enrichment cache with a TTL. Not user-scoped: a company
    profile is shared fact, not per-user data."""

    __tablename__ = "companies"

    name: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    domain: Mapped[str | None] = mapped_column(String(200), unique=True)
    size: Mapped[str | None] = mapped_column(String(60))
    industry: Mapped[str | None] = mapped_column(String(120))
    funding_stage: Mapped[str | None] = mapped_column(String(60))
    tech_stack: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    sentiment_summary: Mapped[str | None] = mapped_column(Text)
    enriched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Job(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F3.1 — the canonical, deduplicated posting. Salary is nullable by
    design (F3.1a): never estimated, `not stated` when absent, and the
    fit rubric marks that dimension unknown rather than scoring it zero
    (F4.3)."""

    __tablename__ = "jobs"
    __table_args__ = (
        Index(
            "ix_jobs_description_embedding_hnsw",
            "description_embedding",
            postgresql_using="hnsw",
            postgresql_ops={"description_embedding": "halfvec_l2_ops"},
        ),
    )

    title: Mapped[str] = mapped_column(String(250), nullable=False)
    company_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("companies.id", ondelete="SET NULL")
    )
    company_name_raw: Mapped[str] = mapped_column(String(250), nullable=False)
    location: Mapped[str | None] = mapped_column(String(200))
    remote_policy: Mapped[str | None] = mapped_column(String(60))
    seniority: Mapped[str | None] = mapped_column(String(60))
    employment_type: Mapped[str | None] = mapped_column(String(60))
    salary_min: Mapped[float | None] = mapped_column(Numeric(14, 2))
    salary_max: Mapped[float | None] = mapped_column(Numeric(14, 2))
    salary_currency: Mapped[str | None] = mapped_column(String(3))
    posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    requirements: Mapped[str | None] = mapped_column(Text)
    responsibilities: Mapped[str | None] = mapped_column(Text)
    benefits: Mapped[str | None] = mapped_column(Text)
    apply_url: Mapped[str | None] = mapped_column(String(1000))
    preferred_sighting_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True)
    )  # F3.4 — ATS over aggregator when both exist; FK added after job_sightings exists
    description_embedding: Mapped[list[float] | None] = mapped_column(HALFVEC(EMBED_DIM))
    # F3.5 ghost-job signal — surfaced with its reasoning, never a silent filter
    ghost_job_score: Mapped[float | None] = mapped_column(Numeric(4, 3))
    repost_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class JobSighting(UUIDPKMixin, TimestampMixin, Base):
    """F3.3 — N sightings per Job, one per source. Preserved (not
    collapsed) because the repost history IS the ghost-job signal."""

    __tablename__ = "job_sightings"

    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False
    )
    source_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sources.id", ondelete="CASCADE"), nullable=False
    )
    source_url: Mapped[str] = mapped_column(String(1000), nullable=False)
    external_requisition_id: Mapped[str | None] = mapped_column(String(200))  # F3.2(a) — authoritative dedup signal
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    posted_at_on_source: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    raw_posting: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
