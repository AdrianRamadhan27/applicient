"""F12/F13 — provider connections, model catalog, tier routing, and the
cost ledger. This is the M0 exit-bar schema: "paste an API key, see
what a call cost" depends on every table here.

ProviderConnection, ModelCatalogEntry, ModelProfile, EmbeddingIndex,
LlmCall, Budget.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from applicient_api.db import Base, TimestampMixin, UUIDPKMixin, UserScopedMixin


class ProviderConnection(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F12.2/F12.5/F12.6 — managed entirely from the GUI. api_key is
    encrypted at rest by the application layer (Fernet/similar) before
    it ever reaches this column — the DB only ever sees ciphertext, and
    the API layer must never echo it back after save (F12.6), only a
    masked hint computed from it."""

    __tablename__ = "provider_connections"

    provider: Mapped[str] = mapped_column(String(30), nullable=False)  # ProviderType
    label: Mapped[str | None] = mapped_column(String(120))  # user-facing name, e.g. "OpenRouter"
    api_key_encrypted: Mapped[bytes] = mapped_column(nullable=False)
    api_key_hint: Mapped[str | None] = mapped_column(String(20))  # e.g. "sk-or-v1......4a2f"
    base_url: Mapped[str | None] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="untested")  # ConnectionStatus
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)


class ModelCatalogEntry(UUIDPKMixin, TimestampMixin, Base):
    """F12.7/F12.8 — discovered live from each provider's list-models
    endpoint, cached with a TTL (`fetched_at`). Not user-scoped
    directly: scoped through provider_connection_id, since the catalog
    belongs to a connection, not a user row."""

    __tablename__ = "model_catalog_entries"

    provider_connection_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("provider_connections.id", ondelete="CASCADE"), nullable=False
    )
    model_id: Mapped[str] = mapped_column(String(200), nullable=False)  # provider's own identifier
    display_name: Mapped[str | None] = mapped_column(String(200))
    context_window: Mapped[int | None] = mapped_column(Integer)
    max_output: Mapped[int | None] = mapped_column(Integer)
    capabilities: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    input_price_per_mtok: Mapped[float | None] = mapped_column(Numeric(12, 6))
    output_price_per_mtok: Mapped[float | None] = mapped_column(Numeric(12, 6))
    cache_read_price_per_mtok: Mapped[float | None] = mapped_column(Numeric(12, 6))
    cache_write_price_per_mtok: Mapped[float | None] = mapped_column(Numeric(12, 6))
    pricing_version: Mapped[str | None] = mapped_column(String(40))
    pricing_known: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)  # F12.8/F13.6
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # Phase 11 (v2 plan) — only ever populated for a "speech" capability
    # entry (a TTS model's real named-voice list, e.g. OpenRouter's
    # deepgram/aura-2 reports 90 of these via its own catalog's
    # `supported_voices` field). Null for every chat/embedding/
    # transcription entry — there's nothing to pick there.
    voices: Mapped[list[str] | None] = mapped_column(ARRAY(String))
    # A transcription/speech entry's real cost is priced per minute of
    # INPUT AUDIO or per CHARACTER of input text, respectively — never
    # per-token like every other entry here (confirmed live against
    # OpenRouter's own catalog, cross-checked against each provider's
    # real published rate: openai/whisper-1's own `pricing.prompt`
    # exactly equals its documented $0.006/minute; deepgram/aura-2's
    # exactly equals its documented $0.030/1,000 chars). The existing
    # *_price_per_mtok fields stay meaningless for these — reusing them
    # would silently misrepresent the unit — so these two are genuinely
    # separate columns, populated only for the one capability each
    # applies to (mutually exclusive: an entry is never both).
    # gpt-4o-transcribe-style genuinely-per-token transcription models
    # are the one real exception (checked live: reports a real
    # tokenizer, "GPT" not "Other", and its own prompt/completion
    # prices exactly match OpenAI's published per-token rate) — those
    # keep using input_price_per_mtok/output_price_per_mtok like a
    # normal chat model instead of this column.
    price_per_minute: Mapped[float | None] = mapped_column(Numeric(12, 6))
    price_per_character: Mapped[float | None] = mapped_column(Numeric(12, 8))


