import { getCachedBaseCvBlob, invalidateBaseCvCache, setCachedBaseCvBlob } from "@/lib/base-cv-cache";

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

// Carries the real HTTP status alongside the message `request()` was
// already building — added so callers that need to tell "the token is
// genuinely invalid" (401) apart from "the server hiccuped" (anything
// else) actually can. auth.tsx's mount-time /auth/me check is the
// motivating case: it used to catch ANY failure here — a real 401, a
// 500, or the API being briefly unreachable mid-restart — identically,
// wiping a perfectly good token and bouncing the user to /login just
// because the server was down for a second (confirmed live: refreshing
// mid interview-practice session, a long-running feature, was enough
// to occasionally land right in that window). `status` is 0 for a
// failure that never got an HTTP response at all (fetch itself threw —
// offline, DNS, connection refused).
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export type SiteContent = {
  demo_video_url: string | null;
  // slot -> a URL to fetch the admin-uploaded override image from, or
  // null (use the bundled default asset in web/public/screenshots/).
  media: Record<string, string | null>;
};

export type User = {
  id: string;
  email: string;
  role: "user" | "admin";
  email_verified: boolean;
  // false for a Google-only account (no password at all) — Settings
  // shows "Set a password" instead of "Change password" for that case.
  has_password: boolean;
};

// SaaS pivot — admin-only surfaces.
// Phase 16 — credits only, deliberately no `$` field here at all.
// `monthly_usage_cap_usd` doesn't exist ANYWHERE any more, admin
// included — removed entirely (Adrian, direct: it was fully vestigial,
// zero enforcement code left standing since Phase 16), not just kept
// off the public shape.
export type Plan = {
  id: string;
  name: string;
  price_idr: number;
  monthly_credits: number;
  is_active: boolean;
};

// Admin-only view — adds Dodo's own product ids, split test/live since
// they're never the same object in Dodo (moving from test to live
// broke checkout precisely because one shared id was being reused
// across both, raised directly by Adrian). The public billing plans
// list (Plan above) never exposes these.
export type AdminPlan = Plan & {
  dodo_product_id_test: string | null;
  dodo_product_id_live: string | null;
};

export type Subscription = {
  plan_id: string;
  plan_name: string;
  price_idr: number;
  monthly_credits: number;
  credits_monthly: number;
  credits_purchased: number;
  credits_total: number;
  status: string;
  current_period_end: string | null;
  pending_plan_id: string | null;
  pending_plan_name: string | null;
  cancel_at_period_end: boolean;
};

export type AdminUser = {
  id: string;
  email: string;
  role: "user" | "admin";
  is_active: boolean;
  created_at: string;
  plan_name: string | null;
  subscription_status: string | null;
  current_period_spend_usd: number; // admin/internal-only real $ cost
  credits_total: number;
};

export type FeatureCreditCost = {
  id: string;
  key: string;
  display_name: string;
  credit_cost: number;
  is_active: boolean;
};

export type CreditPack = {
  id: string;
  name: string;
  price_idr: number;
  credits: number;
  is_active: boolean;
};

export type AdminCreditPack = CreditPack & {
  dodo_product_id_test: string | null;
  dodo_product_id_live: string | null;
};

export type CreditTransaction = {
  id: string;
  type: "monthly_grant" | "purchase" | "usage" | "admin_grant" | "admin_adjustment" | "expiration";
  bucket: "monthly" | "purchased";
  amount: number;
  balance_after: number;
  description: string;
  created_at: string;
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
  polling_enabled: boolean;
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
  // Phase 11 (v2 plan) — only ever populated on a "speech" capability
  // entry (a TTS model's real named-voice list).
  voices: string[] | null;
  // Phase 11 (v2 plan) follow-up — a transcription/speech entry's real
  // billing unit (per input-minute / per input-character), separate
  // from input_price_per_mtok/output_price_per_mtok above since those
  // mean something different (per million TEXT tokens) — see
  // ModelCatalogEntry's own docstring (api/.../models/llm.py) for the
  // live-verified reasoning. At most one of these two is ever set.
  price_per_minute: number | null;
  price_per_character: number | null;
};

// Phase 11 (v2 plan) — the Models & Providers page's Audio section.
// Singleton for the whole deployment (get-or-create server-side, no
// list of named presets the way ModelProfile has).
export type AudioSettings = {
  transcribe_catalog_entry_id: string | null;
  speech_catalog_entry_id: string | null;
  // "Moderator / interviewer" voice — the single voice for plain
  // 1-on-1 interview mode, and the moderator's own lines in FGD/LGD.
  speech_voice: string | null;
  // FGD/LGD's "everyone but the moderator" voice — a real group
  // discussion needs at least two distinct voices to not sound like
  // one person reading every part.
  speech_voice_secondary: string | null;
};

export type CvScoreCategory = { category: string; score: number; feedback: string };
export type CvScore = {
  overall_score: number;
  summary: string;
  strengths: string[];
  improvements: string[];
  categories: CvScoreCategory[];
};
export type CvFixResult = { updated_count: number; notes: string };

