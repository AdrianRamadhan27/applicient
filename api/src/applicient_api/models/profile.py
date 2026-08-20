"""F1 — Profile and knowledge base. User, Profile, Persona, EvidenceItem, Preference."""

import uuid
from datetime import date, datetime

from pgvector.sqlalchemy import HALFVEC
from sqlalchemy import Boolean, Date, DateTime, Enum, ForeignKey, Index, Integer, Numeric, String, Text, text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from applicient_api.db import Base, TimestampMixin, UUIDPKMixin, UserScopedMixin

# Dimension of the shipped default embedding model, nvidia/nemotron-3-embed-1b:free
# (PRD §7.5 / §17). Changing the embedding model is a migration (F12.15),
# not a column edit — see EmbeddingIndex in llm.py.
EMBED_DIM = 2048


class User(UUIDPKMixin, TimestampMixin, Base):
    """v1 is single-user/local-first, no auth (PRD §3.1) — this table
    exists so every other table's user_id has something to point at,
    and so multi-tenancy is an auth layer later, not a migration."""

    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)


class Profile(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """Versioned (F1.3) — generated documents bind to the revision that
    produced them (PRD §9)."""

    __tablename__ = "profiles"

    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    raw_cv_object_key: Mapped[str | None] = mapped_column(String(512))
    parsed_profile: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    parsed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # F1.4 preferences fields not tied to a persona (visa, notice period are
    # profile-level facts about the person; persona-scoped targeting lives
    # in Preference below).
    visa_status: Mapped[str | None] = mapped_column(String(120))
    notice_period_days: Mapped[int | None] = mapped_column(Integer)


class Persona(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F1.5 — multiple role tracks over one profile. Expected count is
    2-3 (PRD §3.1), so this stays a flat table, not a hierarchy."""

    __tablename__ = "personas"

    profile_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    base_cv_template: Mapped[str] = mapped_column(String(120), nullable=False, default="ats-plain")
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class EvidenceItem(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F1.2 — atomic, individually-citable accomplishment records. The
    tailoring agent selects from these and every generated bullet must
    link back to one (F5.3); the claim verifier checks against these
    and nothing else (F5.4)."""

    __tablename__ = "evidence_items"
    __table_args__ = (
        # halfvec(2048), not vector — pgvector's HNSW caps `vector` at
        # 2000 dims (verified: docs/IMPLEMENTATION.md step 2 log).
        Index(
            "ix_evidence_items_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "halfvec_l2_ops"},
        ),
    )

    profile_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    text: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(String(20), nullable=False, default="other", index=True)  # EvidenceCategory
    # The specific role/degree/certificate/project name — e.g. "Machine
    # Learning Cohort", "AI Engineer Intern", "B.Sc. Computer Science".
    # Kept distinct from employer (the organization) rather than folded
    # into it: a CV that reads "Bangkit Academy — Machine Learning
    # Cohort" was, before this field existed, parsed with the whole
    # string jammed into `employer` because there was nowhere else to
    # put it. Also what lets two roles at the same employer (a
    # promotion) read as two distinct blocks instead of one.
    title: Mapped[str | None] = mapped_column(String(250))
    skills: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    metrics: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    employer: Mapped[str | None] = mapped_column(String(200))
    date_start: Mapped[date | None] = mapped_column(Date)
    date_end: Mapped[date | None] = mapped_column(Date)  # null = ongoing
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    embedding: Mapped[list[float] | None] = mapped_column(HALFVEC(EMBED_DIM))

    @property
    def embedded(self) -> bool:
        """Whether semantic retrieval can use this evidence item.

        The vector itself is intentionally never serialized through the API;
        callers only need this boolean to show the user whether an item is
        ready for downstream agents.
        """

        return self.embedding is not None


class Preference(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    """F1.4 — per-persona search/filter criteria."""

    __tablename__ = "preferences"

    persona_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("personas.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    target_roles: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    seniority: Mapped[str | None] = mapped_column(String(60))
    salary_floor: Mapped[float | None] = mapped_column(Numeric(14, 2))
    salary_target: Mapped[float | None] = mapped_column(Numeric(14, 2))
    salary_currency: Mapped[str] = mapped_column(String(3), nullable=False, default="IDR")
    locations: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    remote_policy: Mapped[str | None] = mapped_column(String(60))
    industries_include: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    industries_exclude: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    company_size_pref: Mapped[str | None] = mapped_column(String(60))
    deal_breakers: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
