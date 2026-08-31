"""F6/F7/F9 — application execution, pipeline tracking and the
already-applied ledger.

Application, ApplicationEvent, ApplicationAttempt, AppliedLedgerEntry,
FormAnswer, BrowserContext, PipelineStage.
"""

import uuid
from datetime import datetime

from pgvector.sqlalchemy import HALFVEC
from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from applicient_api.db import Base, TimestampMixin, UUIDPKMixin, UserScopedMixin
from applicient_api.models.profile import EMBED_DIM


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
    # M4 — traces back to the Composer session that produced this
    # application's documents. Document is bound to a JobGroup, not a
    # single Job (F5.10's M3 redesign), and one group can still
    # produce applications to several of its member jobs independently
    # — so this is its own nullable link, not derived from job_id.
    job_group_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("job_groups.id", ondelete="SET NULL")
    )
    # M4 — which tailored CV (or cover letter) version was actually
    # used for this specific application. Without this it only exists
    # buried in an ApplicationEvent payload; F6.9's audit trail and
    # F7's timeline both want it as a first-class, queryable field.
    primary_document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="SET NULL")
    )
    # M5 follow-up — no longer validated against a fixed enum; must be
    # one of the owning user's own PipelineStage.key values (enforced
    # in pipeline_service.py's transition(), not at the DB level).
    state: Mapped[str] = mapped_column(String(20), nullable=False, default="discovered")
    autonomy_level: Mapped[str | None] = mapped_column(String(20))  # AutonomyLevel, set once a doc is prepared
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PipelineStage(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """M5 follow-up — user-customizable pipeline states, replacing the
    old fixed 13-value ApplicationState enum. `key` is immutable once
    created (String(20) to match Application.state's own column width
    exactly — that's what `Application.state` actually stores) and is
    what every piece of automation (ghosted-derivation, email-driven
    transitions, mark_applied) compares against; `display_name` is the
    only thing a rename ever touches, so renaming never breaks
    automation that depends on a specific key still existing.
    `position` is fully owned by pipeline_stage_service.py — reassigned
    0..N-1 on every create/delete/reorder, no DB-level uniqueness on it."""

    __tablename__ = "pipeline_stages"
    __table_args__ = (UniqueConstraint("user_id", "key", name="uq_pipeline_stages_user_key"),)

    key: Mapped[str] = mapped_column(String(20), nullable=False)
    display_name: Mapped[str] = mapped_column(String(60), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)


class ApplicationEvent(UUIDPKMixin, Base):
    """F7.4 — per-application timeline. No TimestampMixin: `occurred_at`
    is the meaningful timestamp here, not a created/updated pair.

    `event_type` is a genuinely free-form string (mirrors this table's
    own original design, not DB-enforced) — the vocabulary this
    codebase writes is validated at the schema layer instead
    (`schemas.py`'s `ApplicationEventType` Literal): created,
    state_changed, note_added, document_attached, form_filled,
    handoff_requested, handoff_resolved, submitted, email_matched
    (unused until M5, reserved), marked_applied_manually."""

    __tablename__ = "application_events"

    application_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False
    )
    actor: Mapped[str] = mapped_column(String(20), nullable=False)  # EventActor
    event_type: Mapped[str] = mapped_column(String(60), nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ApplicationAttempt(UUIDPKMixin, TimestampMixin, Base):
    """F6.9 — the full forensic record of one fill/submit run. An
    Application can have more than one of these (a first attempt fails
    or gets abandoned mid-handoff) — ApplicationEvent stays the
    human-readable timeline, this is the audit trail one specific
    application-agent run actually produced: every screenshot, the
    resolved field map, and any error, independent of what state the
    Application itself ended up in."""

    __tablename__ = "application_attempts"

    application_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False
    )
    agent_run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_runs.id", ondelete="SET NULL")
    )
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    autonomy_level: Mapped[str] = mapped_column(String(20), nullable=False)  # AutonomyLevel
    # in_progress / awaiting_review / awaiting_handoff / awaiting_email / submitted / abandoned / failed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="in_progress")
    # The accessibility-tree-derived field schema plus resolved values
    # and where each value came from (memory/profile/generated/user) —
    # F6.3's resolution order, recorded, not just followed.
    field_map: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    screenshot_keys: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    # Populated by the agent's `propose_email_application` tool when a
    # posting turns out to have no online form at all (e.g. "send your
    # CV to hr@company.com") — the real, common alternative to F6's
    # browser-fill path. {to, subject, body}; attachments stay manual
    # (mailto: can't carry a file) — the GUI pairs this with a plain
    # CV/cover-letter download button instead of pretending otherwise.
    email_draft: Mapped[dict | None] = mapped_column(JSONB)
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


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


class FormAnswer(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F6.3/§9 — reusable question -> answer memory, embedding-backed
    (same `HALFVEC`/`cosine_distance` retrieval shape as EvidenceItem,
    mirrored rather than reinvented). The application-agent's field
    resolution chain checks here first: a question asked once and
    answered (by the user, via an interrupt) is never asked again."""

    __tablename__ = "form_answers"
    __table_args__ = (
        Index(
            "ix_form_answers_embedding_hnsw",
            "question_embedding",
            postgresql_using="hnsw",
            postgresql_ops={"question_embedding": "halfvec_l2_ops"},
        ),
    )

    persona_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("personas.id", ondelete="CASCADE"), nullable=False
    )
    question_text: Mapped[str] = mapped_column(Text, nullable=False)
    question_embedding: Mapped[list[float] | None] = mapped_column(HALFVEC(EMBED_DIM))
    answer_text: Mapped[str] = mapped_column(Text, nullable=False)
    source_application_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("applications.id", ondelete="SET NULL")
    )
    times_reused: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class BrowserContext(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F6.6 — one persistent, authenticated browser context per
    (persona, source). `storage_state_key` points at an object-storage
    blob that is itself Fernet-encrypted before it's ever written
    (same mechanism as `ProviderConnection.api_key`, not a new one) —
    it can carry real session cookies, so it gets the same at-rest
    treatment. Passwords are never stored anywhere in this table or
    the blob it points to: the user logs in once inside the live
    handoff view and Playwright's own `storage_state()` captures only
    the resulting session, nothing typed."""

    __tablename__ = "browser_contexts"

    persona_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("personas.id", ondelete="CASCADE"), nullable=False
    )
    source_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sources.id", ondelete="CASCADE"), nullable=False
    )
    storage_state_key: Mapped[str | None] = mapped_column(String(512))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