export type Profile = {
  id: string;
  user_id: string;
  revision: number;
  confirmed: boolean;
  parsed_profile: ParsedProfile;
  parsed_at: string | null;
  visa_status: string | null;
  notice_period_days: number | null;
  cv_score: CvScore | null;
  cv_scored_at: string | null;
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
  target_role_title: string | null;
  target_company: string | null;
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

// Phase 10 (v2 plan) — mirrors skill_gap_syllabus_engine.SkillGapSyllabusOutput.
export type SyllabusResource = { title: string; url: string; kind: string };
export type SyllabusProjectIdea = { title: string; description: string };
export type SkillGapSyllabus = { resources: SyllabusResource[]; project_ideas: SyllabusProjectIdea[] };

export type SkillGapItem = {
  id: string;
  job_group_id: string;
  skill_text: string;
  status: "pending" | "done";
  evidence_item_id: string | null;
  syllabus: SkillGapSyllabus | null;
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
  in_pipeline: boolean;
};

export type InboxJobDetail = InboxJob & {
  requirements: string | null;
  responsibilities: string | null;
  benefits: string | null;
  sightings: JobSighting[];
};

// Manual job entry — type every field in by hand, or paste a URL and
// let parseJobUrl prefill this same shape for review before saving.
export type JobDraft = {
  title: string;
  company_name: string;
  location?: string | null;
  remote_policy?: string | null;
  seniority?: string | null;
  employment_type?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  salary_currency?: string | null;
  requirements?: string | null;
  responsibilities?: string | null;
  benefits?: string | null;
  apply_url?: string | null;
  source_url?: string | null;
};

export type ParsedJob = {
  found: boolean;
  title: string | null;
  company_name: string | null;
  location: string | null;
  remote_policy: string | null;
  seniority: string | null;
  employment_type: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  requirements: string | null;
  responsibilities: string | null;
  benefits: string | null;
  apply_url: string | null;
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

// Phase 9 (v2 plan) — Calendar. Mirrors schemas.CALENDAR_EVENT_TYPES.
export const CALENDAR_EVENT_TYPES = ["interview", "assessment_deadline", "application_deadline", "custom"] as const;

export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];

export const CALENDAR_EVENT_TYPE_LABEL: Record<CalendarEventType, string> = {
  interview: "Interview",
  assessment_deadline: "Assessment deadline",
  application_deadline: "Application deadline",
  custom: "Custom",
};

export type CalendarEvent = {
  id: string;
  application_id: string | null;
  job_id: string | null;
  event_type: CalendarEventType;
  title: string;
  scheduled_at: string;
  notes: string | null;
  job_title: string;
  company_name: string;
};

// Phase 11 (v2 plan) — AI interview/FGD/LGD practice. Mirrors
// schemas.INTERVIEW_PRACTICE_TYPES/INTERVIEW_CATEGORIES.
export const INTERVIEW_PRACTICE_TYPES = ["interview", "fgd", "lgd"] as const;
export type InterviewPracticeType = (typeof INTERVIEW_PRACTICE_TYPES)[number];

export const INTERVIEW_PRACTICE_TYPE_LABEL: Record<InterviewPracticeType, string> = {
  interview: "1-on-1 interview",
  fgd: "FGD — focus group discussion",
  lgd: "LGD — leaderless group discussion",
};

export const INTERVIEW_CATEGORIES = ["screening", "hr", "user", "role", "experience", "all"] as const;
export type InterviewCategory = (typeof INTERVIEW_CATEGORIES)[number];

export const INTERVIEW_CATEGORY_LABEL: Record<InterviewCategory, string> = {
  screening: "Screening",
  hr: "HR round",
  user: "User / hiring manager",
  role: "Role-specific",
  experience: "Experience-based",
  all: "All of the above",
};

// Adrian, direct: "option to select language that will be spoken
// during the interview... default language to be based on the
// location of the job." The value IS the plain, human-readable
// language name — sent straight to the backend and interpolated
// directly into the agent's task instructions (interview_service.py's
// _session_context_block), so there's no separate code<->label map to
// keep in sync on either side, same "free text, no vocabulary drift"
// reasoning topic_hint already follows.
export const INTERVIEW_LANGUAGES = [
  "English",
  "Indonesian",
  "Spanish",
  "Portuguese",
  "French",
  "German",
  "Italian",
  "Dutch",
  "Russian",
  "Ukrainian",
  "Polish",
  "Romanian",
  "Greek",
  "Swedish",
  "Norwegian",
  "Danish",
  "Finnish",
  "Czech",
  "Hungarian",
  "Turkish",
  "Persian (Farsi)",
  "Hebrew",
  "Arabic",
  "Mandarin Chinese",
  "Japanese",
  "Korean",
  "Hindi",
  "Bengali",
  "Urdu",
  "Punjabi",
  "Tamil",
  "Telugu",
  "Marathi",
  "Gujarati",
  "Vietnamese",
  "Thai",
  "Tagalog (Filipino)",
  "Malay",
  "Burmese",
  "Khmer",
  "Lao",
  "Swahili",
] as const;
export type InterviewLanguage = (typeof INTERVIEW_LANGUAGES)[number];

// Adrian, direct: "add flags to the list of languages" — display-only,
// never sent to the backend (the plain name above still is — a flag
// isn't a language, and several of these languages are official/widely
// spoken across more than one country regardless). Picked one
// representative, widely-recognized flag per language purely for the
// Select's own visual scan-ability.
export const INTERVIEW_LANGUAGE_FLAG: Record<InterviewLanguage, string> = {
  English: "🇺🇸",
  Indonesian: "🇮🇩",
  Spanish: "🇪🇸",
  Portuguese: "🇵🇹",
  French: "🇫🇷",
  German: "🇩🇪",
  Italian: "🇮🇹",
  Dutch: "🇳🇱",
  Russian: "🇷🇺",
  Ukrainian: "🇺🇦",
  Polish: "🇵🇱",
  Romanian: "🇷🇴",
  Greek: "🇬🇷",
  Swedish: "🇸🇪",
  Norwegian: "🇳🇴",
  Danish: "🇩🇰",
  Finnish: "🇫🇮",
  Czech: "🇨🇿",
  Hungarian: "🇭🇺",
  Turkish: "🇹🇷",
  "Persian (Farsi)": "🇮🇷",
  Hebrew: "🇮🇱",
  Arabic: "🇸🇦",
  "Mandarin Chinese": "🇨🇳",
  Japanese: "🇯🇵",
  Korean: "🇰🇷",
  Hindi: "🇮🇳",
  Bengali: "🇧🇩",
  Urdu: "🇵🇰",
  Punjabi: "🇮🇳",
  Tamil: "🇮🇳",
  Telugu: "🇮🇳",
  Marathi: "🇮🇳",
  Gujarati: "🇮🇳",
  Vietnamese: "🇻🇳",
  Thai: "🇹🇭",
  "Tagalog (Filipino)": "🇵🇭",
  Malay: "🇲🇾",
  Burmese: "🇲🇲",
  Khmer: "🇰🇭",
  Lao: "🇱🇦",
  Swahili: "🇰🇪",
};

/** Guesses a spoken language from a job's free-text location string —
 * the DEFAULT only, always overridable via the language Select. Not
 * exhaustive; anything unrecognized (including "Remote", US/UK/AU/SG
 * locations, etc.) falls back to English, same as manual-target
 * sessions with no location at all. */
export function inferLanguageFromLocation(location: string | null | undefined): InterviewLanguage {
  const l = (location ?? "").toLowerCase();
  const hit = (...needles: string[]) => needles.some((n) => l.includes(n));
  if (hit("indonesia", "jakarta", "bandung", "surabaya", "bali", "medan", "yogyakarta", "semarang")) return "Indonesian";
  if (hit("mexico", "spain", "argentina", "colombia", "chile", "peru", "madrid", "barcelona", "bogot")) return "Spanish";
  if (hit("brazil", "portugal", "lisbon", "sao paulo", "são paulo", "rio de janeiro")) return "Portuguese";
  if (hit("france", "paris")) return "French";
  if (hit("germany", "berlin", "munich", "frankfurt")) return "German";
  if (hit("italy", "rome", "milan", "milano")) return "Italian";
  if (hit("netherlands", "amsterdam", "rotterdam", "the hague")) return "Dutch";
  if (hit("russia", "moscow", "saint petersburg")) return "Russian";
  if (hit("ukraine", "kyiv", "kiev")) return "Ukrainian";
  if (hit("poland", "warsaw", "krakow", "kraków")) return "Polish";
  if (hit("romania", "bucharest")) return "Romanian";
  if (hit("greece", "athens")) return "Greek";
  if (hit("sweden", "stockholm")) return "Swedish";
  if (hit("norway", "oslo")) return "Norwegian";
  if (hit("denmark", "copenhagen")) return "Danish";
  if (hit("finland", "helsinki")) return "Finnish";
  if (hit("czech", "prague")) return "Czech";
  if (hit("hungary", "budapest")) return "Hungarian";
  if (hit("turkey", "istanbul", "ankara")) return "Turkish";
  if (hit("iran", "tehran")) return "Persian (Farsi)";
  if (hit("israel", "tel aviv", "jerusalem")) return "Hebrew";
  if (hit("saudi", "uae", "dubai", "abu dhabi", "riyadh", "egypt", "qatar", "kuwait", "cairo", "jordan", "lebanon")) return "Arabic";
  if (hit("china", "beijing", "shanghai", "shenzhen", "guangzhou", "taiwan", "taipei")) return "Mandarin Chinese";
  if (hit("japan", "tokyo", "osaka", "yokohama")) return "Japanese";
  if (hit("korea", "seoul")) return "Korean";
  if (hit("bangladesh", "dhaka")) return "Bengali";
  if (hit("pakistan", "karachi", "lahore", "islamabad")) return "Urdu";
  if (hit("india", "delhi", "mumbai", "bangalore", "bengaluru", "hyderabad", "pune", "chennai", "kolkata")) return "Hindi";
  if (hit("vietnam", "hanoi", "ho chi minh")) return "Vietnamese";
  if (hit("thailand", "bangkok")) return "Thai";
  if (hit("philippines", "manila", "cebu", "quezon city")) return "Tagalog (Filipino)";
  if (hit("malaysia", "kuala lumpur")) return "Malay";
  if (hit("myanmar", "yangon")) return "Burmese";
  if (hit("cambodia", "phnom penh")) return "Khmer";
  if (hit(" laos", "vientiane")) return "Lao";
  if (hit("kenya", "tanzania", "nairobi", "dar es salaam")) return "Swahili";
  return "English";
}

export type InterviewFeedback = {
  overall_score: number;
  summary: string;
  categories: { category: string; score: number; notes: string }[];
  strengths: string[];
  areas_to_improve: string[];
};

export type InterviewSession = {
  id: string;
  persona_id: string;
  job_id: string | null;
  application_id: string | null;
  role_title: string | null;
  company_name: string | null;
  seniority: string | null;
  practice_type: InterviewPracticeType;
  category: InterviewCategory | null;
  topic_hint: string | null;
  language: string | null;
  status: "in_progress" | "completed" | "cancelled";
  overall_score: number | null;
  feedback: InterviewFeedback | null;
  created_at: string;
  ended_at: string | null;
  /** The interviewer/moderator's own last line — set only by the LIST
   * endpoint (routers/interview_sessions.py), null from a single-session
   * GET (that page shows the full transcript instead). */
  last_message_preview: string | null;
};

// Coarser than ApplicationStreamEvent/ConversationStreamEvent — one
// interview turn is bounded (transcribe -> agent -> synthesize), so
// interview_service.py emits plain stage markers rather than the
// tool-call-by-tool-call granularity the other two agents stream.
export type InterviewTurnEvent =
  | { type: "stage"; stage: string; status: string; message: string }
  | { type: "message"; role: "user"; text: string }
  // Real-time TTS streaming (raised directly by Adrian — hearing the
  // reply as it's generated instead of waiting out the whole clip).
  // One audio_start/audio_chunk*/audio_end cycle per SPEAKER SEGMENT
  // — plain interview mode is always exactly one cycle (role is
  // always "moderator" then); FGD/LGD is one cycle per "Speaker:
  // text" line, `role` telling the frontend which of the two
  // visualizers to light up and which voice this segment used.
  // audio_start's sample_rate/channels describe every audio_chunk
  // that follows it, until the next audio_start (16-bit signed PCM,
  // little-endian, interleaved by channel — interview_media.py always
  // requests this from the provider); audio_chunk's `data` is one
  // chunk, base64-encoded. The turn's one combined replay clip's
  // filename only ever arrives on the "done" event below, not here.
  | { type: "audio_start"; sample_rate: number; channels: number; speaker: string | null; role: "moderator" | "discusser" }
  | { type: "audio_chunk"; data: string }
  | { type: "audio_end" }
  // audio_filename is null when speech synthesis failed for this turn
  // entirely (e.g. a very long FGD/LGD reply past the provider's own
  // TTS input-size limit, or a stream that dropped mid-way) — the
  // reply text is always real either way, so the turn still succeeds
  // text-only rather than erroring out.
  | { type: "done"; reply_text: string; audio_filename: string | null }
  // The interviewer/moderator's own end_interview tool decided to end
  // the session (raised directly by Adrian: the agent can end things
  // itself, not just the human clicking "End session") — arrives
  // right after this turn's own "done" event, once its closing remark
  // has already been queued to play. Same fields interview_service.py's
  // end_interview_session (the shared scoring path both this and the
  // manual endInterviewSession call go through) produces.
  | { type: "session_ended"; status: string; overall_score: number | null; feedback: InterviewFeedback | null; ended_at: string | null }
  | { type: "error"; message: string };

function toInterviewTurnEvent(eventType: string, data: Record<string, unknown>): InterviewTurnEvent {
  return { type: eventType as InterviewTurnEvent["type"], ...data } as InterviewTurnEvent;
}

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
  // "cv" and/or "cover_letter" — whichever this application actually
  // resolves to (an explicit primary document, this job_group's
  // tailored ones, or the persona's own originally-uploaded CV). Lets
  // the Pipeline panel show a real "View CV" action regardless of
  // whether there's an apply-by-email draft.
  available_documents: ("cv" | "cover_letter" | "answer_pack")[];
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
  | { type: "cancelled"; attempt_id: string }
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
  | { card_type: "application"; application_id: string; attempt_id: string | null; session_id: string | null }
  | {
      card_type: "calendar_event";
      calendar_event_id: string;
      title: string;
      event_type: CalendarEventType;
      scheduled_at: string;
    }
  | {
      card_type: "documents";
      documents: { document_id: string; job_group_name: string; version: number; verified: boolean }[];
    }
  | {
      card_type: "interview_session";
      interview_session_id: string;
      practice_type: InterviewPracticeType;
      role_title: string | null;
      company_name: string | null;
    };

export type ConversationStreamEvent =
  | { type: "stage"; stage: string; status: string; message: string }
  // The human's own side of the turn, persisted as a durable RunEvent
  // (fixed alongside the "saved chats only show the AI's response"
  // report — it used to only ever exist as an optimistic client-side
  // log entry, never written down, so it vanished on reload or when
  // switching conversations).
  | { type: "message"; role: "user"; text: string }
  | { type: "interrupt"; requests: InterruptRequest[] }
  | { type: "done" }
  | { type: "cancelled" }
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
      auto_added_to_pipeline: boolean;
    }
  | { type: "job_scoring_error"; job_id: string; title: string; message: string }
  | { type: "scoring_done"; kept: number; dropped: number; review: number; errors: number }
  | { type: "done"; result: RadarRunResult };

