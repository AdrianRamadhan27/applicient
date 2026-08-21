"""Pydantic DTOs for the provider/model-catalog layer (F12). Thin for
now — just what the connection service and the eventual API routes
need; the API routes keep the transport layer separate from these DTOs.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class ProviderConnectionCreate(BaseModel):
    provider: str
    api_key: str
    base_url: str | None = None
    label: str | None = None


class ProviderConnectionOut(BaseModel):
    """Never includes the raw or encrypted key — api_key_hint only
    (F12.6)."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    provider: str
    label: str | None
    api_key_hint: str | None
    base_url: str | None
    status: str
    last_verified_at: datetime | None
    last_error: str | None


class ModelCatalogEntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    model_id: str
    display_name: str | None
    context_window: int | None
    max_output: int | None
    capabilities: list[str]
    input_price_per_mtok: float | None
    output_price_per_mtok: float | None
    cache_read_price_per_mtok: float | None
    cache_write_price_per_mtok: float | None
    pricing_version: str | None
    pricing_known: bool
    fetched_at: datetime


# --- F1 Profile / EvidenceItem (step 4 CRUD stubs) ---


class ParsedProfile(BaseModel):
    """Schema-validated candidate-level data produced by CV ingest."""

    full_name: str | None = None
    headline: str | None = None
    email: str | None = None
    phone: str | None = None
    location: str | None = None
    links: list[str] = Field(default_factory=list)
    summary: str | None = None
    skills: list[str] = Field(default_factory=list)


class ProfileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user_id: uuid.UUID
    revision: int
    confirmed: bool
    parsed_profile: ParsedProfile
    parsed_at: datetime | None
    visa_status: str | None
    notice_period_days: int | None


class ProfileUpdate(BaseModel):
    confirmed: bool | None = None
    parsed_profile: ParsedProfile | None = None
    visa_status: str | None = None
    notice_period_days: int | None = None


class EvidenceItemCreate(BaseModel):
    category: str = "other"  # EvidenceCategory
    title: str | None = None
    text: str
    skills: list[str] = Field(default_factory=list)
    metrics: dict = Field(default_factory=dict)
    employer: str | None = None
    date_start: str | None = None  # ISO date string; parsed at the route boundary
    date_end: str | None = None


class EvidenceItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    profile_id: uuid.UUID
    category: str
    title: str | None
    text: str
    skills: list[str]
    metrics: dict
    employer: str | None
    date_start: date | None
    date_end: date | None
    verified: bool
    embedded: bool


