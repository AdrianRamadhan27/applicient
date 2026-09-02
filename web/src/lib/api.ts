export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// M5 — auth token storage. A plain module (not a component), so this
// reads localStorage directly rather than through React context;
// auth.ts's AuthProvider writes to the same key so both stay in sync
// without a circular import between the two files.
export const AUTH_TOKEN_STORAGE_KEY = "applicient.authToken";

export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
}

function authHeader(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type User = { id: string; email: string; role: "user" | "admin"; email_verified: boolean };

// SaaS pivot — admin-only surfaces.
export type Plan = {
  id: string;
  name: string;
  price_idr: number;
  monthly_usage_cap_usd: number;
  is_active: boolean;
};

export type Subscription = {
  plan_id: string;
  plan_name: string;
  price_idr: number;
  monthly_usage_cap_usd: number;
  status: string;
  current_period_spend_usd: number;
  current_period_end: string | null;
  pending_plan_name: string | null;
};

export type AdminUser = {
  id: string;
  email: string;
  role: "user" | "admin";
  is_active: boolean;
  created_at: string;
  plan_name: string | null;
  subscription_status: string | null;
  current_period_spend_usd: number;
};

/** The dedicated Live Browser page's own WebSocket connection —
 * `API_BASE_URL` with its scheme swapped (http→ws, https→wss), same
 * origin/port otherwise. Browser-worker itself is never reached
 * directly (it has no auth of its own); this always points at the
 * `api`-side proxy (routers/applications.py's live_browser_proxy). */
export function apiWebSocketUrl(path: string): string {
  return `${API_BASE_URL.replace(/^http/, "ws")}${path}`;
}

export type ProviderConnection = {
  id: string;
  provider: string;
  label: string | null;
  api_key_hint: string | null;
  base_url: string | null;
  status: "untested" | "ok" | "auth_failed" | "unreachable";
  last_verified_at: string | null;
  last_error: string | null;
};

// Third-party login credentials (LinkedIn, etc.) the agent can use to
// sign in during a fill — deliberately separate from ProviderConnection
// (an LLM/embedding provider API key) and from FormAnswer (a semantic
// answer-reuse store, not a secrets vault). The raw secret never comes
// back from the API after creation — secret_hint only.
export type Credential = {
  id: string;
  label: string;
  identifier: string;
  secret_hint: string;
  created_at: string;
};

// M5 F8.7 — in-app only for this pass (channel is always "in_app").
export type Notification = {
  id: string;
  channel: string;
  subject: string;
  body: string | null;
  related_type: string | null;
  related_id: string | null;
  sent_at: string | null;
  read_at: string | null;
  created_at: string;
};

// M5 F8.3-F8.6 — one ingested Gmail message, classified and (maybe)
// matched to an Application.
export type EmailMessage = {
  id: string;
  gmail_message_id: string;
  thread_id: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: string;
  classification: string | null;
  extracted_data: Record<string, unknown>;
  matched_application_id: string | null;
  match_confidence: number | null;
  review_needed: boolean;
  processed_at: string | null;
};

// M5 F8.1 — a per-user Gmail OAuth grant feeding email ingestion.
// Never carries the refresh token — only connection-health fields,
// same masking discipline as ProviderConnection/Credential.
export type GmailConnection = {
  id: string;
  google_email: string;
  label_name: string;
  scan_window_days: number;
  status: string;
  last_synced_at: string | null;
  last_error: string | null;
  watch_expiration: string | null;
};

export type ModelCatalogEntry = {
  id: string;
  model_id: string;
  display_name: string | null;
  context_window: number | null;
  max_output: number | null;
  capabilities: string[];
  input_price_per_mtok: number | null;
  output_price_per_mtok: number | null;
  cache_read_price_per_mtok: number | null;
  cache_write_price_per_mtok: number | null;
  pricing_version: string | null;
  pricing_known: boolean;
  fetched_at: string;
};

export type Profile = {
  id: string;
  user_id: string;
  revision: number;
  confirmed: boolean;
  parsed_profile: ParsedProfile;
  parsed_at: string | null;
  visa_status: string | null;
  notice_period_days: number | null;
};

export type ParsedProfile = {
  full_name?: string | null;
  headline?: string | null;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  links?: string[];
  summary?: string | null;
  skills?: string[];
};

// --- M3 §2-4/F5.10 — job groups, tailoring, verification, rendering ---

export type JobGroup = {
  id: string;
  persona_id: string;
  name: string;
  job_ids: string[];
};

export type TailoredBullet = { evidence_id: string; text: string };
export type TailoredSection = { evidence_id: string; bullets: TailoredBullet[] };

export type TailoringDelta = {
  summary: string;
  sections: TailoredSection[];
  skills_highlight: string[];
  rationale: string;
};

export type CoverLetterParagraph = { evidence_ids: string[]; text: string };
export type CoverLetterDelta = {
  greeting: string;
  paragraphs: CoverLetterParagraph[];
  closing: string;
};

export type CoverLetterTone = "neutral" | "formal" | "very_formal" | "warm";
export type CoverLetterLength = "short" | "medium" | "long";

export type AnswerPackAnswer = { question: string; evidence_ids: string[]; answer: string };
export type AnswerPackDelta = { answers: AnswerPackAnswer[] };

export type TailoredDocument = {
  id: string;
  job_group_id: string;
  persona_id: string;
  profile_revision: number;
  doc_type: string;
  version: number;
  // Narrow on doc_type ("cv" | "cover_letter" | "answer_pack") — each
  // doc type has a genuinely different content shape, not a superset/
  // subset of the others.
  json_delta: TailoringDelta | CoverLetterDelta | AnswerPackDelta;
  rendered_keys: Record<string, string>;
  template: string;
  verified: boolean;
  created_at: string;
};

export type ClaimVerdict = "supported" | "reframed_ok" | "unsupported" | "inflated";

export type ClaimVerification = {
  id: string;
  claim_text: string;
  evidence_ids: string[];
  verdict: ClaimVerdict;
  rationale: string | null;
  attempt_number: number;
};

export type CvTemplate = { id: string; name: string; description: string };

export type SkillGapItem = {
  id: string;
  job_group_id: string;
  skill_text: string;
  status: "pending" | "done";
  evidence_item_id: string | null;
};

export type TailorProgressEvent =
  | {
      type: "stage";
      stage: "tailoring" | "verifying" | "regenerating";
      status: "started" | "done";
      message: string;
      attempt?: number;
      clean?: boolean;
    }
  | { type: "done"; result: TailoredDocument }
  | { type: "error"; message: string };

export type DocumentTex = { tex: string; is_edited: boolean };

export const EVIDENCE_CATEGORIES = [
  "experience",
  "education",
  "certification",
  "project",
  "achievement",
  "skill",
  "other",
] as const;

export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];

// experience/other deliberately reuse --primary/--muted rather than
// adding two more bespoke hues — see the comment in globals.css.
export const CATEGORY_COLOR_CLASS: Record<EvidenceCategory, string> = {
  experience: "bg-accent text-primary",
  education: "bg-cat-education-bg text-cat-education",
  certification: "bg-cat-certification-bg text-cat-certification",
  project: "bg-cat-project-bg text-cat-project",
  achievement: "bg-cat-achievement-bg text-cat-achievement",
  skill: "bg-cat-skill-bg text-cat-skill",
  other: "bg-muted text-muted-foreground",
};