// Phase 16 — a 402 (insufficient credits, credit_ledger.require_credits
// on the backend) needs to surface as a real "go buy/upgrade" dialog,
// not just another string in a toast, and needs to work from ANY call
// site across the whole app (dozens of pages, plus the Assistant's own
// SSE stream) without touching every one of them individually. This
// module has no React tree of its own to render a dialog into, so it
// exposes one registration slot instead — InsufficientCreditsProvider
// (components/insufficient-credits-provider.tsx) calls
// setInsufficientCreditsHandler once, on mount, and every place below
// that already turns a non-2xx response into an error (request()
// itself, and checkStreamResponse for the many SSE-streaming
// endpoints) calls it in passing before throwing, so nothing else in
// this file (or any page) needs to know this dialog exists.
let insufficientCreditsHandler: ((message: string) => void) | null = null;
export function setInsufficientCreditsHandler(handler: ((message: string) => void) | null) {
  insufficientCreditsHandler = handler;
}

function extractErrorMessage(body: string): string {
  // FastAPI's HTTPException(status, "message") serializes as
  // {"detail": "message"} — surfaced as-is when present; the raw body
  // otherwise (some error paths in this API aren't HTTPException at all).
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.detail === "string") return parsed.detail;
  } catch {
    // not JSON — fall through to the raw body
  }
  return body;
}

