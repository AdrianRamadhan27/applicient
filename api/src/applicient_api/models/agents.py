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