// For the tab indicator dots — a solid fill, not the badge's tinted
// bg/fg pair, since a dot is too small to carry a background tint
// legibly. experience/other reuse --primary/--muted-foreground.
export const CATEGORY_DOT_CLASS: Record<EvidenceCategory, string> = {
  experience: "bg-primary",
  education: "bg-cat-education",
  certification: "bg-cat-certification",
  project: "bg-cat-project",
  achievement: "bg-cat-achievement",
  skill: "bg-cat-skill",
  other: "bg-muted-foreground",
};

export type EvidenceItem = {
  id: string;
  profile_id: string;
  category: EvidenceCategory;
  title: string | null;
  text: string;
  skills: string[];
  metrics: Record<string, string>;
  employer: string | null;
  date_start: string | null;
  date_end: string | null;
  verified: boolean;
  embedded: boolean;
};

export type CVParseResult = {
  agent_run_id: string;
  profile: Profile;
  evidence_items: EvidenceItem[];
  cost_usd: number;
};

export const CV_PARSE_STAGES = [
  "extracting",
  "resolving_models",
  "parsing",
  "saving",
  "embedding",
] as const;
export type CVParseStage = (typeof CV_PARSE_STAGES)[number];

export type CVParseProgressEvent =
  | { type: "stage"; stage: CVParseStage; status: "started" | "done"; message: string }
  | { type: "done"; result: CVParseResult }
  | { type: "error"; message: string };

export type ModelProfile = {
  id: string;
  name: string;
  is_active: boolean;
  tier_bindings: Record<string, string>;
  stage_overrides: Record<string, string>;
};

export type LlmCall = {
  id: string;
  agent_run_id: string | null;
  job_id: string | null;
  source_run_id: string | null;
  stage: string | null;
  subagent_name: string | null;
  provider: string;
  model_id: string;
  tier: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  cost_known: boolean;
  pricing_version: string | null;
  fallback_from_model: string | null;
  status: string;
  error_message: string | null;
  latency_ms: number | null;
  created_at: string;
};

export type CostSummary = {
  total_cost_usd: number;
  total_calls: number;
  unknown_cost_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  by_stage: Record<string, number>;
  by_tier: Record<string, number>;
  by_provider: Record<string, number>;
  by_model: Record<string, number>;
  by_source: Record<string, number>;
  cost_per_scored_job: number | null;
  recent_calls: LlmCall[];
};

export type CostRun = {
  id: string;
  run_type: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  total_cost_usd: number;
  call_count: number;
  saved_search_id: string | null;
};

export type AgentStep = {
  id: string;
  step_type: string;
  subagent_name: string | null;
  input_summary: Record<string, unknown>;
  output_summary: Record<string, unknown>;
  started_at: string;
  finished_at: string | null;
  cost_usd: number;
};

export type AgentRunDetail = {
  id: string;
  run_type: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  total_cost_usd: number;
  saved_search_id: string | null;
  persona_id: string | null;
  profile_revision: number | null;
  steps: AgentStep[];
};

export type CostSummaryFilters = {
  since?: string;
  until?: string;
  runId?: string;
  sourceId?: string;
  stage?: string;
  tier?: string;
  provider?: string;
  modelId?: string;
};

/**
 * Low-level SSE frame parser shared by every streaming endpoint. The
 * browser's built-in EventSource can't do POST/multipart, so this
 * parses frames by hand off a fetch() body reader.
 *
 * sse_starlette sends CRLF line endings (confirmed against raw
 * response bytes, not assumed — curl's terminal output silently
 * normalizes \r\n to look like \n, which is exactly how the first
 * version of this parser missed it: it only ever searched for "\n\n",
 * which never matches inside "\r\n\r\n"). Normalized right where new
 * data is appended, so `buffer` stays the single consistent value
 * both searched and sliced below across every iteration.
 */
/** Shared between the live SSE path and the durable-replay path below
 * — both ultimately produce the same `{event_type, data}` shape (the
 * backend's `_emit` writes the exact dict it also puts on the SSE
 * frame), so this is the one place that knows how to turn that into a
 * `RadarRunProgressEvent`, including the "done" event's special case
 * (its payload IS the RadarRunResult, not a field bag to spread). */
export function toRadarProgressEvent(eventType: string, data: Record<string, unknown>): RadarRunProgressEvent {
  if (eventType === "done") return { type: "done", result: data as unknown as RadarRunResult };
  return { type: eventType as RadarRunProgressEvent["type"], ...data } as RadarRunProgressEvent;
}

async function* parseSSE(res: Response): AsyncGenerator<{ event: string; data: string }> {
  if (!res.body) {
    throw new Error("no response body to stream");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      yield { event: eventName, data: dataLines.join("\n") };
    }
  }
}

export type Persona = {
  id: string;
  profile_id: string;
  name: string;
  base_cv_template: string;
  active: boolean;
};

export type Preference = {
  id: string;
  persona_id: string;
  target_roles: string[];
  seniority: string[];
  salary_floor: number | null;
  salary_target: number | null;
  salary_currency: string;
  locations: string[];
  willing_to_relocate: boolean;
  remote_policy: string[];
  industries_include: string[];
  industries_exclude: string[];
  company_size_pref: string[];
  deal_breakers: string[];
};

export type PreferenceUpsert = Partial<Omit<Preference, "id" | "persona_id">>;

export type CompanyCandidateStatus =
  | "resolved_greenhouse"
  | "resolved_lever"
  | "resolved_workable"
  | "resolved_ashby"
  | "resolved_smartrecruiters"
  | "resolved_recruitee"
  | "unresolved";

export type CompanyCandidate = {
  id: string;
  persona_id: string;
  company_name: string;
  origin: "preference_discovery" | "apply_link";
  rationale: string | null;
  status: CompanyCandidateStatus;
  resolved_identifier: string | null;
  discovered_url: string | null;
  approved: boolean;
  origin_job_id: string | null;
};

export const SOURCE_ADAPTERS = [
  "greenhouse",
  "lever",
  "workable",
  "ashby",
  "smartrecruiters",
  "recruitee",
  "remoteok",
  "jsearch",
  "jobspy",
  "socialfetch",
] as const;
export type SourceAdapterKey = (typeof SOURCE_ADAPTERS)[number];

export type Source = {
  id: string;
  name: string;
  tier: string;
  adapter_key: string;
  config: Record<string, string | number | string[]>;
  rate_limit_config: Record<string, number>;
  enabled: boolean;
  circuit_breaker_tripped: boolean;
  status: "untested" | "ok" | "auth_failed" | "unreachable";
  last_verified_at: string | null;
  last_error: string | null;
};

export type SavedSearch = {
  id: string;
  persona_id: string;
  name: string;
  role_titles: string[];
  source_ids: string[];
  filters: { location?: string; remote?: boolean; employment_type?: string };
  schedule_cron: string | null;
  active: boolean;
};

export type SourceRun = {
  id: string;
  source_id: string;
  status: "pending" | "running" | "completed" | "failed";
  expanded_queries: Record<string, string[]>;
  started_at: string;
  finished_at: string | null;
  postings_seen: number;
  postings_new: number;
  postings_deduped: number;
  // M2 §6 — a scan-list source can cover many companies at once;
  // keyed by the source's own display company name.
  company_breakdown: Record<string, { seen: number; new: number; deduped: number }>;
  errors: { message: string; at: string }[];
  cost_usd: number;
};

