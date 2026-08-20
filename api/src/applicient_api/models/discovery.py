"""F2/F3 — discovery, normalization, dedup, enrichment.

SavedSearch, Source, SourceRun, Company, Job, JobSighting.
"""

import uuid
from datetime import datetime

from pgvector.sqlalchemy import HALFVEC
from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint
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
    # M1 §3 — location/remote/seniority filters. A JSONB bag rather than
    # three nullable columns, matching Source.config/ModelProfile.tier_bindings
    # elsewhere: all three are optional, and this stays extensible without
    # a migration every time a new filter dimension is added.
    filters: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
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
    # M1 §3 — same test-connection contract as ProviderConnection
    # (F12.5): a Source's config isn't trustworthy until a real
    # test_connection call against it has succeeded, and the GUI needs
    # somewhere to persist and show that.
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="untested")  # ConnectionStatus
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)


class SourceRun(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F2.8 — per-run telemetry: postings seen, new, deduped, errors, cost."""

    __tablename__ = "source_runs"

    saved_search_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("saved_searches.id", ondelete="SET NULL")
    )
    # M1 §3 follow-up — without this, there was no way to read back
    # "which SourceRuns belong to this specific AgentRun" at all
    # (only "which saved search," which conflates every run of that
    # search together). Raised by Adrian wanting a completed run to
    # stay visible after navigating away and back, which needs this
    # to reconstruct one specific run's source breakdown from the DB.
    agent_run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_runs.id", ondelete="SET NULL")
    )
    source_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sources.id", ondelete="CASCADE"), nullable=False
    )
    # M1 §3 — lets a resumed radar run tell what's already done rather
    # than restarting a source from zero.
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")  # SourceRunStatus
    # M1 §3 — the source-appropriate query variants a role title was
    # expanded into, kept in the run trace rather than only in an LLM
    # call's opaque prompt.
    expanded_queries: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)  # {role_title: [queries]}
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
    # M1 §4 — dedup signal #2 (F3.2b): normalize(company)+normalize(title)+
    # normalize(location) for comparison only; title/company_name_raw above
    # keep the original display values. Indexed, not unique — signal #2 is
    # advisory (a lookup helper for the dedup pass), not a hard constraint;
    # two genuinely different postings can share a key and get disambiguated
    # by requisition ID or embedding similarity instead.
    canonical_key: Mapped[str] = mapped_column(String(500), nullable=False, index=True)
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
    # F3.4 — ATS over aggregator when both exist. The FK originally
    # deferred (job_sightings didn't exist yet when this column was
    # added) — job_sightings has existed since M0, so this is now a
    # real, enforced foreign key rather than a bare UUID.
    preferred_sighting_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("job_sightings.id", ondelete="SET NULL")
    )
    description_embedding: Mapped[list[float] | None] = mapped_column(HALFVEC(EMBED_DIM))
    # F3.5 ghost-job signal — surfaced with its reasoning, never a silent
    # filter. ghost_job_score/repost_count existed since M0; reasons is
    # new (M1 §4) — the actual explanation ("reposted 4x in 90 days",
    # "posted_at reset without a requisition change"), not just a score.
    ghost_job_score: Mapped[float | None] = mapped_column(Numeric(4, 3))
    ghost_job_reasons: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    repost_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class JobSighting(UUIDPKMixin, TimestampMixin, Base):
    """F3.3 — N sightings per Job, one per source. Preserved (not
    collapsed) because the repost history IS the ghost-job signal."""

    __tablename__ = "job_sightings"
    __table_args__ = (
        # M1 §1/§4 — dedup signal #1 (F3.2a), the authoritative one.
        # Postgres treats each NULL as distinct for uniqueness purposes,
        # so sources/postings with no requisition ID never collide here —
        # this only actually constrains the sightings that DO carry one,
        # which is exactly the point: a rerun upserts onto the same
        # sighting instead of inserting a duplicate.
        UniqueConstraint(
            "source_id", "external_requisition_id", name="uq_job_sightings_source_requisition"
        ),
    )

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