class ModelProfile(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F12.9/F12.10 — named preset of tier bindings + per-stage
    overrides. tier_bindings/stage_overrides store catalog-entry UUIDs
    as JSONB values; Postgres cannot enforce referential integrity into
    a JSON blob, so the API layer validates these against
    model_catalog_entries at write time (capability preflight, F12.11)
    — a known v1 limitation, acceptable because bindings are only ever
    written through that one validated path."""

    __tablename__ = "model_profiles"

    name: Mapped[str] = mapped_column(String(120), nullable=False)  # e.g. "openrouter-budget"
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    tier_bindings: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    stage_overrides: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)


class EmbeddingIndex(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F12.15 — a change of embedding model is a migration, not a
    column edit: keyed by (model, dimension), old index keeps serving
    until the new one finishes building and cuts over."""

    __tablename__ = "embedding_indexes"

    model_catalog_entry_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("model_catalog_entries.id", ondelete="RESTRICT"), nullable=False
    )
    dimension: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="building")  # EmbeddingIndexStatus
    vector_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cutover_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class LlmCall(UUIDPKMixin, Base):
    """F13.1-F13.7 — the cost ledger. One row per call, written by a
    LangChain callback handler at the framework boundary so no call
    site can forget to log (§13.1). No TimestampMixin: `created_at`
    here IS the call time, and this table is append-only — nothing
    about a logged call is ever updated.

    cost_usd is computed at call time from the catalog's pricing and
    stamped with pricing_version (F13.3) so historical rows never
    shift when a provider changes prices later. cost_known mirrors the
    catalog entry's pricing_known at call time (F13.6) — an unpriced
    model logs real tokens/latency, never a silent zero.
    """

    __tablename__ = "llm_calls"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    agent_run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_runs.id", ondelete="SET NULL")
    )
    agent_step_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_steps.id", ondelete="SET NULL")
    )
    # M1 §7 — direct FKs rather than a generic related_type/related_id
    # polymorphic pair: "cost per newly discovered/scored job" and
    # per-SourceRun breakdowns are the two M1-specific rollups that
    # agent_run_id/stage alone can't answer, and both are common enough
    # relationships to earn a real column rather than a generic one.
    job_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="SET NULL")
    )
    source_run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("source_runs.id", ondelete="SET NULL")
    )
    stage: Mapped[str | None] = mapped_column(String(120))  # e.g. "fit-scoring-agent"
    subagent_name: Mapped[str | None] = mapped_column(String(120))
    provider: Mapped[str] = mapped_column(String(30), nullable=False)
    model_id: Mapped[str] = mapped_column(String(200), nullable=False)
    tier: Mapped[str | None] = mapped_column(String(20))  # ModelTier

    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cache_read_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cache_write_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    reasoning_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    latency_ms: Mapped[int | None] = mapped_column(Integer)

    cost_usd: Mapped[float] = mapped_column(Numeric(12, 6), nullable=False, default=0)
    pricing_version: Mapped[str | None] = mapped_column(String(40))
    cost_known: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    fallback_from_model: Mapped[str | None] = mapped_column(String(200))  # F12.7 substitution record
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="ok")  # ok / error
    error_message: Mapped[str | None] = mapped_column(Text)
    provider_request_id: Mapped[str | None] = mapped_column(String(200))

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class AudioSettings(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """Phase 11 (v2 plan) — admin's chosen STT/TTS model + voice for
    interview practice, surfaced on the Models & Providers page next to
    tier bindings. Exactly one row for the whole deployment is ever
    meant to exist (get-or-create in the router, same "not really
    per-user" treatment ProviderConnection already gets in
    interview_media.py's own _find_connection — user_id here just
    records who last edited it, not who it's scoped to). Both catalog
    FKs are nullable and SET NULL on delete: an admin removing the
    connection/model currently selected here just falls back to
    interview_media.py's own hardcoded defaults rather than breaking
    interview practice outright."""

    __tablename__ = "audio_settings"

    transcribe_catalog_entry_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("model_catalog_entries.id", ondelete="SET NULL")
    )
    speech_catalog_entry_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("model_catalog_entries.id", ondelete="SET NULL")
    )
    speech_voice: Mapped[str | None] = mapped_column(String(80))


class Budget(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F13.8 — run/daily/monthly caps with soft and hard thresholds."""

    __tablename__ = "budgets"

    scope: Mapped[str] = mapped_column(String(20), nullable=False)  # BudgetScope
    soft_threshold_usd: Mapped[float | None] = mapped_column(Numeric(10, 2))
    hard_threshold_usd: Mapped[float | None] = mapped_column(Numeric(10, 2))
    consumed_usd: Mapped[float] = mapped_column(Numeric(10, 4), nullable=False, default=0)
    period_start: Mapped[date | None] = mapped_column(Date)
    action_on_breach: Mapped[str] = mapped_column(String(20), nullable=False, default="warn")  # warn / halt
