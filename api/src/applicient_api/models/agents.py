"""§13.1 — agent run tracing. AgentRun, AgentStep.

Mirrored into Postgres so the Run Console works without LangSmith
configured (§13.1) — this is the fallback observability path, not a
duplicate of it.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Numeric, String, Text
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
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    total_cost_usd: Mapped[float] = mapped_column(Numeric(10, 4), nullable=False, default=0)
    budget_cap_usd: Mapped[float | None] = mapped_column(Numeric(10, 4))


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
