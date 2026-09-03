"""Phase 11 (v2 plan) — AI interview/FGD/LGD practice. One session per
practice run, turn-by-turn state (question/answer/audio) not stored
here at all — `AgentRun`/`RunEvent` (models/agents.py) already are the
durable per-step log every other agent in this codebase uses, so this
table only carries what's true about the *session* as a whole: who
it's for, what it's targeting, and — once it ends — its score.

Targeting is deliberately flexible, not just "a job or a role": a
session can be grounded in a real job listing (`job_id`), a free-text
role, a free-text company, both free-text fields together, or a role
alone — any combination, none required to pair with another (raised
directly by Adrian). When `job_id` is set, `role_title`/`company_name`
are denormalized from the job at creation time (same reasoning
CalendarEvent's router derives `job_id` from `application_id` —
routers/calendar_events.py:69-71 — one real source of truth, not two
that can drift)."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Numeric, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from applicient_api.db import Base, TimestampMixin, UUIDPKMixin, UserScopedMixin


class InterviewSession(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    __tablename__ = "interview_sessions"

    persona_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("personas.id", ondelete="CASCADE"), nullable=False
    )
    # Both nullable/independent, same pattern as CalendarEvent
    # (models/calendar.py) — a session can target a real listing, or
    # not exist at all if the user practiced from a free-text role/company.
    job_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="SET NULL"))
    application_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("applications.id", ondelete="SET NULL")
    )
    role_title: Mapped[str | None] = mapped_column(String(200))
    company_name: Mapped[str | None] = mapped_column(String(200))
    seniority: Mapped[str | None] = mapped_column(String(20))  # SENIORITY_OPTIONS vocabulary (Preferences)

    practice_type: Mapped[str] = mapped_column(String(20), nullable=False)  # interview | fgd | lgd
    # Interview-only — screening/hr/user/role/experience/all
    # (schemas.INTERVIEW_CATEGORIES). Null for fgd/lgd: the agent picks
    # its own case/topic there instead of a user-chosen category.
    category: Mapped[str | None] = mapped_column(String(20))

    # LangGraph checkpointer key — mirrors OrchestratorConversation.thread_id
    # exactly (models/agents.py), including reusing the SAME shared
    # AsyncPostgresSaver instance (get_checkpointer(), orchestrator_service.py).
    thread_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="in_progress")  # in_progress | completed | cancelled

    overall_score: Mapped[float | None] = mapped_column(Numeric(5, 2))
    feedback: Mapped[dict | None] = mapped_column(JSONB)  # structured InterviewFeedbackOutput, written once at end
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