class CVParseResult(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    agent_run_id: uuid.UUID
    profile: ProfileOut
    evidence_items: list[EvidenceItemOut]
    cost_usd: float


class EvidenceItemUpdate(BaseModel):
    category: str | None = None
    title: str | None = None
    text: str | None = None
    skills: list[str] | None = None
    metrics: dict | None = None
    employer: str | None = None
    date_start: str | None = None
    date_end: str | None = None
    verified: bool | None = None


# --- F12 model routing (minimal GUI-managed preset) ---


class ModelProfileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    is_active: bool
    tier_bindings: dict[str, str]
    stage_overrides: dict[str, str]


class ModelProfileUpdate(BaseModel):
    name: str = Field(default="openrouter-budget", max_length=120)
    tier_bindings: dict[str, uuid.UUID]
    stage_overrides: dict[str, uuid.UUID] = Field(default_factory=dict)


# --- F13 Cost & Usage (minimal, step 7) ---


class LlmCallOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    agent_run_id: uuid.UUID | None
    job_id: uuid.UUID | None
    source_run_id: uuid.UUID | None
    stage: str | None
    subagent_name: str | None
    provider: str
    model_id: str
    tier: str | None
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    cost_usd: float
    cost_known: bool
    # F12.7/F13.3 — preserved on every row so a later price change or a
    # mid-run fallback never becomes invisible in the aggregate view;
    # both were already stamped at write time (metering.py), just not
    # surfaced through the API until this v1 dashboard needed them.
    pricing_version: str | None
    fallback_from_model: str | None
    status: str
    error_message: str | None
    latency_ms: int | None
    created_at: datetime


class CostSummary(BaseModel):
    total_cost_usd: float
    total_calls: int
    unknown_cost_calls: int
    total_input_tokens: int
    total_output_tokens: int
    by_stage: dict[str, float]
    by_tier: dict[str, float]
    by_provider: dict[str, float]
    by_model: dict[str, float]
    by_source: dict[str, float]
    # None when no call in the filtered set carries a job_id — never a
    # misleading $0.00 for "we don't have this number."
    cost_per_scored_job: float | None
    recent_calls: list[LlmCallOut]


class CostRunOut(BaseModel):
    """One row in the Cost & Usage run-history list — every run type
    (radar, cv-parse, ...), not just radar, since LlmCall.agent_run_id
    is populated the same way for all of them."""

    id: uuid.UUID
    run_type: str
    status: str
    started_at: datetime
    finished_at: datetime | None
    total_cost_usd: float
    call_count: int
    saved_search_id: uuid.UUID | None


class AgentStepOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    step_type: str
    subagent_name: str | None
    input_summary: dict
    output_summary: dict
    started_at: datetime
    finished_at: datetime | None
    cost_usd: float


class AgentRunDetailOut(BaseModel):
    """§8/Run Console — the generic per-run trace: every `AgentStep`
    this run wrote (source_run/embedding/scoring for radar, extracting/
    parsing/etc. for cv-parse), independent of run_type. This is a
    coarser-grained trace than radar.py's own RunEvent replay (one row
    per meaningful phase, not one per SSE frame) — deliberately so:
    Run Console's job (models/agents.py's own docstring) is a
    LangSmith-free fallback trace view across every run type, not a
    duplicate of Radar's own live per-event view."""

    id: uuid.UUID
    run_type: str
    status: str
    started_at: datetime
    finished_at: datetime | None
    total_cost_usd: float
    saved_search_id: uuid.UUID | None
    persona_id: uuid.UUID | None
    profile_revision: int | None
    steps: list[AgentStepOut]


# --- M1 §3 Persona / Source / SavedSearch / radar run ---


class PersonaOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    profile_id: uuid.UUID
    name: str
    base_cv_template: str
    active: bool


class PersonaCreate(BaseModel):
    name: str
    base_cv_template: str = "ats-plain"


class PersonaUpdate(BaseModel):
    name: str | None = None
    base_cv_template: str | None = None
    active: bool | None = None


# --- M2 §1/§2 Preferences (F1.4/F1.9) ---


class PreferenceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    persona_id: uuid.UUID
    target_roles: list[str]
    seniority: list[str]
    salary_floor: float | None
    salary_target: float | None
    salary_currency: str
    locations: list[str]
    willing_to_relocate: bool
    remote_policy: list[str]
    industries_include: list[str]
    industries_exclude: list[str]
    company_size_pref: list[str]
    deal_breakers: list[str]


class PreferenceUpsert(BaseModel):
    """Every field optional — an unset field means "no opinion," not
    an error (M2 §2's own stated decision: preferences don't carry a
    CV-parse-style confirm gate, since every one of them is optional
    by nature). PATCH-shaped semantics via `exclude_unset` even though
    this backs a PUT-style upsert route, since the row may not exist
    yet on first save."""

    target_roles: list[str] | None = None
    seniority: list[str] | None = None
    salary_floor: float | None = None
    salary_target: float | None = None
    salary_currency: str | None = None
    locations: list[str] | None = None
    willing_to_relocate: bool | None = None
    remote_policy: list[str] | None = None
    industries_include: list[str] | None = None
    industries_exclude: list[str] | None = None
    company_size_pref: list[str] | None = None
    deal_breakers: list[str] | None = None


# --- M2 §5 CompanyCandidate (F2.10) ---


class CompanyCandidateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    persona_id: uuid.UUID
    company_name: str
    origin: str
    rationale: str | None
    status: str
    resolved_identifier: str | None
    discovered_url: str | None
    approved: bool
    origin_job_id: uuid.UUID | None


class CompanyCandidateUpdate(BaseModel):
    approved: bool


class SourceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    tier: str
    adapter_key: str
    config: dict  # secrets stripped — see source_connections.sanitized_config
    rate_limit_config: dict
    enabled: bool
    circuit_breaker_tripped: bool
    status: str
    last_verified_at: datetime | None
    last_error: str | None


class SourceCreate(BaseModel):
    name: str
    tier: str
    adapter_key: str
    config: dict = Field(default_factory=dict)
    rate_limit_config: dict = Field(default_factory=dict)
    enabled: bool = True


class SourceUpdate(BaseModel):
    name: str | None = None
    tier: str | None = None
    config: dict | None = None
    rate_limit_config: dict | None = None
    enabled: bool | None = None


class SavedSearchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    persona_id: uuid.UUID
    name: str
    role_titles: list[str]
    source_ids: list[uuid.UUID]
    filters: dict
    schedule_cron: str | None
    active: bool


class SavedSearchCreate(BaseModel):
    persona_id: uuid.UUID
    name: str
    role_titles: list[str]
    source_ids: list[uuid.UUID]
    filters: dict = Field(default_factory=dict)


class SavedSearchUpdate(BaseModel):
    name: str | None = None
    role_titles: list[str] | None = None
    source_ids: list[uuid.UUID] | None = None
    filters: dict | None = None
    active: bool | None = None


class SourceRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    source_id: uuid.UUID
    status: str
    expanded_queries: dict
    started_at: datetime
    finished_at: datetime | None
    postings_seen: int
    postings_new: int
    postings_deduped: int
    company_breakdown: dict
    errors: list
    cost_usd: float


class RadarRunResult(BaseModel):
    agent_run_id: uuid.UUID
    status: str
    source_runs: list[SourceRunOut]
    cost_usd: float


class AgentRunOut(BaseModel):
    """M1 §3 follow-up, raised by Adrian: a completed run's state only
    ever lived in the browser's React state before this — navigate
    away and it was gone, even though the AgentRun/SourceRun rows
    were sitting in Postgres the whole time. This is what lets the
    Radar screen re-hydrate a saved search's last run on page load
    instead of only ever showing live SSE state."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    status: str
    started_at: datetime
    finished_at: datetime | None
    total_cost_usd: float
    source_runs: list[SourceRunOut]


class RunEventOut(BaseModel):
    """One durably-persisted SSE event (radar.py's `_emit`) — `seq` is
    the replay cursor, `event_type`/`data` reconstruct the exact same
    shape the live SSE stream sent (`{type: event_type, ...data}`,
    same "done" special-case the frontend's live parser already
    applies) so a reconnecting client's event-application logic never
    needs to know whether an event arrived live or replayed."""

    model_config = ConfigDict(from_attributes=True)

    seq: int
    event_type: str
    data: dict
    created_at: datetime


class RunEventsOut(BaseModel):
    run_status: str
    events: list[RunEventOut]


class JobSummaryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    company_name_raw: str
    location: str | None
    remote_policy: str | None
    salary_min: float | None
    salary_max: float | None
    salary_currency: str | None
    apply_url: str | None
    posted_at: datetime | None
    ghost_job_score: float | None
    ghost_job_reasons: list[str]


class FitScoreOut(BaseModel):
    """M1 §6 — the full audit trail behind one recommendation, never a
    bare number (§14 exit bar). `hard_blocker`/`salary_overlap` etc.
    stay nullable-and-distinct-from-a-value on purpose (see
    scoring.py's own column comments) — the drawer must show "not
    stated"/"unknown", never coerce that to a score of zero."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    recommendation: str
    overall_score: float
    hard_requirements_met: int
    hard_requirements_total: int
    hard_blocker: str | None
    experience_delta_years: float | None
    skills_matched: list[str]
    skills_partial: list[str]
    skills_missing: list[str]
    seniority_fit: str | None
    domain_fit: str | None
    location_fit: str | None
    salary_overlap: str | None
    company_stage_fit: str | None
    language_fit: str | None
    evidence_spans: list[dict]
    gap_closers: str | None
    red_flags: list
    scoring_version: str
    model_used: str | None
    cost_usd: float
    created_at: datetime


class PrefilterResultOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    decision: str
    reason: str
    prefilter_version: str
    created_at: datetime


class JobSightingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    source_id: uuid.UUID
    source_name: str
    adapter_key: str
    source_url: str
    external_requisition_id: str | None
    first_seen_at: datetime
    last_seen_at: datetime
    posted_at_on_source: datetime | None


class InboxJobOut(BaseModel):
    """One card in the ranked Job Inbox (M1 §6) — the latest FitScore
    for the requested persona, if the job has been scored yet for it.
    `fit_score: None` means genuinely unscored (still in the backlog,
    or the prefilter dropped it and no rubric row exists) — the
    frontend must render that as its own state, never as a 0 score."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    company_name_raw: str
    location: str | None
    remote_policy: str | None
    employment_type: str | None
    seniority: str | None
    salary_min: float | None
    salary_max: float | None
    salary_currency: str | None
    apply_url: str | None
    posted_at: datetime | None
    ghost_job_score: float | None
    ghost_job_reasons: list[str]
    repost_count: int
    fit_score: FitScoreOut | None
    prefilter: PrefilterResultOut | None
    source_names: list[str]


class InboxJobDetailOut(InboxJobOut):
    """The score-breakdown drawer (M1 §6) — everything InboxJobOut has
    plus every source sighting (full lineage, not just names) and the
    job's own text, so the drawer can show evidence spans next to the
    text they were quoted from."""

    requirements: str | None
    responsibilities: str | None
    benefits: str | None
    sightings: list[JobSightingOut]


class BulkDeleteJobsIn(BaseModel):
    job_ids: list[uuid.UUID]


class BulkDeleteJobsOut(BaseModel):
    deleted: int


# --- M3 §2/F5.10 — job groups, tailoring ---


class JobGroupOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    persona_id: uuid.UUID
    name: str
    job_ids: list[uuid.UUID]


class JobGroupCreate(BaseModel):
    name: str
    job_ids: list[uuid.UUID] = Field(default_factory=list)


class JobGroupUpdate(BaseModel):
    name: str | None = None


class JobGroupAddMember(BaseModel):
    job_id: uuid.UUID


class DocumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    job_group_id: uuid.UUID
    persona_id: uuid.UUID
    profile_revision: int
    doc_type: str
    version: int
    json_delta: dict
    rendered_keys: dict
    template: str
    verified: bool
    created_at: datetime


class DocumentTexOut(BaseModel):
    tex: str
    is_edited: bool


class DocumentTexIn(BaseModel):
    template_id: str
    tex: str


class AnswerPackRequest(BaseModel):
    questions: list[str]


class CoverLetterRequest(BaseModel):
    tone: str = "neutral"  # neutral | formal | very_formal | warm
    length: str = "medium"  # short | medium | long


class SkillGapItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    job_group_id: uuid.UUID
    skill_text: str
    status: str
    evidence_item_id: uuid.UUID | None


class ClaimVerificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    claim_text: str
    evidence_ids: list[uuid.UUID]
    verdict: str
    rationale: str | None
    attempt_number: int
