import type { Source } from "@/lib/api";

// User-facing platform picker — deliberately hides the underlying
// adapter/library (jobspy powers LinkedIn+Indeed under the hood, one
// Source row per platform with `config.sites` fixed to just that
// platform) and drops JSearch/SocialFetch entirely: both need a paid
// API key up front before anything works, which was the actual
// complaint ("too complex, user shouldn't need to know what api key
// is needed"). JobStreet/Glints are listed disabled ("coming soon")
// since they were asked for by name even though nothing backs them
// yet — everything else here maps to a real, working adapter.
//
// Originally local to radar/page.tsx's "New saved search" source
// picker — extracted here so the Job Inbox card list can render the
// exact same logo/color per job (raised directly by Adrian), instead
// of a second copy of this table drifting out of sync with it.
export type PlatformKey =
  | "greenhouse"
  | "lever"
  | "workable"
  | "ashby"
  | "smartrecruiters"
  | "recruitee"
  | "linkedin"
  | "indeed"
  | "remoteok"
  | "jobstreet"
  | "glints";

export type PlatformConfigKind = "company_identifiers" | "jobspy_linkedin" | "jobspy_indeed" | "none" | "coming_soon";

export type PlatformDef = {
  key: PlatformKey;
  label: string;
  mark: string;
  color: string;
  adapterKey: string | null;
  configKind: PlatformConfigKind;
};

export const PLATFORMS: PlatformDef[] = [
  { key: "greenhouse", label: "Greenhouse", mark: "Gh", color: "#24A47F", adapterKey: "greenhouse", configKind: "company_identifiers" },
  { key: "lever", label: "Lever", mark: "Lv", color: "#5B57D1", adapterKey: "lever", configKind: "company_identifiers" },
  { key: "workable", label: "Workable", mark: "Wk", color: "#2FAE6A", adapterKey: "workable", configKind: "company_identifiers" },
  { key: "ashby", label: "Ashby", mark: "As", color: "#1F2933", adapterKey: "ashby", configKind: "company_identifiers" },
  { key: "smartrecruiters", label: "SmartRecruiters", mark: "Sr", color: "#1F6FEB", adapterKey: "smartrecruiters", configKind: "company_identifiers" },
  { key: "recruitee", label: "Recruitee", mark: "Rc", color: "#FF5C5C", adapterKey: "recruitee", configKind: "company_identifiers" },
  { key: "linkedin", label: "LinkedIn", mark: "in", color: "#0A66C2", adapterKey: "jobspy", configKind: "jobspy_linkedin" },
  { key: "indeed", label: "Indeed", mark: "id", color: "#2557A7", adapterKey: "jobspy", configKind: "jobspy_indeed" },
  { key: "remoteok", label: "RemoteOK", mark: "OK", color: "#111111", adapterKey: "remoteok", configKind: "none" },
  { key: "jobstreet", label: "JobStreet", mark: "JS", color: "#009E9E", adapterKey: null, configKind: "coming_soon" },
  { key: "glints", label: "Glints", mark: "Gl", color: "#4B3FE4", adapterKey: null, configKind: "coming_soon" },
];

export const PLATFORM_BY_KEY = Object.fromEntries(PLATFORMS.map((p) => [p.key, p])) as Record<PlatformKey, PlatformDef>;

const PLATFORM_BY_LABEL = new Map(PLATFORMS.map((p) => [p.label.toLowerCase(), p]));

// Best-effort inverse of the above, for rendering existing Source rows
// (including ones created before this picker existed) with a logo —
// falls back to the raw adapter_key label when a row can't be mapped
// to exactly one platform (a legacy multi-site jobspy row, or a
// jsearch/socialfetch row from before those were dropped).
export function platformForSource(s: Source): PlatformDef | undefined {
  if (s.adapter_key === "jobspy") {
    const sites = String(s.config?.sites ?? "");
    if (sites === "linkedin") return PLATFORM_BY_KEY.linkedin;
    if (sites === "indeed") return PLATFORM_BY_KEY.indeed;
    return undefined;
  }
  return PLATFORMS.find((p) => p.adapterKey === s.adapter_key);
}

// The Job Inbox card list only ever gets a plain source NAME per job
// (`InboxJob.source_names`), not a full Source row — every source
// created through the picker above has its `name` set to exactly
// `platform.label` (radar/page.tsx's own createSource call), so a
// case-insensitive label match is the right (and only available)
// lookup here. Falls back to undefined — same "show the plain name
// instead of guessing" discipline as platformForSource above — for a
// source someone renamed, or one that predates this picker.
export function platformForSourceName(name: string): PlatformDef | undefined {
  return PLATFORM_BY_LABEL.get(name.trim().toLowerCase());
}
