export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

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
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
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
    const res = await fetch(`${API_BASE_URL}/saved-searches/${savedSearchId}/run`, { method: "POST" });
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
  }) => request<SavedSearch>("/saved-searches", { method: "POST", body: JSON.stringify(body) }),
  updateSavedSearch: (
    id: string,
    body: Partial<Pick<SavedSearch, "name" | "active" | "role_titles" | "source_ids" | "filters">>,
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
      { method: "POST" },
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
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`fetch rendered PDF failed: ${res.status}: ${await res.text()}`);
    return res.blob();
  },

  /** Same SSE shape as streamParseCV/streamRadarRun — see
   * job_groups.py's module docstring. */
  async *streamTailorJobGroup(groupId: string): AsyncGenerator<TailorProgressEvent> {
    const res = await fetch(`${API_BASE_URL}/job-groups/${groupId}/tailor`, { method: "POST" });
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
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
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
    const res = await fetch(`${API_BASE_URL}/documents/${documentId}/verify`, { method: "POST" });
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
  saveActiveModelProfile: (body: {
    name: string;
    tier_bindings: Record<string, string>;
    stage_overrides?: Record<string, string>;
  }) =>
    request<ModelProfile>("/model-profiles/active", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
};
