"""F5 — document tailoring and the truthfulness guarantee.

JobGroup, JobGroupMember, Document, ClaimVerification.
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from applicient_api.db import Base, TimestampMixin, UUIDPKMixin, UserScopedMixin


class JobGroup(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F5.10 — a user-named collection of scored jobs that one tailored
    CV is generated against, so one document can serve every listing in
    the group instead of one document per listing. Manual only for
    now — membership is user-assigned (JobGroupMember below); grouping
    jobs automatically by similarity is an explicit, deferred
    follow-up (Adrian's own call), not built here."""

    __tablename__ = "job_groups"

    persona_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("personas.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)


class JobGroupMember(UUIDPKMixin, TimestampMixin, Base):
    """A job may belong to more than one group (e.g. a role that fits
    both a "Backend" and a "Singapore relocation" grouping) — plain
    many-to-many, not a job-owns-one-group model."""

    __tablename__ = "job_group_members"
    __table_args__ = (
        UniqueConstraint("job_group_id", "job_id", name="uq_job_group_members_group_job"),
    )

    job_group_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("job_groups.id", ondelete="CASCADE"), nullable=False
    )
    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False
    )


class SkillGapItem(UUIDPKMixin, TimestampMixin, Base):
    """F5.13 — a skill the job group's member listings ask for that the
    persona's evidence bank doesn't yet cover, as a checkable to-do
    item. No LLM call needed to compute this: `FitScore.skills_missing`
    (F4's existing rubric output) already names exactly this per job,
    so the gap is just the deduplicated union of that across the
    group's members — reusing data that's already paid for and
    persisted, not a new agent step.

    Checking one off (`status="done"`) records a real, self-attested
    `EvidenceItem` (category="skill") rather than editing CV text
    directly — the next tailoring pass can then honestly cite it
    through the same evidence-linked, verified pipeline as everything
    else (F5.4 is never bypassed for a checked-off skill)."""

    __tablename__ = "skill_gap_items"
    __table_args__ = (
        UniqueConstraint("job_group_id", "skill_text", name="uq_skill_gap_items_group_skill"),
    )

    job_group_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("job_groups.id", ondelete="CASCADE"), nullable=False
    )
    skill_text: Mapped[str] = mapped_column(String(250), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")  # pending | done
    evidence_item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("evidence_items.id", ondelete="SET NULL")
    )


class Document(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F5.1/F5.8 — a JSON delta against the master profile, rendered by
    deterministic renderers (F5.2), versioned and bound to the profile
    revision that produced it. Cannot export until a passing
    ClaimVerification exists for this revision (F5.4/F5.5) — enforced
    in application logic, not the schema, but `verified` is kept
    denormalized here for fast list-view queries.

    Bound to a JobGroup, not a single Job (F5.10, M3 redesign) — a
    single-job CV is just a group of one, no separate path for it."""

    __tablename__ = "documents"

    job_group_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("job_groups.id", ondelete="CASCADE"), nullable=False
    )
    persona_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("personas.id", ondelete="CASCADE"), nullable=False
    )
    profile_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    doc_type: Mapped[str] = mapped_column(String(20), nullable=False)  # DocumentType
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    json_delta: Mapped[dict] = mapped_column(JSONB, nullable=False)
    # F5.2/F5.11 — a map of renderer name to object-storage key (e.g.
    # {"latex_pdf": "...", "html_pdf": "..."}), not a fixed pdf/docx
    # column pair: F5.2 asks for two PDF renderers (LaTeX and
    # HTML/CSS), neither of them a DOCX, so a closed pair of
    # differently-typed columns never matched what this table actually
    # needed to hold.
    rendered_keys: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # Raised by Adrian: the AI-generated CV is a draft, not a final
    # answer — the user must be able to hand-edit it. Keyed by
    # template id (a document can have more than one template's tex
    # edited independently), mapping to a raw .tex source string that
    # — when present — the renderer compiles directly instead of
    # regenerating from json_delta. Manual edits are never re-run
    # through the claim verifier (F5.4); once a human's hands are on
    # the text, that's their call, not the gate's — stated plainly,
    # not silently assumed equivalent to AI-authored content.
    tex_overrides: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
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