export type RadarRunResult = {
  agent_run_id: string;
  status: string;
  source_runs: SourceRun[];
  cost_usd: number;
};

export type AgentRunSummary = {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  total_cost_usd: number;
  source_runs: SourceRun[];
};

export type JobSummary = {
  id: string;
  title: string;
  company_name_raw: string;
  location: string | null;
  remote_policy: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  apply_url: string | null;
  posted_at: string | null;
  ghost_job_score: number | null;
  ghost_job_reasons: string[];
};

export type Recommendation = "strong_apply" | "apply" | "stretch" | "skip";

export type FitScore = {
  id: string;
  recommendation: Recommendation;
  overall_score: number;
  hard_requirements_met: number;
  hard_requirements_total: number;
  hard_blocker: string | null;
  experience_delta_years: number | null;
  skills_matched: string[];
  skills_partial: string[];
  skills_missing: string[];
  seniority_fit: string | null;
  domain_fit: string | null;
  location_fit: string | null;
  salary_overlap: string | null;
  company_stage_fit: string | null;
  language_fit: string | null;
  evidence_spans: { quote: string; supports: string }[];
  gap_closers: string | null;
  red_flags: string[];
  scoring_version: string;
  model_used: string | null;
  cost_usd: number;
  created_at: string;
};

export type PrefilterResult = {
  decision: "keep" | "drop" | "review";
  reason: string;
  prefilter_version: string;
  created_at: string;
};

export type JobSighting = {
  id: string;
  source_id: string;
  source_name: string;
  adapter_key: string;
  source_url: string;
  external_requisition_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  posted_at_on_source: string | null;
};

export type InboxJob = {
  id: string;
  title: string;
  company_name_raw: string;
  location: string | null;
  remote_policy: string | null;
  employment_type: string | null;
  seniority: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  apply_url: string | null;
  posted_at: string | null;
  discovered_at: string;
  ghost_job_score: number | null;
  ghost_job_reasons: string[];
  repost_count: number;
  fit_score: FitScore | null;
  prefilter: PrefilterResult | null;
  source_names: string[];
};

export type InboxJobDetail = InboxJob & {
  requirements: string | null;
  responsibilities: string | null;
  benefits: string | null;
  sightings: JobSighting[];
};

// --- F6/F7 — application execution and the pipeline board ---

// M5 follow-up — pipeline stages are now a per-user customizable list
// (reorder/rename/add/remove), not a fixed set. `key` is immutable and
// what Application.state actually stores; `display_name` is what the
// UI shows.
export type PipelineStage = { id: string; key: string; display_name: string; position: number };

export const AUTONOMY_LEVELS = [
  "l0_manual",
  "l1_answer_pack",
  "l2_fill_review",
  "l3_fill_submit",
] as const;
export type AutonomyLevelValue = (typeof AUTONOMY_LEVELS)[number];

export type Application = {
  id: string;
  job_id: string;
  persona_id: string;
  job_group_id: string | null;
  primary_document_id: string | null;
  // M5 follow-up — a plain string now, not a closed union: it's one of
  // this user's own customizable PipelineStage keys, which isn't
  // knowable at the type level (and, in the rare edge case of a
  // matching stage having been deleted, might not even be one of
  // them).
  state: string;
  autonomy_level: AutonomyLevelValue | null;
  applied_at: string | null;
  created_at: string;
  ghosted: boolean;
  job_title: string;
  company_name: string;
};

export type ApplicationEvent = {
  id: string;
  application_id: string;
  actor: "agent" | "email" | "user";
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: string;
};