function reportIfInsufficientCredits(status: number, body: string) {
  if (status === 402 && insufficientCreditsHandler) insufficientCreditsHandler(extractErrorMessage(body));
}

// Shared by every SSE-streaming endpoint's own `fetch()` call (they
// can't all go through request() below — most are POST-with-body
// followed by parseSSE, not a single JSON round-trip) so a 402 from
// any of them reports the same way request() does, in one place
// rather than repeated at each of the dozen-plus call sites.
async function checkStreamResponse(res: Response, context: string): Promise<void> {
  if (!res.ok) {
    const body = await res.text();
    reportIfInsufficientCredits(res.status, body);
    // The raw body is a JSON envelope ({"detail": "..."}) for a real
    // FastAPI HTTPException, which every 4xx from this app's own
    // preconditions is — dumping it verbatim in a toast (raised
    // directly by Adrian, seeing the full `{"detail": "..."}` blob)
    // is illegible; extractErrorMessage unwraps it to the plain
    // sentence, falling back to the raw body for the rare non-JSON
    // error path.
    throw new ApiError(`${context} failed: ${extractErrorMessage(body)}`, res.status);
  }
}

// Same "one registration slot, called in passing from every relevant
// call site" shape as setInsufficientCreditsHandler right above — the
// sidebar's own credit balance (app-shell.tsx) otherwise only ever
// refetched on a route change or a 30s poll, which read as "credits
// don't update in real time" (Adrian, direct) when a feature was used
// without navigating away. A plain DOM CustomEvent, not a React
// context — this module has no component tree of its own, and a
// browser event is the one thing every mounted listener (there's only
// ever one, app-shell.tsx, but nothing stops there being more later)
// can subscribe to without this file importing React. Called right
// after every generator/request below that credit_ledger.charge_credits
// can actually fire from — never a guess at WHICH one changed the
// balance, since app-shell.tsx just refetches the real total either way.
export const CREDITS_CHANGED_EVENT = "applicient:credits-changed";
function notifyCreditsChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CREDITS_CHANGED_EVENT));
}

