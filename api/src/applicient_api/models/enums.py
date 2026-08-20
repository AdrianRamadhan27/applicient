"""Shared enums.

Stored as plain VARCHAR + CHECK constraint (SQLAlchemy Enum with
native_enum=False), not native Postgres ENUM types — adding a value to
a native enum needs ALTER TYPE ... ADD VALUE, which cannot run inside
a transaction block pre-PG12 and still complicates rollback. A CHECK
constraint is a normal, easily-reversible migration.
"""

import enum


class Recommendation(str, enum.Enum):
    """F4.9"""

    STRONG_APPLY = "strong_apply"
    APPLY = "apply"
    STRETCH = "stretch"
    SKIP = "skip"


class ApplicationState(str, enum.Enum):
    """F7.2"""

    DISCOVERED = "discovered"
    SHORTLISTED = "shortlisted"
    PREPARING = "preparing"
    READY = "ready"
    APPLIED = "applied"
    ACKNOWLEDGED = "acknowledged"
    SCREENING = "screening"
    ASSESSMENT = "assessment"
    INTERVIEW = "interview"
    OFFER = "offer"
    REJECTED = "rejected"
    WITHDRAWN = "withdrawn"
    GHOSTED = "ghosted"  # derived (F7.3), but still a real state to filter/display on


class ClaimVerdict(str, enum.Enum):
    """F5.4"""

    SUPPORTED = "supported"
    REFRAMED_OK = "reframed_ok"
    UNSUPPORTED = "unsupported"
    INFLATED = "inflated"


class AutonomyLevel(str, enum.Enum):
    """F6.1"""

    L0_MANUAL = "l0_manual"
    L1_ANSWER_PACK = "l1_answer_pack"
    L2_FILL_REVIEW = "l2_fill_review"
    L3_FILL_SUBMIT = "l3_fill_submit"


class EmailClassification(str, enum.Enum):
    """F8.3"""

    CONFIRMATION = "confirmation"
    REJECTION = "rejection"
    INTERVIEW_INVITE = "interview_invite"
    ASSESSMENT_INVITE = "assessment_invite"
    OFFER = "offer"
    RECRUITER_OUTREACH = "recruiter_outreach"
    SCHEDULING_REQUEST = "scheduling_request"
    INFORMATION_REQUEST = "information_request"
    IRRELEVANT = "irrelevant"


class SourceTier(str, enum.Enum):
    """F2.2-F2.4"""

    TIER1_API = "tier1_api"
    TIER2_PORTAL = "tier2_portal"
    TIER3_SOCIAL = "tier3_social"


class ApplyVia(str, enum.Enum):
    """F2.4"""

    DM = "dm"
    EMAIL = "email"
    FORM = "form"
    LINK = "link"


class ModelTier(str, enum.Enum):
    """§7.5"""

    FAST = "fast"
    BALANCED = "balanced"
    DEEP = "deep"
    EMBEDDING = "embedding"


class ProviderType(str, enum.Enum):
    """F12.3"""

    OPENROUTER = "openrouter"
    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    GOOGLE = "google"
    MISTRAL = "mistral"
    OLLAMA = "ollama"
    OPENAI_COMPATIBLE = "openai_compatible"


class ConnectionStatus(str, enum.Enum):
    """§7.5"""

    UNTESTED = "untested"
    OK = "ok"
    AUTH_FAILED = "auth_failed"
    UNREACHABLE = "unreachable"


class NotificationChannel(str, enum.Enum):
    """§3.1"""

    IN_APP = "in_app"
    EMAIL = "email"
    TELEGRAM = "telegram"
    DISCORD = "discord"


class EventActor(str, enum.Enum):
    """F7.4"""

    AGENT = "agent"
    EMAIL = "email"
    USER = "user"


class BudgetScope(str, enum.Enum):
    """F13.8"""

    RUN = "run"
    DAILY = "daily"
    MONTHLY = "monthly"


class AgentRunStatus(str, enum.Enum):
    RUNNING = "running"
    WAITING_ON_HUMAN = "waiting_on_human"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class DocumentType(str, enum.Enum):
    CV = "cv"
    COVER_LETTER = "cover_letter"
    ANSWER_PACK = "answer_pack"


class EmbeddingIndexStatus(str, enum.Enum):
    """F12.15 — a change of embedding model is a migration, not a swap."""

    BUILDING = "building"
    ACTIVE = "active"
    RETIRED = "retired"


class LedgerSource(str, enum.Enum):
    """F9.1-F9.3"""

    CSV_IMPORT = "csv_import"
    EMAIL_DERIVED = "email_derived"
    MANUAL = "manual"


class EvidenceCategory(str, enum.Enum):
    """F1.2 — user feedback from the first real CV parse (step 6 log):
    a flat evidence list without a category conflates work experience
    with education/certifications/skills, and reads as messier than it
    is. Not a separate table per category (see the log) — one table,
    filterable/groupable by this field, since downstream consumers
    (tailoring, claim verifier) want "all evidence for this profile"
    uniformly regardless of type."""

    EXPERIENCE = "experience"
    EDUCATION = "education"
    CERTIFICATION = "certification"
    PROJECT = "project"
    ACHIEVEMENT = "achievement"
    SKILL = "skill"
    OTHER = "other"


class PrefilterDecision(str, enum.Enum):
    """M1 §5 — the cheap fast-tier pass. Persisted separately from
    FitScore (a distinct contract, PrefilterResult) so a dropped
    posting's reasoning survives for audit even though it never
    reaches the expensive full rubric."""

    KEEP = "keep"
    DROP = "drop"
    REVIEW = "review"


class SourceRunStatus(str, enum.Enum):
    """M1 §3 — lets a resumed radar run know what source/query work is
    already done rather than restarting from zero."""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
