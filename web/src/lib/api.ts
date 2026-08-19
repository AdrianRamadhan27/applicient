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
  status: string;
  latency_ms: number | null;
  created_at: string;
};

export type CostSummary = {
  total_cost_usd: number;
  total_calls: number;
  unknown_cost_calls: number;
  by_stage: Record<string, number>;
  recent_calls: LlmCall[];
};

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

  async parseCV(profileId: string, file: File): Promise<CVParseResult> {
    const formData = new FormData();
    formData.append("file", file);
    // No Content-Type header here — the browser sets the multipart
    // boundary itself. request()'s default JSON header would break
    // this upload if used, so this bypasses it entirely.
    const res = await fetch(`${API_BASE_URL}/profiles/${profileId}/cv/parse`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      throw new Error(`CV parse failed: ${res.status}: ${await res.text()}`);
    }
    return res.json();
  },

  getCostSummary: () => request<CostSummary>("/cost/summary"),

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