export type ApplicationAttempt = {
  id: string;
  application_id: string;
  agent_run_id: string | null;
  attempt_number: number;
  autonomy_level: string;
  status:
    | "in_progress"
    | "awaiting_review"
    | "awaiting_handoff"
    | "awaiting_email"
    | "submitted"
    | "abandoned"
    | "failed";
  field_map: Record<string, unknown>;
  screenshot_keys: string[];
  email_draft: { to: string; subject: string; body: string } | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

export type ApplicationDetail = Application & {
  events: ApplicationEvent[];
  attempts: ApplicationAttempt[];
};

export type InterruptRequest = { tool: string; args: Record<string, unknown>; description: string };

export type ApplicationStreamEvent =
  | { type: "stage"; stage: string; status: string; message: string; session_id?: string; attempt_id?: string }
  // A single LLM turn can call an interrupt-gated tool (e.g. ask_user)
  // more than once — LangGraph pauses on the whole batch at once, so
  // this always carries every hanging request, not just one. The
  // common case is a one-item array.
  | { type: "interrupt"; attempt_id: string; requests: InterruptRequest[] }
  | { type: "done"; attempt_id: string }
  | { type: "error"; message: string };

export function toApplicationStreamEvent(
  eventType: string,
  data: Record<string, unknown>,
): ApplicationStreamEvent {
  // Every event_type's data shape already matches its live-SSE
  // counterpart field-for-field (confirmed against streamApply's own
  // per-event branches above), so a single spread reconstructs all
  // four variants correctly — no per-type special-casing needed. The
  // one real exception: `interrupt` RunEvent rows persisted before
  // multi-request support (`{tool, args, description}`) predate the
  // `{requests: [...]}` wrapper — replaying one of those old rows
  // would otherwise leave `requests` undefined and crash every
  // `.requests.length`/`.map` call downstream. Normalized into a
  // one-item `requests` array here so old and new history replay
  // through the exact same rendering path.
  if (eventType === "interrupt" && !Array.isArray(data.requests)) {
    return {
      type: "interrupt",
      attempt_id: data.attempt_id as string,
      requests: [{ tool: data.tool as string, args: data.args as Record<string, unknown>, description: data.description as string }],
    };
  }
  return { type: eventType as ApplicationStreamEvent["type"], ...data } as ApplicationStreamEvent;
}

export type InterruptDecision =
  | { type: "approve" }
  | { type: "reject"; message?: string }
  | { type: "respond"; message: string };

// --- M7 — the conversational orchestrator ---

export type Conversation = {
  id: string;
  persona_id: string;
  status: string;
  title: string | null;
  pending_interrupt: { requests: InterruptRequest[] } | null;
  last_active_at: string;
  created_at: string;
};

// A tool result the model sees is always plain text — a card is the
// side channel (orchestrator_tools.py's `emit_card`) that lets a tool
// ALSO hand the frontend something structured to render as a real
// embed (a scored job list, a tailored document, a running
// application) instead of collapsing everything into prose.
export type JobCardJob = {
  job_id: string;
  title: string;
  company_name: string;
  location: string | null;
  score: number;
  recommendation: string;
};

export type ConversationCard =
  | { card_type: "jobs"; jobs: JobCardJob[] }
  | {
      card_type: "document";
      document_id: string;
      doc_type: string;
      template: string;
      verified: boolean;
      job_group_id: string | null;
    }
  | { card_type: "application"; application_id: string; attempt_id: string | null; session_id: string | null };

export type ConversationStreamEvent =
  | { type: "stage"; stage: string; status: string; message: string }
  | { type: "interrupt"; requests: InterruptRequest[] }
  | { type: "done" }
  | { type: "error"; message: string }
  | ({ type: "card" } & ConversationCard);

function toConversationStreamEvent(eventType: string, data: Record<string, unknown>): ConversationStreamEvent {
  return { type: eventType as ConversationStreamEvent["type"], ...data } as ConversationStreamEvent;
}

export type RadarRunProgressEvent =
  | { type: "run_started"; agent_run_id: string }
  | { type: "source_started"; source_run_id: string; source_name: string; adapter_key: string }
  | {
      type: "source_done";
      source_run_id: string;
      status: "completed" | "failed";
      seen?: number;
      new?: number;
      deduped?: number;
      company_breakdown?: Record<string, { seen: number; new: number; deduped: number }>;
      message?: string;
    }
  | { type: "source_error"; source_id: string; message: string }
  | { type: "run_cancelled"; agent_run_id: string }
  | { type: "query_expansion_fallback"; source_run_id: string; role_title: string; reason: string }
  | { type: "log"; source_run_id: string; message: string }
  | { type: "embedding_started"; count: number }
  | { type: "embedding_done"; embedded: number; errors: string[] }
  | { type: "scoring_started"; count: number }
  | {
      type: "job_scored";
      job_id: string;
      title: string;
      decision: "keep" | "drop" | "review";
      recommendation: "strong_apply" | "apply" | "stretch" | "skip" | null;
      overall_score: number | null;
    }
  | { type: "job_scoring_error"; job_id: string; title: string; message: string }
  | { type: "scoring_done"; kept: number; dropped: number; review: number; errors: number }
  | { type: "done"; result: RadarRunResult };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...authHeader(), ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  signup: (email: string, password: string) =>
    request<{ access_token: string; user: User }>("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  login: (email: string, password: string) =>
    request<{ access_token: string; user: User }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<User>("/auth/me"),
  /** Not a fetch — a real browser navigation to Google's own consent
   * screen, same reasoning as gmailConnectUrl() below (an unauthenticated
   * login flow, so there's no token to attach anyway). */
  googleLoginUrl(): string {
    return `${API_BASE_URL}/auth/google/login`;
  },
  resendVerification: () => request<void>("/auth/resend-verification", { method: "POST" }),

  listConnections: () => request<ProviderConnection[]>("/provider-connections"),
  createConnection: (body: {
    provider: string;
    api_key: string;
    base_url?: string;
    label?: string;
  }) =>
    request<ProviderConnection>("/provider-connections", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteConnection: (id: string) =>
    request<void>(`/provider-connections/${id}`, { method: "DELETE" }),

  listCredentials: () => request<Credential[]>("/credentials"),
  createCredential: (body: { label: string; identifier: string; secret: string }) =>
    request<Credential>("/credentials", { method: "POST", body: JSON.stringify(body) }),
  deleteCredential: (id: string) => request<void>(`/credentials/${id}`, { method: "DELETE" }),

  /** Not a fetch — a real browser navigation, since OAuth needs the
   * user's browser at Google's own consent screen. Carries the auth
   * token as a query param (the /gmail/connect redirect can't read an
   * Authorization header from a plain link navigation either). */
  gmailConnectUrl(): string {
    const token = getAuthToken();
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${API_BASE_URL}/gmail/connect${qs}`;
  },
  listGmailConnections: () => request<GmailConnection[]>("/gmail/connections"),
  updateGmailConnection: (id: string, body: { scan_window_days: number }) =>
    request<GmailConnection>(`/gmail/connections/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteGmailConnection: (id: string) => request<void>(`/gmail/connections/${id}`, { method: "DELETE" }),

  listNotifications: (unreadOnly = false) =>
    request<Notification[]>(`/notifications${unreadOnly ? "?unread_only=true" : ""}`),
  unreadNotificationCount: () => request<{ count: number }>("/notifications/unread-count"),
  markNotificationRead: (id: string) => request<Notification>(`/notifications/${id}/read`, { method: "POST" }),

  listEmailMessages: (reviewNeeded?: boolean) =>
    request<EmailMessage[]>(`/email-messages${reviewNeeded !== undefined ? `?review_needed=${reviewNeeded}` : ""}`),
  confirmEmailTransition: (id: string, body: { approve: boolean; new_state?: string | null }) =>
    request<EmailMessage>(`/email-messages/${id}/confirm-transition`, { method: "POST", body: JSON.stringify(body) }),
  emailMessageIcsUrl(emailMessageId: string): string {
    const token = getAuthToken();
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${API_BASE_URL}/email-messages/${emailMessageId}/ics${qs}`;
  },
  testConnection: (id: string) =>
    request<ProviderConnection>(`/provider-connections/${id}/test`, {
      method: "POST",
    }),
  refreshCatalog: (id: string) =>
    request<ModelCatalogEntry[]>(`/provider-connections/${id}/refresh-catalog`, {
      method: "POST",
    }),
  getCatalog: (id: string) =>
    request<ModelCatalogEntry[]>(`/provider-connections/${id}/catalog`),

  listProfiles: () => request<Profile[]>("/profiles"),
  getProfile: (id: string) => request<Profile>(`/profiles/${id}`),
  updateProfile: (
    id: string,
    body: {
      confirmed?: boolean;
      parsed_profile?: ParsedProfile;
      visa_status?: string;
      notice_period_days?: number;
    },
  ) =>
    request<Profile>(`/profiles/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  resetProfile: (id: string) =>
    request<Profile>(`/profiles/${id}/reset`, { method: "POST" }),

  listEvidence: (profileId: string) =>
    request<EvidenceItem[]>(`/profiles/${profileId}/evidence-items`),
  deleteEvidence: (profileId: string, evidenceId: string) =>
    request<void>(`/profiles/${profileId}/evidence-items/${evidenceId}`, {
      method: "DELETE",
    }),
  updateEvidence: (
    profileId: string,
    evidenceId: string,
    body: {
      category?: EvidenceCategory;
      title?: string | null;
      text?: string;
      skills?: string[];
      metrics?: Record<string, string>;
      employer?: string | null;
      date_start?: string | null;
      date_end?: string | null;
    },
  ) =>
    request<EvidenceItem>(`/profiles/${profileId}/evidence-items/${evidenceId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  /**
   * Streams real progress from the backend (extract → resolve models →
   * parse → save → embed, each tied to an actual code boundary — see
   * cv.py's module docstring) rather than a single blocking call.
   */
  async *streamParseCV(profileId: string, file: File): AsyncGenerator<CVParseProgressEvent> {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_BASE_URL}/profiles/${profileId}/cv/parse`, {
      method: "POST",
      headers: authHeader(),
      body: formData,
    });
    if (!res.ok) {
      throw new Error(`CV parse failed: ${res.status}: ${await res.text()}`);
    }

    for await (const { event, data } of parseSSE(res)) {
      const payload = JSON.parse(data);
      if (event === "stage") yield { type: "stage", ...payload };
      else if (event === "done") yield { type: "done", result: payload as CVParseResult };
      else if (event === "error") yield { type: "error", message: payload.message };
    }
  },

  /** Same SSE shape as streamParseCV — see radar.py's module docstring
   * for what each event ties to. */
  async *streamRadarRun(savedSearchId: string): AsyncGenerator<RadarRunProgressEvent> {
    const res = await fetch(`${API_BASE_URL}/saved-searches/${savedSearchId}/run`, {
      method: "POST",
      headers: authHeader(),
    });
    if (!res.ok) {
      throw new Error(`radar run failed: ${res.status}: ${await res.text()}`);
    }

    for await (const { event, data } of parseSSE(res)) {
      yield toRadarProgressEvent(event, JSON.parse(data));
    }
  },

  /** Replay/reconnect path for a run this page didn't start live (a
   * page reload mid-run, or navigating back to a saved search whose
   * run is still going) — see saved_searches.py's `list_run_events`
   * docstring for why the backend needs a durable event log for this
   * at all. Returns everything after `sinceSeq` plus the run's
   * current status, so the caller knows whether to keep polling. */
  listRunEvents: (savedSearchId: string, agentRunId: string, sinceSeq: number) =>
    request<{ run_status: string; events: { seq: number; event_type: string; data: Record<string, unknown> }[] }>(
      `/saved-searches/${savedSearchId}/runs/${agentRunId}/events?since_seq=${sinceSeq}`,
    ),

  getCostSummary: (filters?: CostSummaryFilters) => {
    const params = new URLSearchParams();
    if (filters?.since) params.set("since", filters.since);
    if (filters?.until) params.set("until", filters.until);
    if (filters?.runId) params.set("run_id", filters.runId);
    if (filters?.sourceId) params.set("source_id", filters.sourceId);
    if (filters?.stage) params.set("stage", filters.stage);
    if (filters?.tier) params.set("tier", filters.tier);
    if (filters?.provider) params.set("provider", filters.provider);
    if (filters?.modelId) params.set("model_id", filters.modelId);
    const qs = params.toString();
    return request<CostSummary>(`/cost/summary${qs ? `?${qs}` : ""}`);
  },
  listCostRuns: (opts?: { limit?: number; runType?: string }) => {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.runType) params.set("run_type", opts.runType);
    const qs = params.toString();
    return request<CostRun[]>(`/cost/runs${qs ? `?${qs}` : ""}`);
  },
  /** Run Console — the generic per-run trace (AgentStep), any run type. */
  getAgentRun: (runId: string) => request<AgentRunDetail>(`/agent-runs/${runId}`),
  cancelAgentRun: (runId: string) => request<AgentRunDetail>(`/agent-runs/${runId}/cancel`, { method: "POST" }),

  listPersonas: () => request<Persona[]>("/personas"),
  createPersona: (body: { name: string; base_cv_template?: string }) =>
    request<Persona>("/personas", { method: "POST", body: JSON.stringify(body) }),
  updatePersona: (id: string, body: { name?: string; active?: boolean }) =>
    request<Persona>(`/personas/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deletePersona: (id: string) => request<void>(`/personas/${id}`, { method: "DELETE" }),

  /** Returns `null` for the expected "nothing saved yet" case rather than
   * throwing — a fresh persona with no preferences is a normal first-run
   * state (M2 §2), not an error the caller should surface as one. */
  getPreference: async (personaId: string): Promise<Preference | null> => {
    try {
      return await request<Preference>(`/personas/${personaId}/preferences`);
    } catch (err) {
      if (err instanceof Error && err.message.includes("-> 404")) return null;
      throw err;
    }
  },
  upsertPreference: (personaId: string, body: PreferenceUpsert) =>
    request<Preference>(`/personas/${personaId}/preferences`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  listCompanyCandidates: (personaId: string) =>
    request<CompanyCandidate[]>(`/personas/${personaId}/company-candidates`),
  discoverCompanyCandidates: (personaId: string) =>
    request<CompanyCandidate[]>(`/personas/${personaId}/company-candidates/discover`, { method: "POST" }),
  updateCompanyCandidate: (candidateId: string, body: { approved: boolean }) =>
    request<CompanyCandidate>(`/company-candidates/${candidateId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  listSources: () => request<Source[]>("/sources"),
  createSource: (body: {
    name: string;
    tier: string;
    adapter_key: string;
    config: Record<string, string | string[]>;
  }) => request<Source>("/sources", { method: "POST", body: JSON.stringify(body) }),
  updateSource: (id: string, body: { enabled?: boolean; config?: Record<string, string | string[]> }) =>
    request<Source>(`/sources/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteSource: (id: string) => request<void>(`/sources/${id}`, { method: "DELETE" }),
  testSource: (id: string) => request<Source>(`/sources/${id}/test`, { method: "POST" }),

  listSavedSearches: () => request<SavedSearch[]>("/saved-searches"),
  createSavedSearch: (body: {
    persona_id: string;
    name: string;
    role_titles: string[];
    source_ids: string[];
    filters?: SavedSearch["filters"];
    schedule_cron?: string | null;
  }) => request<SavedSearch>("/saved-searches", { method: "POST", body: JSON.stringify(body) }),
  updateSavedSearch: (
    id: string,
    body: Partial<Pick<SavedSearch, "name" | "active" | "role_titles" | "source_ids" | "filters" | "schedule_cron">>,
  ) =>
    request<SavedSearch>(`/saved-searches/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteSavedSearch: (id: string) => request<void>(`/saved-searches/${id}`, { method: "DELETE" }),
  listSavedSearchRuns: (id: string, limit = 5) =>
    request<AgentRunSummary[]>(`/saved-searches/${id}/runs?limit=${limit}`),
  listSavedSearchJobs: (id: string, limit = 50) =>
    request<JobSummary[]>(`/saved-searches/${id}/jobs?limit=${limit}`),

  /** M1 §6 — the real ranked Job Inbox, replacing the saved-search-scoped
   * stand-in above. Scores are persona-scoped, so personaId is required. */
  listInboxJobs: (
    personaId: string,
    filters?: {
      recommendation?: (Recommendation | "unscored")[];
      sourceId?: string;
      search?: string;
      location?: string;
      minScore?: number;
      maxScore?: number;
      sort?: "recommended" | "newest_posted" | "newest_scanned" | "oldest_scanned";
      limit?: number;
      offset?: number;
    },
  ) => {
    const params = new URLSearchParams({ persona_id: personaId });
    for (const r of filters?.recommendation ?? []) params.append("recommendation", r);
    if (filters?.sourceId) params.set("source_id", filters.sourceId);
    if (filters?.search) params.set("search", filters.search);
    if (filters?.location) params.set("location", filters.location);
    if (filters?.minScore !== undefined) params.set("min_score", String(filters.minScore));
    if (filters?.maxScore !== undefined) params.set("max_score", String(filters.maxScore));
    if (filters?.sort) params.set("sort", filters.sort);
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    if (filters?.offset !== undefined) params.set("offset", String(filters.offset));
    return request<InboxJob[]>(`/jobs?${params.toString()}`);
  },
  getInboxJob: (jobId: string, personaId: string) =>
    request<InboxJobDetail>(`/jobs/${jobId}?persona_id=${personaId}`),
  bulkDeleteJobs: (jobIds: string[]) =>
    request<{ deleted: number }>("/jobs/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ job_ids: jobIds }),
    }),

  // --- M3 §2-4/F5.10 — job groups, tailoring, verification, rendering ---

  listJobGroups: (personaId: string) => request<JobGroup[]>(`/personas/${personaId}/job-groups`),
  createJobGroup: (personaId: string, body: { name: string; job_ids?: string[] }) =>
    request<JobGroup>(`/personas/${personaId}/job-groups`, { method: "POST", body: JSON.stringify(body) }),
  updateJobGroup: (id: string, body: { name?: string }) =>
    request<JobGroup>(`/job-groups/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteJobGroup: (id: string) => request<void>(`/job-groups/${id}`, { method: "DELETE" }),
  addJobGroupMember: (groupId: string, jobId: string) =>
    request<JobGroup>(`/job-groups/${groupId}/members`, {
      method: "POST",
      body: JSON.stringify({ job_id: jobId }),
    }),
  removeJobGroupMember: (groupId: string, jobId: string) =>
    request<JobGroup>(`/job-groups/${groupId}/members/${jobId}`, { method: "DELETE" }),
  listGroupDocuments: (groupId: string, docType?: "cv" | "cover_letter" | "answer_pack") =>
    request<TailoredDocument[]>(
      `/job-groups/${groupId}/documents${docType ? `?doc_type=${docType}` : ""}`,
    ),
  /** The plain row, by id alone — no job_group context needed. Backs
   * the Assistant chat's document card, which only has a document_id
   * from a tool result. */
  getDocument: (documentId: string) => request<TailoredDocument>(`/documents/${documentId}`),
  getSkillGap: (groupId: string) => request<SkillGapItem[]>(`/job-groups/${groupId}/skill-gap`),
  completeSkillGapItem: (groupId: string, itemId: string) =>
    request<SkillGapItem>(`/job-groups/${groupId}/skill-gap/${itemId}/complete`, { method: "POST" }),
  reopenSkillGapItem: (groupId: string, itemId: string) =>
    request<SkillGapItem>(`/job-groups/${groupId}/skill-gap/${itemId}/reopen`, { method: "POST" }),
  listTemplates: (docType: "cv" | "cover_letter" = "cv") =>
    request<CvTemplate[]>(`/documents/templates?doc_type=${docType}`),
  listDocumentVerifications: (documentId: string) =>
    request<ClaimVerification[]>(`/documents/${documentId}/verifications`),

  /** Synchronous, not SSE — Tectonic compiles in low single-digit
   * seconds. Returns the rendered PDF bytes directly, for the
   * Composer's live-preview pane. */
  async renderDocument(documentId: string, templateId: string): Promise<Blob> {
    const res = await fetch(
      `${API_BASE_URL}/documents/${documentId}/render?template_id=${encodeURIComponent(templateId)}`,
      { method: "POST", headers: authHeader() },
    );
    if (!res.ok) throw new Error(`render failed: ${res.status}: ${await res.text()}`);
    return res.blob();
  },

  /** The already-rendered PDF, if one exists — no recompile. Returns
   * null (not an error) when this exact document/template combination
   * was never rendered, so the Composer can restore a preview across
   * a page reload instead of always starting blank. */
  async getRenderedPdf(documentId: string, templateId: string): Promise<Blob | null> {
    const res = await fetch(
      `${API_BASE_URL}/documents/${documentId}/rendered?template_id=${encodeURIComponent(templateId)}`,
      { headers: authHeader() },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`fetch rendered PDF failed: ${res.status}: ${await res.text()}`);
    return res.blob();
  },

  /** Same SSE shape as streamParseCV/streamRadarRun — see
   * job_groups.py's module docstring. */
  async *streamTailorJobGroup(groupId: string): AsyncGenerator<TailorProgressEvent> {
    const res = await fetch(`${API_BASE_URL}/job-groups/${groupId}/tailor`, {
      method: "POST",
      headers: authHeader(),
    });
    if (!res.ok) throw new Error(`tailor failed: ${res.status}: ${await res.text()}`);

    for await (const { event, data } of parseSSE(res)) {
      const payload = JSON.parse(data);
      if (event === "stage") yield { type: "stage", ...payload };
      else if (event === "done") yield { type: "done", result: payload as TailoredDocument };
      else if (event === "error") yield { type: "error", message: payload.message };
    }
  },

  /** F5.7 — a per-application toggle, off by default: nothing calls
   * this unless the user explicitly asks for a cover letter. Same SSE
   * shape as streamTailorJobGroup. */
  async *streamGenerateCoverLetter(
    groupId: string,
    style?: { tone?: CoverLetterTone; length?: CoverLetterLength },
  ): AsyncGenerator<TailorProgressEvent> {
    const res = await fetch(`${API_BASE_URL}/job-groups/${groupId}/cover-letter`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ tone: style?.tone ?? "neutral", length: style?.length ?? "medium" }),
    });
    if (!res.ok) throw new Error(`cover letter generation failed: ${res.status}: ${await res.text()}`);

    for await (const { event, data } of parseSSE(res)) {
      const payload = JSON.parse(data);
      if (event === "stage") yield { type: "stage", ...payload };
      else if (event === "done") yield { type: "done", result: payload as TailoredDocument };
      else if (event === "error") yield { type: "error", message: payload.message };
    }
  },

  /** F6.8 — ready-to-copy answers to real screening questions,
   * user-supplied (pasted from the actual application) since this
   * system has no scraped screening-question data. Same SSE shape as
   * streamTailorJobGroup. */
  async *streamGenerateAnswerPack(groupId: string, questions: string[]): AsyncGenerator<TailorProgressEvent> {
    const res = await fetch(`${API_BASE_URL}/job-groups/${groupId}/answer-pack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ questions }),
    });
    if (!res.ok) throw new Error(`answer pack generation failed: ${res.status}: ${await res.text()}`);

    for await (const { event, data } of parseSSE(res)) {
      const payload = JSON.parse(data);
      if (event === "stage") yield { type: "stage", ...payload };
      else if (event === "done") yield { type: "done", result: payload as TailoredDocument };
      else if (event === "error") yield { type: "error", message: payload.message };
    }
  },

  /** Re-runs verification (and the one regeneration attempt, if
   * needed) against an already-tailored document — cheaper than a
   * full /tailor, and the recovery path for a document whose
   * verification never actually completed (e.g. a dropped connection
   * mid-run). Same event shape as streamTailorJobGroup's verifying/
   * regenerating stages. */
  async *streamReverifyDocument(documentId: string): AsyncGenerator<TailorProgressEvent> {
    const res = await fetch(`${API_BASE_URL}/documents/${documentId}/verify`, {
      method: "POST",
      headers: authHeader(),
    });
    if (!res.ok) throw new Error(`verify failed: ${res.status}: ${await res.text()}`);

    for await (const { event, data } of parseSSE(res)) {
      const payload = JSON.parse(data);
      if (event === "stage") yield { type: "stage", ...payload };
      else if (event === "done") yield { type: "done", result: payload as TailoredDocument };
      else if (event === "error") yield { type: "error", message: payload.message };
    }
  },

  getDocumentTex: (documentId: string, templateId: string) =>
    request<DocumentTex>(`/documents/${documentId}/tex?template_id=${encodeURIComponent(templateId)}`),
  saveDocumentTex: (documentId: string, templateId: string, tex: string) =>
    request<TailoredDocument>(`/documents/${documentId}/tex`, {
      method: "PUT",
      body: JSON.stringify({ template_id: templateId, tex }),
    }),
  clearDocumentTex: (documentId: string, templateId: string) =>
    request<TailoredDocument>(`/documents/${documentId}/tex?template_id=${encodeURIComponent(templateId)}`, {
      method: "DELETE",
    }),

  /** A structured, per-section hand edit (add/remove a whole
   * "experience card", add/remove/reword a bullet, edit the summary)
   * — distinct from saveDocumentTex's raw-source edit. Resets
   * `verified` server-side, since the content just changed. */
  saveDocumentDelta: (documentId: string, delta: TailoringDelta) =>
    request<TailoredDocument>(`/documents/${documentId}/delta`, {
      method: "PUT",
      body: JSON.stringify(delta),
    }),

  getActiveModelProfile: () => request<ModelProfile | null>("/model-profiles/active"),
  listModelProfiles: () => request<ModelProfile[]>("/model-profiles"),
  createModelProfile: (body: {
    name: string;
    tier_bindings: Record<string, string>;
    stage_overrides?: Record<string, string>;
  }) =>
    request<ModelProfile>("/model-profiles", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateModelProfile: (
    id: string,
    body: { name: string; tier_bindings: Record<string, string>; stage_overrides?: Record<string, string> },
  ) =>
    request<ModelProfile>(`/model-profiles/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  activateModelProfile: (id: string) =>
    request<ModelProfile>(`/model-profiles/${id}/activate`, { method: "POST" }),
  deleteModelProfile: (id: string) =>
    request<void>(`/model-profiles/${id}`, { method: "DELETE" }),

  // --- F6/F7 — pipeline board ---
  listPipelineStages: () => request<PipelineStage[]>("/pipeline-stages"),
  createPipelineStage: (body: { display_name: string }) =>
    request<PipelineStage>("/pipeline-stages", { method: "POST", body: JSON.stringify(body) }),
  renamePipelineStage: (id: string, body: { display_name: string }) =>
    request<PipelineStage>(`/pipeline-stages/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deletePipelineStage: (id: string) => request<void>(`/pipeline-stages/${id}`, { method: "DELETE" }),
  reorderPipelineStages: (stage_ids: string[]) =>
    request<PipelineStage[]>("/pipeline-stages/reorder", { method: "POST", body: JSON.stringify({ stage_ids }) }),

  createApplication: (body: {
    job_id: string;
    persona_id: string;
    job_group_id?: string;
    primary_document_id?: string;
  }) => request<Application>("/applications", { method: "POST", body: JSON.stringify(body) }),
  listApplications: (state?: string) =>
    request<Application[]>(`/applications${state ? `?state=${encodeURIComponent(state)}` : ""}`),
  getApplication: (id: string) => request<ApplicationDetail>(`/applications/${id}`),
  updateApplication: (
    id: string,
    body: { state?: string; autonomy_level?: string; primary_document_id?: string },
  ) => request<Application>(`/applications/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  markApplied: (id: string, note?: string) =>
    request<Application>(`/applications/${id}/mark-applied`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }),
  exportApplications: (format: "csv" | "json" = "csv") =>
    fetch(`${API_BASE_URL}/applications/export?format=${format}`, { headers: authHeader() }).then((r) => r.blob()),

  /** Starts a real application-agent run. An `interrupt` event pauses
   * the stream for a human decision — resolve it with streamResumeApplication,
   * which yields the same event shape and may itself pause again. */
  async *streamApply(applicationId: string): AsyncGenerator<ApplicationStreamEvent> {
    const res = await fetch(`${API_BASE_URL}/applications/${applicationId}/apply`, {
      method: "POST",
      headers: authHeader(),
    });
    if (!res.ok) throw new Error(`apply failed: ${res.status}: ${await res.text()}`);
    for await (const { event, data } of parseSSE(res)) {
      const payload = JSON.parse(data);
      if (event === "stage") yield { type: "stage", ...payload };
      else if (event === "interrupt") yield { type: "interrupt", ...payload };
      else if (event === "done") yield { type: "done", ...payload };
      else if (event === "error") yield { type: "error", message: payload.message };
    }
  },
  async *streamResumeApplication(
    applicationId: string,
    attemptId: string,
    decisions: InterruptDecision[],
  ): AsyncGenerator<ApplicationStreamEvent> {
    const res = await fetch(`${API_BASE_URL}/applications/${applicationId}/attempts/${attemptId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ decisions }),
    });
    if (!res.ok) throw new Error(`resume failed: ${res.status}: ${await res.text()}`);
    for await (const { event, data } of parseSSE(res)) {
      const payload = JSON.parse(data);
      if (event === "stage") yield { type: "stage", ...payload };
      else if (event === "interrupt") yield { type: "interrupt", ...payload };
      else if (event === "done") yield { type: "done", ...payload };
      else if (event === "error") yield { type: "error", message: payload.message };
    }
  },

  /** One-shot fetch of an attempt's full persisted log — for viewing a
   * *finished* attempt's history (any earlier attempt_number, not just
   * the latest), where there's nothing left to poll for. Same replay
   * endpoint `pollApplicationAttemptEvents` uses, just without the
   * "keep polling while running" loop. */
  async getApplicationAttemptEvents(
    applicationId: string,
    attemptId: string,
  ): Promise<ApplicationStreamEvent[]> {
    const { events } = await request<{
      run_status: string;
      events: { seq: number; event_type: string; data: Record<string, unknown> }[];
    }>(`/applications/${applicationId}/attempts/${attemptId}/events?since_seq=0`);
    return events.map((e) => toApplicationStreamEvent(e.event_type, e.data));
  },

  /** F6.7's review-before-submit screenshot — `index` supports
   * Python-style negative indexing server-side (-1 = latest), so the
   * caller doesn't need to know how many screenshots exist yet. Built
   * as a plain URL (not a fetch wrapper) since it's meant for an
   * <img src>, not JSON. */
  attemptScreenshotUrl(applicationId: string, attemptId: string, index = -1): string {
    const token = getAuthToken();
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${API_BASE_URL}/applications/${applicationId}/attempts/${attemptId}/screenshots/${index}${qs}`;
  },

  /** F6.7's review-before-submit field-by-field preview: while a
   * submit_application (or any other) interrupt is pending, the
   * browser session named in its own args is still open and paused —
   * this fetches its live accessibility-tree snapshot through the API
   * (never talks to browser-worker directly; it has no auth of its
   * own and isn't meant to be reachable from the browser). */
  getAttemptLiveSnapshot(applicationId: string, attemptId: string, sessionId: string) {
    return request<{ snapshot: string }>(
      `/applications/${applicationId}/attempts/${attemptId}/live-snapshot?session_id=${encodeURIComponent(sessionId)}`,
    );
  },

  /** The same fallback chain the application-agent's own upload tool
   * uses (an explicit primary document, then the job_group's tailored
   * documents, then the persona's own originally-uploaded CV) — no
   * longer gated on this application having a job_group_id (a
   * Composer session) at all. Returns null (not an error) when
   * nothing resolves, same "absent, not broken" convention as
   * getRenderedPdf. `filename` comes from the server's own
   * Content-Disposition header rather than being assumed — the raw-CV
   * fallback can be a `.docx` or anything else the user originally
   * uploaded, not necessarily a `.pdf` like every other document here. */
  async getApplicationDocument(
    applicationId: string,
    docType: "cv" | "cover_letter",
  ): Promise<{ blob: Blob; filename: string } | null> {
    const res = await fetch(`${API_BASE_URL}/applications/${applicationId}/documents/${docType}`, {
      headers: authHeader(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`document fetch failed: ${res.status}: ${await res.text()}`);
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const match = /filename="?([^"]+)"?/.exec(disposition);
    const filename = match?.[1] ?? `${docType}.pdf`;
    return { blob: await res.blob(), filename };
  },

  /** Reconnect/replay for an attempt this page instance didn't start
   * live — one still `in_progress`/`awaiting_*` from before a page
   * navigation, tab close, or reload. Every event `_emit`
   * (application_service.py) yields is also a durable `RunEvent` row,
   * so this replays everything since `sinceSeq` through the exact
   * same `ApplicationStreamEvent` shape the live SSE path produces —
   * the caller's event handling never needs to know whether an event
   * arrived live or replayed. While the underlying AgentRun is still
   * "running" (which stays true for the whole awaiting_review/
   * awaiting_handoff window too, not just active execution — there's
   * no separate "paused" run status), it keeps polling every 2s
   * instead of returning; the caller decides when to stop consuming
   * (e.g. on the first "interrupt" event, same as the live path). */
  async *pollApplicationAttemptEvents(
    applicationId: string,
    attemptId: string,
    sinceSeq = 0,
  ): AsyncGenerator<ApplicationStreamEvent> {
    let seq = sinceSeq;
    // Belt-and-suspenders against a genuinely wedged run (the backend's
    // own startup reconciliation — see application_service.py's
    // reconcile_stale_attempts — already closes out anything left
    // stuck by a server restart; this only guards against a run that
    // somehow never reaches a terminal state while the server stays up
    // the whole time). 900 * 2s = 30 minutes.
    for (let i = 0; i < 900; i++) {
      const { run_status, events } = await request<{
        run_status: string;
        events: { seq: number; event_type: string; data: Record<string, unknown> }[];
      }>(`/applications/${applicationId}/attempts/${attemptId}/events?since_seq=${seq}`);
      for (const e of events) {
        seq = e.seq;
        yield toApplicationStreamEvent(e.event_type, e.data);
      }
      if (run_status !== "running") return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    yield { type: "error", message: "gave up waiting for this run to settle after 30 minutes" };
  },

  // --- M7 — the conversational orchestrator ---

  /** Always a genuinely new conversation — no idempotency. "New chat"
   * has to actually mean a fresh thread, especially as the escape
   * hatch for one stuck on a decision you're not ready to make. */
  createConversation: (personaId: string, title?: string) =>
    request<Conversation>("/orchestrator/conversations", {
      method: "POST",
      body: JSON.stringify({ persona_id: personaId, title: title ?? null }),
    }),
  getConversation: (conversationId: string) =>
    request<Conversation>(`/orchestrator/conversations/${conversationId}`),
  /** Every conversation for this persona, most-recently-active first —
   * the Assistant page's own conversation list/switcher. */
  listConversations: (personaId: string) =>
    request<Conversation[]>(`/orchestrator/conversations?persona_id=${encodeURIComponent(personaId)}`),
  /** Hides a conversation from the active list without deleting its
   * history — how you walk away from one stuck on a pending decision. */
  archiveConversation: (conversationId: string) =>
    request<Conversation>(`/orchestrator/conversations/${conversationId}/archive`, { method: "POST" }),

  /** An ordinary chat turn. Streams the same stage/interrupt/done/error
   * shape as streamApply — errors inside the stream (e.g. a pending
   * interrupt already open) arrive as an "error" event, not a thrown
   * exception. */
  async *streamOrchestratorMessage(conversationId: string, text: string): AsyncGenerator<ConversationStreamEvent> {
    const res = await fetch(`${API_BASE_URL}/orchestrator/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`send message failed: ${res.status}: ${await res.text()}`);
    for await (const { event, data } of parseSSE(res)) {
      const payload = JSON.parse(data);
      if (event === "stage") yield { type: "stage", ...payload };
      else if (event === "interrupt") yield { type: "interrupt", ...payload };
      else if (event === "done") yield { type: "done", ...payload };
      else if (event === "error") yield { type: "error", message: payload.message };
      else if (event === "card") yield { type: "card", ...payload };
    }
  },

  /** Resolves the conversation's current pending ask_user interrupt. */
  async *streamOrchestratorResume(
    conversationId: string,
    decisions: InterruptDecision[],
  ): AsyncGenerator<ConversationStreamEvent> {
    const res = await fetch(`${API_BASE_URL}/orchestrator/conversations/${conversationId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ decisions }),
    });
    if (!res.ok) throw new Error(`resume failed: ${res.status}: ${await res.text()}`);
    for await (const { event, data } of parseSSE(res)) {
      const payload = JSON.parse(data);
      if (event === "stage") yield { type: "stage", ...payload };
      else if (event === "interrupt") yield { type: "interrupt", ...payload };
      else if (event === "done") yield { type: "done", ...payload };
      else if (event === "error") yield { type: "error", message: payload.message };
      else if (event === "card") yield { type: "card", ...payload };
    }
  },

  /** Full replay — a conversation's whole event history is small
   * (turns x tens of events, not radar's thousands), so unlike the
   * application-attempt endpoints this isn't incremental; the caller
   * just re-renders the whole log on load/reconnect. */
  async getConversationEvents(conversationId: string): Promise<{
    runStatus: string;
    pendingInterrupt: { requests: InterruptRequest[] } | null;
    events: ConversationStreamEvent[];
  }> {
    const result = await request<{
      status: string;
      pending_interrupt: { requests: InterruptRequest[] } | null;
      run_status: string;
      events: { created_at: string; event_type: string; data: Record<string, unknown> }[];
    }>(`/orchestrator/conversations/${conversationId}/events`);
    return {
      runStatus: result.run_status,
      pendingInterrupt: result.pending_interrupt,
      events: result.events.map((e) => toConversationStreamEvent(e.event_type, e.data)),
    };
  },

  // SaaS pivot — admin-only (backend 403s a non-admin regardless of
  // whether the frontend nav hid these).
  listAdminUsers: () => request<AdminUser[]>("/admin/users"),
  suspendUser: (userId: string) => request<AdminUser>(`/admin/users/${userId}/suspend`, { method: "POST" }),
  unsuspendUser: (userId: string) => request<AdminUser>(`/admin/users/${userId}/unsuspend`, { method: "POST" }),
  promoteUser: (userId: string) => request<AdminUser>(`/admin/users/${userId}/promote`, { method: "POST" }),
  demoteUser: (userId: string) => request<AdminUser>(`/admin/users/${userId}/demote`, { method: "POST" }),

  listBillingPlans: () => request<Plan[]>("/billing/plans"),
  getMySubscription: () => request<Subscription>("/billing/subscription"),
  startCheckout: (planId: string) =>
    request<{ checkout_url: string }>("/billing/checkout", { method: "POST", body: JSON.stringify({ plan_id: planId }) }),
  syncSubscription: () => request<Subscription>("/billing/sync", { method: "POST" }),

  listPlans: () => request<Plan[]>("/admin/plans"),
  createPlan: (body: { name: string; price_idr: number; monthly_usage_cap_usd: number; is_active?: boolean }) =>
    request<Plan>("/admin/plans", { method: "POST", body: JSON.stringify(body) }),
  updatePlan: (id: string, body: Partial<Pick<Plan, "name" | "price_idr" | "monthly_usage_cap_usd" | "is_active">>) =>
    request<Plan>(`/admin/plans/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
};