// Same mechanism, same reason, for the onboarding checklist
// (floating-onboarding.tsx / console/page.tsx's OnboardingProgressPreview)
// — Adrian, direct: "same way credits dont update real time, the
// onboarding progression doesnt update real time." Every step is
// computed server-side from real rows existing (dashboard_service.py's
// get_onboarding_progress) rather than a tracked flag, so — unlike
// credits, which only ever change at a handful of known charge
// points — almost any mutating request could be the one that just
// completed a step (creating a persona, saving preferences, adding
// evidence, creating a saved search/application/calendar event).
// request() below fires this generically by path prefix rather than
// hand-wiring a notify call at each of those call sites individually;
// the SSE-streamed ones (CV parse, CV tailor, interview session
// creation) still need their own explicit call since they bypass
// request() entirely.
export const ONBOARDING_CHANGED_EVENT = "applicient:onboarding-changed";
function notifyOnboardingChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ONBOARDING_CHANGED_EVENT));
}
const _ONBOARDING_RELEVANT_PATH_PREFIXES = [
  "/personas",
  "/evidence-items",
  "/preferences",
  "/saved-searches",
  "/applications",
  "/calendar-events",
];
function _pathIsOnboardingRelevant(path: string): boolean {
  return _ONBOARDING_RELEVANT_PATH_PREFIXES.some((p) => path.includes(p));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...authHeader(), ...init?.headers },
    });
  } catch (e) {
    // fetch() itself threw — no HTTP response at all (offline, DNS,
    // connection refused because the server is momentarily down).
    // status 0 distinguishes this from a real HTTP error status.
    throw new ApiError(`${init?.method ?? "GET"} ${path} -> network error: ${e}`, 0);
  }
  if (!res.ok) {
    const body = await res.text();
    reportIfInsufficientCredits(res.status, body);
    // Same unwrap as checkStreamResponse — a plain sentence in the
    // toast instead of the raw `{"detail": "..."}` JSON envelope.
    throw new ApiError(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${extractErrorMessage(body)}`, res.status);
  }
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && _pathIsOnboardingRelevant(path)) notifyOnboardingChanged();
  if (res.status === 204) return undefined as T;
  return res.json();
}

// Phase 14 (v2 plan) — the /console dashboard home's stats.
export type DashboardStageCount = { stage: string; display_name: string; count: number };
export type DashboardDailyActivity = { date: string; jobs_discovered: number; applications_created: number };
export type DashboardSummary = {
  job_count: number;
  document_count: number;
  applications_by_stage: DashboardStageCount[];
  daily_activity: DashboardDailyActivity[];
};

// Home page's onboarding checklist — each step is computed server-side
// from real data (a row exists or it doesn't), not a separately-tracked
// "did they click through this" flag.
export type OnboardingStep = {
  key: "persona" | "cv" | "job_search" | "compose_cv" | "apply" | "interview_practice" | "tracking";
  label: string;
  done: boolean;
  href: string | null;
};
export type OnboardingProgress = { steps: OnboardingStep[]; completed: number; total: number };

export const api = {
  /** No access_token in the response anymore — a new account can't
   * sign in until its email is verified (Adrian, direct), so signup()
   * only ever returns the email for the "check your inbox" waiting
   * page to display. */
  signup: (email: string, password: string) =>
    request<{ email: string }>("/auth/signup", {
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
  /** Unauthenticated by necessity — a just-signed-up user waiting on
   * the verification page has no token. Server-side rate-limited to
   * one send per 60s per email regardless of what the caller does
   * client-side (see resend-verification-button.tsx's own cooldown). */
  resendVerification: (email: string) =>
    request<void>("/auth/resend-verification", { method: "POST", body: JSON.stringify({ email }) }),

  /** Unauthenticated by necessity, same anti-enumeration shape as
   * resendVerification above — always resolves regardless of whether
   * the address is registered/Google-only, rate-limited server-side
   * (60s/1 send) by the email itself. */
  forgotPassword: (email: string) =>
    request<void>("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) }),
  /** `token` is whatever /reset-password?token=... on this page's own
   * URL carried in from the emailed link — see
   * routers/auth.py's reset_password for what makes a token valid
   * (signature, 1h expiry, and the fingerprinted current password
   * hash — reused or expired tokens both 400). */
  resetPassword: (token: string, newPassword: string) =>
    request<void>("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, new_password: newPassword }),
    }),
  /** Authenticated. `currentPassword` is required unless
   * `user.has_password` is false (a Google-only account setting a
   * password for the first time — routers/auth.py's change_password
   * skips the current-password check only in that case). */
  changePassword: (currentPassword: string | null, newPassword: string) =>
    request<void>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),

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
  updateGmailConnection: (id: string, body: Partial<{ scan_window_days: number; polling_enabled: boolean }>) =>
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

  getAudioSettings: () => request<AudioSettings>("/audio-settings"),
  updateAudioSettings: (body: AudioSettings) =>
    request<AudioSettings>("/audio-settings", { method: "PUT", body: JSON.stringify(body) }),

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
  resetProfile: async (id: string) => {
    const result = await request<Profile>(`/profiles/${id}/reset`, { method: "POST" });
    invalidateBaseCvCache(); // wipes the evidence bank entirely
    return result;
  },
  /** Free — general, non-job-specific CV quality feedback, shown on
   * the Base CV page. Also fired automatically right after a fresh
   * CV parse (routers/cv.py's own "scoring" stage), so this is only
   * needed for an explicit "Re-analyze" click. */
  scoreCv: (profileId: string) => request<Profile>(`/profiles/${profileId}/cv-score`, { method: "POST" }),
  /** "Fix my CV" — rewrites weak evidence-bank wording in place
   * (never facts/metrics). Costs credits (first use free). */
  fixCv: async (profileId: string) => {
    const result = await request<CvFixResult>(`/profiles/${profileId}/cv-fix`, { method: "POST" });
    notifyCreditsChanged();
    invalidateBaseCvCache(); // rewrote evidence-bank wording — the cached render no longer matches
    return result;
  },

  listEvidence: (profileId: string) =>
    request<EvidenceItem[]>(`/profiles/${profileId}/evidence-items`),
  createEvidence: async (
    profileId: string,
    body: {
      category: EvidenceCategory;
      title?: string | null;
      text: string;
      skills?: string[];
      metrics?: Record<string, string>;
      employer?: string | null;
      date_start?: string | null;
      date_end?: string | null;
    },
  ) => {
    const result = await request<EvidenceItem>(`/profiles/${profileId}/evidence-items`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    invalidateBaseCvCache();
    return result;
  },
  deleteEvidence: async (profileId: string, evidenceId: string) => {
    const result = await request<void>(`/profiles/${profileId}/evidence-items/${evidenceId}`, {
      method: "DELETE",
    });
    invalidateBaseCvCache();
    return result;
  },
  updateEvidence: async (
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
  ) => {
    const result = await request<EvidenceItem>(`/profiles/${profileId}/evidence-items/${evidenceId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    invalidateBaseCvCache();
    return result;
  },

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
    await checkStreamResponse(res, "CV parse");

    for await (const { event, data } of parseSSE(res)) {
      const payload = JSON.parse(data);
      if (event === "stage") yield { type: "stage", ...payload };
      else if (event === "done") yield { type: "done", result: payload as CVParseResult };
      else if (event === "error") yield { type: "error", message: payload.message };
    }
    notifyOnboardingChanged(); // populates the evidence bank — the "Upload your CV" step
    invalidateBaseCvCache(); // a fresh evidence bank makes any cached Base CV render stale
  },

  /** Same SSE shape as streamParseCV — see radar.py's module docstring
   * for what each event ties to. */
  async *streamRadarRun(savedSearchId: string): AsyncGenerator<RadarRunProgressEvent> {
    const res = await fetch(`${API_BASE_URL}/saved-searches/${savedSearchId}/run`, {
      method: "POST",
      headers: authHeader(),
    });
    await checkStreamResponse(res, "radar run");

    for await (const { event, data } of parseSSE(res)) {
      yield toRadarProgressEvent(event, JSON.parse(data));
    }
    notifyCreditsChanged();
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
      if (err instanceof ApiError && err.status === 404) return null;
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

  listCalendarEvents: () => request<CalendarEvent[]>("/calendar-events"),
  createCalendarEvent: (body: {
    application_id?: string | null;
    job_id?: string | null;
    event_type: CalendarEventType;
    title: string;
    scheduled_at: string;
    notes?: string | null;
  }) => request<CalendarEvent>("/calendar-events", { method: "POST", body: JSON.stringify(body) }),
  updateCalendarEvent: (
    id: string,
    body: Partial<Pick<CalendarEvent, "event_type" | "title" | "scheduled_at" | "notes">> & {
      application_id?: string | null;
    },
  ) => request<CalendarEvent>(`/calendar-events/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteCalendarEvent: (id: string) => request<void>(`/calendar-events/${id}`, { method: "DELETE" }),
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
  /** Preview only — never saves anything. Pastes a job posting URL
   * (any site) through a real browser + LLM extraction; the result
   * prefills the manual "Add job" form for review before createJob
   * actually saves it. `found: false` means it didn't look like a
   * real job posting page. */
  parseJobUrl: (url: string) =>
    request<ParsedJob>("/jobs/parse-url", { method: "POST", body: JSON.stringify({ url }) }),
  createJob: (body: JobDraft) => request<InboxJob>("/jobs", { method: "POST", body: JSON.stringify(body) }),
  scoreJob: (jobId: string, personaId: string) =>
    request<InboxJob>(`/jobs/${jobId}/score`, { method: "POST", body: JSON.stringify({ persona_id: personaId }) }),

  // --- M3 §2-4/F5.10 — job groups, tailoring, verification, rendering ---

  listJobGroups: (personaId: string) => request<JobGroup[]>(`/personas/${personaId}/job-groups`),
  createJobGroup: (
    personaId: string,
    body: { name: string; job_ids?: string[]; target_role_title?: string | null; target_company?: string | null },
  ) => request<JobGroup>(`/personas/${personaId}/job-groups`, { method: "POST", body: JSON.stringify(body) }),
  updateJobGroup: (id: string, body: { name?: string; target_role_title?: string | null; target_company?: string | null }) =>
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
  generateSkillGapSyllabus: async (groupId: string, itemId: string) => {
    const result = await request<SkillGapItem>(`/job-groups/${groupId}/skill-gap/${itemId}/generate-syllabus`, {
      method: "POST",
    });
    notifyCreditsChanged();
    return result;
  },
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
    await checkStreamResponse(res, "render");
    return res.blob();
  },

  /** An untailored CV straight from the persona's evidence bank — no
   * job group required. Stateless server-side (nothing persisted, so
   * there's no `getRendered` counterpart to restore from) — but
   * cached client-side for a few minutes (base-cv-cache.ts, Adrian
   * direct: "I want a cache on the client... so it doesnt render each
   * time") since both the Dashboard's own preview card and Composer's
   * BaseCvPanel call this on every plain visit. `force: true` (the
   * Composer's own "Refresh" button) always bypasses the cache and
   * re-populates it with the fresh result. */
  async renderBaseCv(personaId: string, templateId: string, opts?: { force?: boolean }): Promise<Blob> {
    if (!opts?.force) {
      const cached = getCachedBaseCvBlob(personaId, templateId);
      if (cached) return cached;
    }
    const res = await fetch(
      `${API_BASE_URL}/personas/${personaId}/base-cv?template_id=${encodeURIComponent(templateId)}`,
      { method: "POST", headers: authHeader() },
    );
    await checkStreamResponse(res, "render");
    const blob = await res.blob();
    setCachedBaseCvBlob(personaId, templateId, blob);
    return blob;
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
    await checkStreamResponse(res, "fetch rendered PDF");
    return res.blob();
  },

  /** Same SSE shape as streamParseCV/streamRadarRun — see
   * job_groups.py's module docstring. */
  async *streamTailorJobGroup(groupId: string, verify = false): AsyncGenerator<TailorProgressEvent> {
    const res = await fetch(`${API_BASE_URL}/job-groups/${groupId}/tailor?verify=${verify}`, {
      method: "POST",
      headers: authHeader(),
    });
    await checkStreamResponse(res, "tailor");

    for await (const { event, data } of parseSSE(res)) {
      const payload = JSON.parse(data);
      if (event === "stage") yield { type: "stage", ...payload };
      else if (event === "done") yield { type: "done", result: payload as TailoredDocument };
      else if (event === "error") yield { type: "error", message: payload.message };
    }
    notifyCreditsChanged();
    notifyOnboardingChanged(); // produces a Document — the "Tailor a CV" step
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
    await checkStreamResponse(res, "cover letter generation");

    for await (const { event, data } of parseSSE(res)) {
      const payload = JSON.parse(data);
      if (event === "stage") yield { type: "stage", ...payload };
      else if (event === "done") yield { type: "done", result: payload as TailoredDocument };
      else if (event === "error") yield { type: "error", message: payload.message };
    }
    notifyCreditsChanged();
    notifyOnboardingChanged(); // also produces a Document
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
    await checkStreamResponse(res, "answer pack generation");

    for await (const { event, data } of parseSSE(res)) {
      const payload = JSON.parse(data);
      if (event === "stage") yield { type: "stage", ...payload };
      else if (event === "done") yield { type: "done", result: payload as TailoredDocument };
      else if (event === "error") yield { type: "error", message: payload.message };
    }
    notifyCreditsChanged();
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
    await checkStreamResponse(res, "verify");

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
  saveDocumentDelta: async (documentId: string, delta: TailoringDelta) => {
    const result = await request<TailoredDocument>(`/documents/${documentId}/delta`, {
      method: "PUT",
      body: JSON.stringify(delta),
    });
    notifyCreditsChanged(); // job_groups.py's save_document_delta_route charges credits too, not just the initial draft
    return result;
  },

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
  /** Blocked server-side (409) while an attempt is actively holding a
   * live browser-worker session or a pending human decision — cancel
   * the run first. */
  deleteApplication: (id: string) => request<void>(`/applications/${id}`, { method: "DELETE" }),
  // Real .xlsx now (Adrian, direct: "I dont want it to be csv") —
  // json stays for API/debug parity only, never surfaced as a UI option.
  exportApplications: (format: "xlsx" | "json" = "xlsx") =>
    fetch(`${API_BASE_URL}/applications/export?format=${format}`, { headers: authHeader() }).then((r) => r.blob()),

  /** Starts a real application-agent run. An `interrupt` event pauses
   * the stream for a human decision — resolve it with streamResumeApplication,
   * which yields the same event shape and may itself pause again. */
  async *streamApply(applicationId: string): AsyncGenerator<ApplicationStreamEvent> {
    const res = await fetch(`${API_BASE_URL}/applications/${applicationId}/apply`, {
      method: "POST",
      headers: authHeader(),
    });
    await checkStreamResponse(res, "apply");
    for await (const { event, data } of parseSSE(res)) {
      const payload = JSON.parse(data);
      if (event === "stage") yield { type: "stage", ...payload };
      else if (event === "interrupt") yield { type: "interrupt", ...payload };
      else if (event === "done") yield { type: "done", ...payload };
      else if (event === "cancelled") yield { type: "cancelled", ...payload };
      else if (event === "error") yield { type: "error", message: payload.message };
    }
    notifyCreditsChanged(); // application_service.py's charge can land on either this stream or the resume one below
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
    await checkStreamResponse(res, "resume");
    for await (const { event, data } of parseSSE(res)) {
      const payload = JSON.parse(data);
      if (event === "stage") yield { type: "stage", ...payload };
      else if (event === "interrupt") yield { type: "interrupt", ...payload };
      else if (event === "done") yield { type: "done", ...payload };
      else if (event === "cancelled") yield { type: "cancelled", ...payload };
      else if (event === "error") yield { type: "error", message: payload.message };
    }
    notifyCreditsChanged();
  },
  /** Stop button — see application_service.request_cancel for what
   * actually happens server-side. Fire-and-forget from the caller's
   * point of view: the in-flight streamApply/streamResumeApplication
   * generator (if one is still being read) is what surfaces the
   * resulting "cancelled" event, not this call's own response. */
  cancelApplicationAttempt: (applicationId: string, attemptId: string) =>
    request<{ status: string }>(`/applications/${applicationId}/attempts/${attemptId}/cancel`, { method: "POST" }),

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
    await checkStreamResponse(res, "document fetch");
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
    await checkStreamResponse(res, "send message");
    // A hand-maintained if/else chain here (as this used to be) is
    // exactly how the "message" event — the human's own side of the
    // turn — went missing live while still replaying fine on reload:
    // it was added to the union type and to getConversationEvents'
    // replay path, but this separate live-streaming switch never got
    // the matching branch, so it silently dropped every "message"
    // event before consume() ever saw it (confirmed live: the backend
    // sends it as the very first SSE frame, well before the agent's
    // own reply). toConversationStreamEvent is the same generic
    // passthrough getConversationEvents already uses — one mapping,
    // not two that can drift apart again for the next new event type.
    for await (const { event, data } of parseSSE(res)) {
      yield toConversationStreamEvent(event, JSON.parse(data));
    }
    // The Assistant can trigger any of the four credit-gated tools
    // itself (orchestrator_service.py's _CREDIT_GATED_TOOLS) — this one
    // hook covers every one of them, rather than needing a matching
    // notify call inside each individual page's own direct-use path AND
    // a second one here.
    notifyCreditsChanged();
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
    await checkStreamResponse(res, "resume");
    // See streamOrchestratorMessage's own comment above — same generic
    // mapper, same reason.
    for await (const { event, data } of parseSSE(res)) {
      yield toConversationStreamEvent(event, JSON.parse(data));
    }
    notifyCreditsChanged(); // an approve decision on a credit-gated tool resolves here, not in the message stream
  },

  /** Stop button — see orchestrator_service.request_cancel for what
   * actually happens server-side. Fire-and-forget: the in-flight
   * streamOrchestratorMessage/Resume generator (if one is still being
   * read) is what surfaces the resulting "cancelled" event. */
  cancelOrchestratorRun: (conversationId: string) =>
    request<Conversation>(`/orchestrator/conversations/${conversationId}/cancel`, { method: "POST" }),

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

  getDashboardSummary: () => request<DashboardSummary>("/dashboard/summary"),
  getOnboardingProgress: () => request<OnboardingProgress>("/dashboard/onboarding"),

  listBillingPlans: () => request<Plan[]>("/billing/plans"),
  /** Public — a real geo-IP + a real live FX rate (currency_service.py),
   * both currency and rate null means "couldn't resolve one, just show
   * the real IDR price." Never cache this client-side across page
   * loads — it's cheap, and a VPN/location change should show up on
   * the next visit, not need a hard refresh to notice. */
  getLocalizedCurrency: () =>
    request<{ currency: string | null; rate: number | null; usd_rate: number | null }>("/billing/currency"),
  getMySubscription: () => request<Subscription>("/billing/subscription"),
  startCheckout: (planId: string, currency?: string | null) =>
    request<{ checkout_url: string }>("/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ plan_id: planId, currency: currency ?? null }),
    }),
  syncSubscription: (dodoSubscriptionId?: string) =>
    request<Subscription>(
      `/billing/sync${dodoSubscriptionId ? `?dodo_subscription_id=${encodeURIComponent(dodoSubscriptionId)}` : ""}`,
      { method: "POST" },
    ),
  /** Upgrade/downgrade an already-paid subscription to a different
   * paid plan — scheduled for the next billing cycle, never
   * immediate (confirmed directly with Adrian). Free -> Paid stays on
   * startCheckout above. */
  changePlan: (planId: string) =>
    request<Subscription>("/billing/change-plan", { method: "POST", body: JSON.stringify({ plan_id: planId }) }),
  undoChangePlan: () => request<Subscription>("/billing/change-plan/undo", { method: "POST" }),
  /** Schedules cancellation at the end of the current billing period
   * — the account reverts to the Free plan once it actually ends,
   * never immediately. */
  cancelSubscription: () => request<Subscription>("/billing/cancel", { method: "POST" }),
  undoCancelSubscription: () => request<Subscription>("/billing/cancel/undo", { method: "POST" }),

  // Phase 16 — standalone credit purchases (fixed packs, never expire)
  // and the user's own credit transaction history.
  listCreditPacks: () => request<CreditPack[]>("/billing/credit-packs"),
  listFeatureCosts: () => request<FeatureCreditCost[]>("/billing/feature-costs"),
  /** {feature_key: true} means this user's NEXT use of that feature is
   * free (credit_ledger.py's own first-use-free rule) — per-user, so
   * unlike listFeatureCosts above this needs auth and can't be cached
   * forever the same way. */
  getFirstUseStatus: () => request<Record<string, boolean>>("/billing/credits/first-use-status"),
  startPackCheckout: (packId: string, currency?: string | null) =>
    request<{ checkout_url: string }>(
      `/billing/credit-packs/${packId}/checkout${currency ? `?currency=${encodeURIComponent(currency)}` : ""}`,
      { method: "POST" },
    ),
  confirmPackPurchase: (dodoPaymentId: string) =>
    request<{ credits: number }>(`/billing/credit-packs/confirm?dodo_payment_id=${encodeURIComponent(dodoPaymentId)}`, {
      method: "POST",
    }),
  listCreditTransactions: (before?: string) =>
    request<CreditTransaction[]>(`/billing/credits/transactions${before ? `?before=${before}` : ""}`),

  // Adrian, direct: "a whole CMS where i can control what shows up in
  // the landing page... changing like images and whatnot shouldnt be
  // through commits" — scoped to media (the demo video link + each
  // screenshot slot). getSiteContent is public (the landing page has
  // no auth); the admin/* calls below require an admin token.
  getSiteContent: () => request<SiteContent>("/site-content"),
  getAdminSiteContent: () => request<SiteContent>("/admin/site-content"),
  updateSiteVideo: (demoVideoUrl: string | null) =>
    request<SiteContent>("/admin/site-content/video", {
      method: "PATCH",
      body: JSON.stringify({ demo_video_url: demoVideoUrl }),
    }),
  /** Plain multipart upload, not through request() (which always
   * forces a JSON Content-Type) — same "raw fetch for a file body"
   * shape streamParseCV already uses. */
  async uploadSiteMedia(slot: string, file: File): Promise<SiteContent> {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_BASE_URL}/admin/site-content/media/${slot}`, {
      method: "POST",
      headers: authHeader(),
      body: formData,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ApiError(`POST /admin/site-content/media/${slot} -> ${res.status}: ${extractErrorMessage(body)}`, res.status);
    }
    return res.json();
  },
  resetSiteMedia: (slot: string) => request<SiteContent>(`/admin/site-content/media/${slot}`, { method: "DELETE" }),

  listPlans: () => request<AdminPlan[]>("/admin/plans"),
  createPlan: (body: {
    name: string;
    price_idr: number;
    monthly_credits: number;
    is_active?: boolean;
    dodo_product_id_test?: string | null;
    dodo_product_id_live?: string | null;
  }) => request<AdminPlan>("/admin/plans", { method: "POST", body: JSON.stringify(body) }),
  updatePlan: (
    id: string,
    body: Partial<
      Pick<
        AdminPlan,
        "name" | "price_idr" | "monthly_credits" | "is_active" | "dodo_product_id_test" | "dodo_product_id_live"
      >
    >,
  ) => request<AdminPlan>(`/admin/plans/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  // Phase 16 admin — feature costs (fixed price per AI feature) and
  // credit packs are both admin-tunable without a redeploy, same
  // mirrored CRUD shape as Plan above.
  listAdminFeatureCosts: () => request<FeatureCreditCost[]>("/admin/feature-costs"),
  updateFeatureCost: (id: string, body: Partial<Pick<FeatureCreditCost, "display_name" | "credit_cost" | "is_active">>) =>
    request<FeatureCreditCost>(`/admin/feature-costs/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  listAdminCreditPacks: () => request<AdminCreditPack[]>("/admin/credit-packs"),
  createCreditPack: (body: {
    name: string;
    price_idr: number;
    credits: number;
    is_active?: boolean;
    dodo_product_id_test?: string | null;
    dodo_product_id_live?: string | null;
  }) => request<AdminCreditPack>("/admin/credit-packs", { method: "POST", body: JSON.stringify(body) }),
  updateCreditPack: (
    id: string,
    body: Partial<Pick<AdminCreditPack, "name" | "price_idr" | "credits" | "is_active" | "dodo_product_id_test" | "dodo_product_id_live">>,
  ) => request<AdminCreditPack>(`/admin/credit-packs/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  // Transaction-based, not a value edit (raised directly by Adrian) —
  // the only effect this has is a new, real CreditTransaction row the
  // user's own history shows as "Granted by admin"/"Deducted by admin".
  adjustUserCredits: (userId: string, amount: number, reason: string) =>
    request<CreditTransaction>(`/admin/users/${userId}/credits/adjust`, {
      method: "POST",
      body: JSON.stringify({ amount, reason }),
    }),

  // --- Phase 11 (v2 plan) — AI interview/FGD/LGD practice ---

  listInterviewSessions: (personaId?: string) =>
    request<InterviewSession[]>(`/interview-sessions${personaId ? `?persona_id=${personaId}` : ""}`),
  getInterviewSession: (id: string) => request<InterviewSession>(`/interview-sessions/${id}`),
  endInterviewSession: async (id: string) => {
    const result = await request<InterviewSession>(`/interview-sessions/${id}/end`, { method: "POST" });
    notifyCreditsChanged(); // the one point interview_service.py's end_interview_session actually charges
    return result;
  },
  deleteInterviewSession: (id: string) => request<void>(`/interview-sessions/${id}`, { method: "DELETE" }),

  /** Same SSE shape (InterviewTurnEvent) is shared by createInterviewSession,
   * startInterviewSession, and submitInterviewTurn below — factored
   * into one generator since all three just POST somewhere and stream
   * the response back. */
  async *_streamInterviewEvents(res: Response): AsyncGenerator<InterviewTurnEvent> {
    await checkStreamResponse(res, "interview turn");
    for await (const { event, data } of parseSSE(res)) {
      // The agent's own end_interview tool can end a session mid-turn
      // (interview_service.py's _end_session_after_turn), not just the
      // explicit "End session" button (endInterviewSession above) — the
      // ONE real charge point either path converges on, so this shared
      // generator is the one place both need the notify hook.
      if (event === "session_ended") notifyCreditsChanged();
      yield toInterviewTurnEvent(event, JSON.parse(data));
    }
  },

  /** Creates the session AND streams its opening turn (the agent's
   * first question) in one call — the session's own id isn't
   * mentioned anywhere in the SSE events themselves (start_interview_session
   * is reused by startInterviewSession below, against an id the
   * caller already has), so it rides along as a response header
   * instead; read before the stream is consumed. */
  async createInterviewSession(body: {
    persona_id: string;
    job_id?: string | null;
    application_id?: string | null;
    role_title?: string | null;
    company_name?: string | null;
    seniority?: string | null;
    practice_type: InterviewPracticeType;
    category?: InterviewCategory | null;
    topic_hint?: string | null;
    language?: string | null;
  }): Promise<{ sessionId: string; events: AsyncGenerator<InterviewTurnEvent> }> {
    const res = await fetch(`${API_BASE_URL}/interview-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(body),
    });
    await checkStreamResponse(res, "create interview session");
    const sessionId = res.headers.get("X-Interview-Session-Id");
    if (!sessionId) throw new Error("create interview session: server did not return a session id");
    notifyOnboardingChanged(); // creates the InterviewSession row — the "Practice an interview" step
    return { sessionId, events: api._streamInterviewEvents(res) };
  },

  /** Starts the opening turn for a session that was created WITHOUT
   * one already running — the Assistant's start_interview_practice
   * tool only creates the row (a plain tool call can't stream SSE),
   * so the practice page calls this once on first open instead. */
  async *startInterviewSession(sessionId: string): AsyncGenerator<InterviewTurnEvent> {
    const res = await fetch(`${API_BASE_URL}/interview-sessions/${sessionId}/start`, {
      method: "POST",
      headers: authHeader(),
    });
    yield* api._streamInterviewEvents(res);
  },

  /** One recorded answer -> the agent's next turn. `blob` is whatever
   * MIME type MediaRecorder actually produced (webm in every browser
   * that matters here) — sent through as-is, interview_media.py's own
   * transcribe() passes it straight to the provider without assuming
   * a specific format. */
  async *submitInterviewTurn(sessionId: string, blob: Blob): AsyncGenerator<InterviewTurnEvent> {
    const formData = new FormData();
    const ext = blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm";
    formData.append("file", blob, `answer.${ext}`);
    const res = await fetch(`${API_BASE_URL}/interview-sessions/${sessionId}/turns`, {
      method: "POST",
      headers: authHeader(),
      body: formData,
    });
    yield* api._streamInterviewEvents(res);
  },

  /** Full replay — an interview session's history is small (a handful
   * of turns), same "just re-render everything" reasoning as
   * getConversationEvents. */
  async getInterviewSessionEvents(
    sessionId: string,
  ): Promise<{ status: string; events: { createdAt: string; type: InterviewTurnEvent["type"]; data: Record<string, unknown> }[] }> {
    const result = await request<{
      status: string;
      events: { created_at: string; event_type: string; data: Record<string, unknown> }[];
    }>(`/interview-sessions/${sessionId}/events`);
    return {
      status: result.status,
      events: result.events.map((e) => ({ createdAt: e.created_at, type: e.event_type as InterviewTurnEvent["type"], data: e.data })),
    };
  },

  /** Fetched as an authenticated blob, not linked to directly as an
   * `<audio src>` — a direct cross-origin `<audio>` load needs
   * `crossOrigin="anonymous"` to ever be usable with the Web Audio
   * API (the pulsating-orb effect), which in turn makes the browser
   * hard-fail the whole load with "no supported source" the moment
   * its own Origin isn't one this API's CORS config happens to
   * recognize (confirmed live: broke exactly this way) — a real
   * fragility a direct link shouldn't depend on. A blob: URL built
   * from a normal authenticated fetch is same-origin from the page's
   * own point of view, so neither problem exists; the caller turns
   * this into a blob: URL via `URL.createObjectURL` and revokes the
   * previous one when a new turn's audio replaces it. */
  async fetchInterviewAudio(sessionId: string, filename: string): Promise<Blob> {
    const res = await fetch(`${API_BASE_URL}/interview-sessions/${sessionId}/audio/${encodeURIComponent(filename)}`, {
      headers: authHeader(),
    });
    await checkStreamResponse(res, "fetch audio");
    return res.blob();
  },
};
