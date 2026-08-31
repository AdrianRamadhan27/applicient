"""§13.1 — agent run tracing. AgentRun, AgentStep.

Mirrored into Postgres so the Run Console works without LangSmith
configured (§13.1) — this is the fallback observability path, not a
duplicate of it.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from applicient_api.db import Base, TimestampMixin, UUIDPKMixin, UserScopedMixin


class AgentRun(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    __tablename__ = "agent_runs"

    run_type: Mapped[str] = mapped_column(String(60), nullable=False)  # "radar", "composer", "application", ...
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="running")  # AgentRunStatus
    model_profile_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("model_profiles.id", ondelete="SET NULL")
    )
    # M1 §3 — "snapshot the active model profile and profile revision
    # on the run": model_profile_id above already snapshots which
    # ModelProfile was active; these two snapshot which persona and
    # which Profile.revision the run scored against, so a later
    # profile edit can never retroactively change what an old run
    # says it did.
    saved_search_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("saved_searches.id", ondelete="SET NULL")
    )
    persona_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("personas.id", ondelete="SET NULL")
    )
    profile_revision: Mapped[int | None] = mapped_column(Integer)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    total_cost_usd: Mapped[float] = mapped_column(Numeric(10, 4), nullable=False, default=0)
    budget_cap_usd: Mapped[float | None] = mapped_column(Numeric(10, 4))
    # M7 — which OrchestratorConversation this turn belongs to, if any.
    # Deliberately NOT how the conversation itself is tracked (see
    # OrchestratorConversation below) — a conversation is long-lived
    # and never "finishes" the way a run does, so it gets its own
    # durable row instead of one AgentRun left `status="running"`
    # forever, which would need every existing reader of this table
    # (Run Console, reconcile_stale_attempts's own stale-run sweep) to
    # special-case it. One ordinary, bounded AgentRun per chat turn.
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orchestrator_conversations.id", ondelete="SET NULL")
    )


class OrchestratorConversation(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """M7 — the durable, always-alive container for one ongoing chat
    with the orchestrator agent (`agents/src/applicient_agents/
    orchestrator_agent.py`). One per persona (enforced at the service
    layer, not a DB constraint, in case a second is ever genuinely
    wanted later). `thread_id` is the LangGraph checkpointer's own
    thread identity — a real, persistent `PostgresSaver` (not the
    `InMemorySaver` application_service.py uses for one attempt) keyed
    by this, since a conversation is meant to span days, not one
    session."""

    __tablename__ = "orchestrator_conversations"

    persona_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("personas.id", ondelete="CASCADE"), nullable=False
    )
    thread_id: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")  # active / archived
    title: Mapped[str | None] = mapped_column(String(200))
    # The interrupt currently blocking this conversation, if any —
    # {"requests": [...]}, same shape application_service.py's own
    # _interrupt_data produces. Set when a turn's stream yields
    # __interrupt__, cleared once a resume call proceeds past it. This
    # is what the two API endpoints (send a message vs. resume) branch
    # on to reject a call made in the wrong mode.
    pending_interrupt: Mapped[dict | None] = mapped_column(JSONB)
    last_active_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class RunEvent(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """Durable record of every SSE progress event a run ever emitted —
    raised directly by Adrian after finding that navigating away from
    an in-progress radar run and back showed only `status: "running"`
    with none of the live log lines or per-job score events that had
    already streamed, because those only ever existed on the one HTTP
    connection open at the time and were never written down anywhere.
    `seq` is a per-run monotonic counter (not `created_at`, which two
    events in the same transaction could tie) so a reconnecting client
    can ask for "everything after seq N" and get a gap-free replay,
    then keep polling the same endpoint for new rows while
    `AgentRun.status == "running"` to approximate a live reconnect
    without a second live-push channel (no pub/sub broker is wired
    into this codebase yet; Postgres is already the source of truth
    for the run itself, so it doubles as the event log too)."""

    __tablename__ = "run_events"

    agent_run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    event_type: Mapped[str] = mapped_column(String(40), nullable=False)
    data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)

    __table_args__ = (UniqueConstraint("agent_run_id", "seq", name="uq_run_events_run_seq"),)


class AgentStep(UUIDPKMixin, Base):
    """No TimestampMixin — started_at/finished_at below are the
    meaningful timestamps for a step in a trace."""

    __tablename__ = "agent_steps"

    agent_run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False
    )
    parent_step_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_steps.id", ondelete="CASCADE")
    )  # subagent dispatch nesting — the `task` tool call this step ran under
    subagent_name: Mapped[str | None] = mapped_column(String(120))
    step_type: Mapped[str] = mapped_column(String(30), nullable=False)  # tool_call / task_dispatch / interrupt
    input_summary: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    output_summary: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cost_usd: Mapped[float] = mapped_column(Numeric(10, 5), nullable=False, default=0)
