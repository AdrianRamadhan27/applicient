"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  api,
  type AgentRunSummary,
  type CompanyCandidate,
  type JobSummary,
  type RadarRunProgressEvent,
  type SavedSearch,
  type Source,
  type SourceAdapterKey,
  type SourceRun,
  toRadarProgressEvent,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { usePersona } from "@/components/persona-provider";
import { ChevronDown, ChevronUp, Loader2, Radar as RadarIcon } from "lucide-react";

// User-facing platform picker — deliberately hides the underlying
// adapter/library (jobspy powers LinkedIn+Indeed under the hood, one
// Source row per platform with `config.sites` fixed to just that
// platform) and drops JSearch/SocialFetch entirely: both need a paid
// API key up front before anything works, which was the actual
// complaint ("too complex, user shouldn't need to know what api key
// is needed"). JobStreet/Glints are listed disabled ("coming soon")
// since they were asked for by name even though nothing backs them
// yet — everything else here maps to a real, working adapter.
type PlatformKey =
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

type PlatformConfigKind = "company_identifiers" | "jobspy_linkedin" | "jobspy_indeed" | "none" | "coming_soon";

type PlatformDef = {
  key: PlatformKey;
  label: string;
  mark: string;
  color: string;
  adapterKey: SourceAdapterKey | null;
  configKind: PlatformConfigKind;
};

const PLATFORMS: PlatformDef[] = [
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

const PLATFORM_BY_KEY = Object.fromEntries(PLATFORMS.map((p) => [p.key, p])) as Record<PlatformKey, PlatformDef>;

// Best-effort inverse of the above, for rendering existing Source rows
// (including ones created before this picker existed) with a logo —
// falls back to the raw adapter_key label when a row can't be mapped
// to exactly one platform (a legacy multi-site jobspy row, or a
// jsearch/socialfetch row from before those were dropped).
function platformForSource(s: Source): PlatformDef | undefined {
  if (s.adapter_key === "jobspy") {
    const sites = String(s.config?.sites ?? "");
    if (sites === "linkedin") return PLATFORM_BY_KEY.linkedin;
    if (sites === "indeed") return PLATFORM_BY_KEY.indeed;
    return undefined;
  }
  return PLATFORMS.find((p) => p.adapterKey === s.adapter_key);
}

const COMPANY_IDENTIFIER_HINT: Partial<Record<PlatformKey, string>> = {
  greenhouse: "the board token, e.g. job-boards.greenhouse.io/gitlab",
  lever: "the board token, e.g. jobs.lever.co/palantir",
  workable: "the account slug, e.g. apply.workable.com/huggingface",
  ashby: "the board name, e.g. jobs.ashbyhq.com/ramp",
  smartrecruiters: "the company identifier, e.g. jobs.smartrecruiters.com/Equinox",
  recruitee: "the subdomain, e.g. channable.recruitee.com",
};

function PlatformLogo({ mark, color, size = 26 }: { mark: string; color: string; size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center shrink-0 font-mono font-bold text-white leading-none"
      style={{ backgroundColor: color, width: size, height: size, fontSize: size * 0.42 }}
    >
      {mark}
    </span>
  );
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_ABBR = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const HOURLY_INTERVAL_OPTIONS = [1, 2, 3, 4, 6, 8, 12];

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function timeOfDay(h: string | number, m: string | number): string | null {
  const hNum = Number(h);
  const mNum = Number(m);
  if (!Number.isInteger(hNum) || !Number.isInteger(mNum) || hNum < 0 || hNum > 23 || mNum < 0 || mNum > 59) {
    return null;
  }
  const period = hNum < 12 ? "AM" : "PM";
  const h12 = hNum % 12 === 0 ? 12 : hNum % 12;
  return `${h12}:${String(mNum).padStart(2, "0")} ${period}`;
}

/** Crontab syntax is exact but not something most people can read at a
 * glance — covers everything the schedule builder below can produce
 * (hourly/daily/weekly/monthly) plus reasonable hand-typed variations,
 * falling back to the raw expression only for genuinely custom
 * schedules (multiple constraints combined, step values elsewhere,
 * etc.) rather than risk describing one wrong. */
function formatCronSchedule(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (month !== "*") return cron;

  if (dayOfMonth !== "*" && dayOfWeek === "*") {
    const domNum = Number(dayOfMonth);
    const time = timeOfDay(hour, minute);
    if (Number.isInteger(domNum) && domNum >= 1 && domNum <= 31 && time) {
      return `Monthly on the ${ordinal(domNum)} at ${time}`;
    }
    return cron;
  }
  if (dayOfMonth !== "*") return cron;

  if (dayOfWeek === "*") {
    const minuteEvery = minute.match(/^\*\/(\d+)$/);
    if (minuteEvery && hour === "*") return `Every ${minuteEvery[1]} minute${minuteEvery[1] === "1" ? "" : "s"}`;
    if (minute === "0") {
      if (hour === "*") return "Every hour";
      const hourEvery = hour.match(/^\*\/(\d+)$/);
      if (hourEvery) return `Every ${hourEvery[1]} hour${hourEvery[1] === "1" ? "" : "s"}`;
    }
    const time = timeOfDay(hour, minute);
    return time ? `Daily at ${time}` : cron;
  }

  const time = timeOfDay(hour, minute);
  if (!time) return cron;
  if (dayOfWeek === "1-5") return `Weekdays at ${time}`;
  if (dayOfWeek === "0,6" || dayOfWeek === "6,0") return `Weekends at ${time}`;

  const days = dayOfWeek.split(",").map((d) => Number(d));
  if (days.length > 0 && days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    const names = days.map((d) => WEEKDAY_NAMES[d]);
    return names.length === 1 ? `Every ${names[0]} at ${time}` : `${names.join(", ")} at ${time}`;
  }

  return cron;
}

// v2 Phase 2 — a real schedule builder (frequency + day-of-week/day-of-
// month + time-of-day) instead of hand-typed crontab syntax, with a
// "Custom" mode left as an escape hatch for anything it can't express.
// `draftScheduleCron` still holds the custom-mode raw text; every other
// mode derives the real cron via buildCronFromSchedule below.
type ScheduleMode = "none" | "hourly" | "daily" | "weekly" | "monthly" | "custom";

const SCHEDULE_MODE_LABELS: Record<ScheduleMode, string> = {
  none: "Manual only",
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  custom: "Custom",
};

type ScheduleBuilderState = {
  mode: ScheduleMode;
  hour: number;
  minute: number;
  weekdays: Set<number>;
  dayOfMonth: number;
  intervalHours: number;
};

function defaultScheduleBuilder(): ScheduleBuilderState {
  return { mode: "none", hour: 8, minute: 0, weekdays: new Set([1, 2, 3, 4, 5]), dayOfMonth: 1, intervalHours: 6 };
}

/** Inverse of buildCronFromSchedule, used when opening a saved search
 * for edit — best-effort: anything that doesn't cleanly round-trip
 * through one of the four structured modes lands in "custom" showing
 * the raw expression rather than mangling it. */
function parseCronToBuilder(cron: string | null): ScheduleBuilderState {
  const base = defaultScheduleBuilder();
  if (!cron) return base;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { ...base, mode: "custom" };
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (month !== "*") return { ...base, mode: "custom" };

  const hourEvery = hour.match(/^\*\/(\d+)$/);
  if (dayOfMonth === "*" && dayOfWeek === "*" && minute === "0" && hourEvery) {
    return { ...base, mode: "hourly", intervalHours: Number(hourEvery[1]) };
  }

  const hNum = Number(hour);
  const mNum = Number(minute);
  const validTime = Number.isInteger(hNum) && Number.isInteger(mNum) && hNum >= 0 && hNum <= 23 && mNum >= 0 && mNum <= 59;
  if (!validTime) return { ...base, mode: "custom" };

  if (dayOfMonth === "*" && dayOfWeek === "*") {
    return { ...base, mode: "daily", hour: hNum, minute: mNum };
  }
  if (dayOfMonth === "*" && dayOfWeek !== "*") {
    if (dayOfWeek === "1-5") return { ...base, mode: "weekly", hour: hNum, minute: mNum, weekdays: new Set([1, 2, 3, 4, 5]) };
    if (dayOfWeek === "0,6" || dayOfWeek === "6,0") return { ...base, mode: "weekly", hour: hNum, minute: mNum, weekdays: new Set([0, 6]) };
    const days = dayOfWeek.split(",").map(Number);
    if (days.length > 0 && days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      return { ...base, mode: "weekly", hour: hNum, minute: mNum, weekdays: new Set(days) };
    }
    return { ...base, mode: "custom" };
  }
  const domNum = Number(dayOfMonth);
  if (dayOfWeek === "*" && Number.isInteger(domNum) && domNum >= 1 && domNum <= 31) {
    return { ...base, mode: "monthly", hour: hNum, minute: mNum, dayOfMonth: Math.min(domNum, 28) };
  }
  return { ...base, mode: "custom" };
}

function buildCronFromSchedule(b: ScheduleBuilderState, customCron: string): string | null {
  switch (b.mode) {
    case "none":
      return null;
    case "custom":
      return customCron.trim() || null;
    case "hourly":
      return `0 */${b.intervalHours} * * *`;
    case "daily":
      return `${b.minute} ${b.hour} * * *`;
    case "weekly": {
      if (b.weekdays.size === 0) return null;
      const days = Array.from(b.weekdays).sort((a, c) => a - c).join(",");
      return `${b.minute} ${b.hour} * * ${days}`;
    }
    case "monthly":
      return `${b.minute} ${b.hour} ${b.dayOfMonth} * *`;
  }
}

function money(v: number) {
  if (v === 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(2)}`;
}

type RunState = {
  savedSearchId: string;
  // Captured from the "run_started" event so a Cancel button can call
  // POST /agent-runs/{id}/cancel without threading the id through
  // separately — null only for the brief instant before that event
  // arrives.
  agentRunId: string | null;
  cancelled: boolean;
  sourceProgress: Record<
    string,
    {
      name: string;
      status: "running" | "completed" | "failed";
      seen?: number;
      new?: number;
      deduped?: number;
      companyBreakdown?: Record<string, { seen: number; new: number; deduped: number }>;
      message?: string;
    }
  >;
  fallbacks: string[];
  sourceErrors: string[];
  logs: string[];
  embedding: { status: "running" | "done"; count: number; embedded?: number; errors?: string[] } | null;
  scoring: {
    status: "running" | "done";
    count: number;
    scored: {
      jobId: string;
      title: string;
      decision: "keep" | "drop" | "review";
      recommendation: string | null;
      overallScore: number | null;
    }[];
    scoringErrors: { jobId: string; title: string; message: string }[];
    summary: { kept: number; dropped: number; review: number; errors: number } | null;
  } | null;
  result: { cost_usd: number; source_runs: SourceRun[] } | null;
  error: string | null;
};

export default function RadarPage() {
  // Persona list/selection is app-wide now (AppShell's sidebar
  // switcher) — this page only fetches what's actually its own
  // (sources, saved searches).
  const { personas, selectedPersonaId } = usePersona();
  const [sources, setSources] = React.useState<Source[]>([]);
  const [savedSearches, setSavedSearches] = React.useState<SavedSearch[]>([]);
  const [loading, setLoading] = React.useState(true);

  // M2 §5 — F2.10 discovery review/approval. Its own dialog, always
  // scoped to the globally-selected persona — discovery acts *for*
  // that persona, so there's no separate local override here.
  const [discoveryOpen, setDiscoveryOpen] = React.useState(false);
  const [candidates, setCandidates] = React.useState<CompanyCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = React.useState(false);
  const [discovering, setDiscovering] = React.useState(false);
  const [updatingCandidateId, setUpdatingCandidateId] = React.useState<string | null>(null);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editingSearchId, setEditingSearchId] = React.useState<string | null>(null);
  const [draftName, setDraftName] = React.useState("");
  const [draftRoleTitles, setDraftRoleTitles] = React.useState("");
  const [draftPersonaId, setDraftPersonaId] = React.useState<string>("");
  // Platform picker replaces manual Source setup — picking a platform
  // here either reuses this user's existing Source row for it (config
  // prefilled, editable) or provisions one on submit. Rows that don't
  // map to exactly one of the 11 picker platforms (a legacy multi-site
  // jobspy row, or a pre-existing jsearch/socialfetch row) are kept as
  // opaque ids in draftUnmappedSourceIds so editing a search never
  // silently drops them.
  const [draftSelectedPlatforms, setDraftSelectedPlatforms] = React.useState<Set<PlatformKey>>(new Set());
  const [draftPlatformConfig, setDraftPlatformConfig] = React.useState<
    Partial<Record<PlatformKey, { companyIdentifiers?: string; country?: string }>>
  >({});
  const [draftUnmappedSourceIds, setDraftUnmappedSourceIds] = React.useState<Set<string>>(new Set());
  const [draftLocation, setDraftLocation] = React.useState("");
  const [draftScheduleCron, setDraftScheduleCron] = React.useState("");
  const [scheduleBuilder, setScheduleBuilder] = React.useState<ScheduleBuilderState>(defaultScheduleBuilder());
  const [draftActive, setDraftActive] = React.useState(true);
  const [creatingSearch, setCreatingSearch] = React.useState(false);

  // Keyed by saved-search id, not a single slot — every saved search
  // that has a run gets its own live/replayed state, so revisiting the
  // page shows the same rich per-source/scoring panel for EVERY saved
  // search with a run, not just whichever one happened to be "the"
  // current run when you left. Raised directly by Adrian: after
  // leaving mid-run and coming back, the live per-job score panel had
  // been replaced entirely by the bare "last run" summary + View jobs
  // button, because the old single `run` slot only ever got
  // reconnected for a run that was STILL "running" on load — a
  // completed run had nothing to reconnect to under that design, even
  // though its full event history (RunEvent) was sitting right there.
  const [runs, setRuns] = React.useState<Record<string, RunState>>({});
  const [lastRuns, setLastRuns] = React.useState<Record<string, AgentRunSummary | null>>({});
  const [expandedJobsFor, setExpandedJobsFor] = React.useState<string | null>(null);
  const [jobsCache, setJobsCache] = React.useState<Record<string, JobSummary[]>>({});
  const [loadingJobs, setLoadingJobs] = React.useState(false);
  // The live/replayed per-source detail (scored-job list, raw log
  // lines) is verbose and, per Adrian, should default to collapsed —
  // separate from expandedJobsFor, which is the older stand-in job
  // list fetch (still used for the legacy "no replayable events at
  // all" fallback row, see the `!rowRun` branch below).
  const [expandedDetailFor, setExpandedDetailFor] = React.useState<Set<string>>(new Set());

  function toggleDetail(savedSearchId: string) {
    setExpandedDetailFor((prev) => {
      const next = new Set(prev);
      if (next.has(savedSearchId)) next.delete(savedSearchId);
      else next.add(savedSearchId);
      return next;
    });
  }
  // One cancellation token per saved search (not a single shared one)
  // — a fresh handleRun/watchRun for a given saved search cancels only
  // that search's previous poller, never another search's.
  const watchTokensRef = React.useRef<Record<string, { cancelled: boolean }>>({});

  function cancelWatch(savedSearchId: string) {
    const token = watchTokensRef.current[savedSearchId];
    if (token) token.cancelled = true;
  }

  function initialRunState(savedSearchId: string): RunState {
    return {
      savedSearchId,
      agentRunId: null,
      cancelled: false,
      sourceProgress: {},
      fallbacks: [],
      sourceErrors: [],
      logs: [],
      embedding: null,
      scoring: null,
      result: null,
      error: null,
    };
  }

  const loadAll = React.useCallback(async () => {
    const [s, ss] = await Promise.all([api.listSources(), api.listSavedSearches()]);
    setSources(s);
    setSavedSearches(ss);

    // Last-run state was previously only ever held in this page's own
    // React state, live from SSE — navigate away and back and it was
    // gone even though AgentRun/SourceRun were sitting in Postgres the
    // whole time. Re-hydrated here so a completed run stays visible.
    const runEntries = await Promise.all(
      ss.map(async (search) => {
        const runs = await api.listSavedSearchRuns(search.id, 1);
        return [search.id, runs[0] ?? null] as const;
      }),
    );
    setLastRuns(Object.fromEntries(runEntries));

    // Every saved search with a run gets replayed, not just one that's
    // still "running" — a completed run's full event history is just
    // as replayable (RunEvent is permanent), and showing the same rich
    // panel regardless of whether the run finished before or after you
    // loaded the page is the whole point. A run from before this
    // feature existed replays zero events and `watchRun` leaves it
    // alone, falling back to the plain `lastRuns` summary line below.
    for (const [savedSearchId, runSummary] of runEntries) {
      if (!runSummary) continue;
      const search = ss.find((s) => s.id === savedSearchId);
      if (search) watchRun(search, runSummary.id);
    }
    // watchRun only closes over stable setters (setRuns/setLastRuns)
    // and the params passed to it, never stale state directly, so
    // it's safe to omit here; including it would need watchRun itself
    // memoized, which would need applyRunEvent memoized too, for no
    // real benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Reconnect/replay path for a run this page instance didn't start
   * live — a still-running run left by an earlier visit, or simply
   * any saved search's last run being shown again after a reload.
   * Replays every RunEvent the run has produced so far (durable, see
   * saved_searches.py's `list_run_events`) through the exact same
   * `applyRunEvent` handler the live SSE path uses, then — only while
   * the run is still actually "running" — keeps polling for new ones
   * every 2s. There's no live-push channel in this codebase, so
   * polling a cheap indexed query is what "reconnect and keep
   * watching" means here. Events from the very first (catch-up) batch
   * are applied silently (no "run complete" toast for a run that
   * finished minutes or days ago); only events observed in a later
   * poll — genuinely new since this page started watching — toast
   * normally, same as a live run always has. */
  async function watchRun(savedSearch: SavedSearch, agentRunId: string) {
    cancelWatch(savedSearch.id);
    const token = { cancelled: false };
    watchTokensRef.current[savedSearch.id] = token;

    let sinceSeq = 0;
    let isFirstBatch = true;
    let hydrated = false;
    try {
      while (!token.cancelled) {
        const { run_status, events } = await api.listRunEvents(savedSearch.id, agentRunId, sinceSeq);
        if (events.length > 0 && !hydrated) {
          hydrated = true;
          setRuns((prev) => ({ ...prev, [savedSearch.id]: initialRunState(savedSearch.id) }));
        }
        for (const e of events) {
          if (token.cancelled) break;
          applyRunEvent(savedSearch, toRadarProgressEvent(e.event_type, e.data), { silent: isFirstBatch });
          sinceSeq = e.seq;
        }
        isFirstBatch = false;
        if (token.cancelled) break;
        if (run_status !== "running") {
          // Safety net for a real bug found live: a run can end up
          // status="cancelled" server-side with no matching
          // "run_cancelled" event ever written (a gap in the
          // cancel-without-a-live-generator path, now fixed at the
          // source too — see streaming.py). Without this, polling
          // just stops here forever with `cancelled` never having
          // flipped, leaving the row stuck showing "Running…"
          // indefinitely. Reconciles directly against run_status
          // instead of only ever trusting the event stream.
          setRuns((prev) => {
            const existing = prev[savedSearch.id];
            if (!existing || existing.result !== null || existing.error !== null || existing.cancelled) return prev;
            if (run_status === "cancelled") return { ...prev, [savedSearch.id]: { ...existing, cancelled: true } };
            if (run_status === "failed") {
              return { ...prev, [savedSearch.id]: { ...existing, error: "Run failed (no further detail recorded)" } };
            }
            return prev;
          });
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (e) {
      if (!token.cancelled && hydrated) {
        setRuns((prev) => (prev[savedSearch.id] ? { ...prev, [savedSearch.id]: { ...prev[savedSearch.id], error: String(e) } } : prev));
      }
    }
    if (!token.cancelled && hydrated) {
      try {
        const runs = await api.listSavedSearchRuns(savedSearch.id, 1);
        setLastRuns((prev) => ({ ...prev, [savedSearch.id]: runs[0] ?? null }));
      } catch {
        // best-effort, same reasoning as handleRun's own refresh
      }
    }
  }

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadAll();
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAll]);

  function openDiscovery() {
    setDiscoveryOpen(true);
  }

  const loadCandidates = React.useCallback(async (personaId: string) => {
    if (!personaId) return;
    setLoadingCandidates(true);
    try {
      const list = await api.listCompanyCandidates(personaId);
      setCandidates(list);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoadingCandidates(false);
    }
  }, []);

  React.useEffect(() => {
    if (discoveryOpen && selectedPersonaId) loadCandidates(selectedPersonaId);
  }, [discoveryOpen, selectedPersonaId, loadCandidates]);

  async function handleRunDiscovery() {
    if (!selectedPersonaId) return;
    setDiscovering(true);
    try {
      const created = await api.discoverCompanyCandidates(selectedPersonaId);
      toast.success(`${created.length} new candidate${created.length === 1 ? "" : "s"} found`);
      await loadCandidates(selectedPersonaId);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDiscovering(false);
    }
  }

  async function handleUpdateCandidate(id: string, approved: boolean) {
    setUpdatingCandidateId(id);
    try {
      const updated = await api.updateCompanyCandidate(id, { approved });
      setCandidates((prev) => prev.map((c) => (c.id === id ? updated : c)));
      if (approved) toast.success("Added to the scan list");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setUpdatingCandidateId(null);
    }
  }

  // Picking a platform prefills its config from an existing Source of
  // that platform, if this user already has one (reused, not
  // duplicated, on submit) — otherwise the fields start blank and a
  // new Source gets provisioned on submit.
  function toggleDraftPlatform(key: PlatformKey) {
    const platform = PLATFORM_BY_KEY[key];
    if (platform.configKind === "coming_soon") return;
    const next = new Set(draftSelectedPlatforms);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
      const existing = sources.find((s) => platformForSource(s)?.key === key);
      if (existing) {
        setDraftPlatformConfig((cfg) => ({
          ...cfg,
          [key]:
            platform.configKind === "company_identifiers"
              ? { companyIdentifiers: ((existing.config.company_identifiers as string[] | undefined) ?? []).join(", ") }
              : platform.configKind === "jobspy_indeed"
                ? { country: String(existing.config.country ?? "") }
                : {},
        }));
      }
    }
    setDraftSelectedPlatforms(next);
  }

  function setDraftPlatformField(key: PlatformKey, field: "companyIdentifiers" | "country", value: string) {
    setDraftPlatformConfig((cfg) => ({ ...cfg, [key]: { ...cfg[key], [field]: value } }));
  }

  // Turns the picker's selected platforms into real Source ids —
  // reusing this user's existing Source per platform (PATCHing it if
  // the config text changed) or creating one, all in parallel since
  // each platform resolves independently. Returns null (having
  // already toasted) if a selected platform is missing required
  // config. Replaces the old standalone "Setup" step entirely: a
  // platform only needs an API key for jsearch/socialfetch, both
  // dropped from the picker, so there's nothing left to "set up" and
  // test ahead of time.
  async function resolveSourceIds(): Promise<string[] | null> {
    const keys = Array.from(draftSelectedPlatforms);
    for (const key of keys) {
      const platform = PLATFORM_BY_KEY[key];
      const cfg = draftPlatformConfig[key];
      if (platform.configKind === "company_identifiers") {
        const ids = (cfg?.companyIdentifiers ?? "").split(",").map((v) => v.trim()).filter(Boolean);
        if (ids.length === 0) {
          toast.error(`At least one company identifier is required for ${platform.label}`);
          return null;
        }
      }
      if (platform.configKind === "jobspy_indeed" && !cfg?.country?.trim()) {
        toast.error("Country is required for Indeed — it's country-scoped.");
        return null;
      }
    }

    const resolved = await Promise.all(
      keys.map(async (key) => {
        const platform = PLATFORM_BY_KEY[key];
        const cfg = draftPlatformConfig[key];
        const existing = sources.find((s) => platformForSource(s)?.key === key);

        let config: Record<string, string | string[]>;
        if (platform.configKind === "company_identifiers") {
          config = {
            company_identifiers: (cfg?.companyIdentifiers ?? "")
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean),
          };
        } else if (platform.configKind === "jobspy_indeed") {
          config = { sites: "indeed", country: cfg!.country!.trim() };
        } else if (platform.configKind === "jobspy_linkedin") {
          config = { sites: "linkedin" };
        } else {
          config = {};
        }

        if (existing) {
          if (JSON.stringify(existing.config) === JSON.stringify(config)) return existing;
          return api.updateSource(existing.id, { config });
        }
        return api.createSource({ name: platform.label, tier: "tier1_api", adapter_key: platform.adapterKey!, config });
      }),
    );

    setSources((prev) => {
      const byId = new Map(prev.map((s) => [s.id, s]));
      for (const s of resolved) byId.set(s.id, s);
      return Array.from(byId.values());
    });

    return [...resolved.map((s) => s.id), ...Array.from(draftUnmappedSourceIds)];
  }

  function openCreateSearch() {
    setEditingSearchId(null);
    setDraftName("");
    setDraftRoleTitles("");
    setDraftPersonaId(selectedPersonaId);
    setDraftSelectedPlatforms(new Set());
    setDraftPlatformConfig({});
    setDraftUnmappedSourceIds(new Set());
    setDraftLocation("");
    setDraftScheduleCron("");
    setScheduleBuilder(defaultScheduleBuilder());
    setDraftActive(true);
    setCreateOpen(true);
  }

  function openEditSearch(s: SavedSearch) {
    setEditingSearchId(s.id);
    setDraftName(s.name);
    setDraftRoleTitles(s.role_titles.join(", "));
    setDraftPersonaId(s.persona_id);

    const platforms = new Set<PlatformKey>();
    const config: Partial<Record<PlatformKey, { companyIdentifiers?: string; country?: string }>> = {};
    const unmapped = new Set<string>();
    for (const id of s.source_ids) {
      const source = sources.find((src) => src.id === id);
      const platform = source ? platformForSource(source) : undefined;
      if (!source || !platform) {
        unmapped.add(id);
        continue;
      }
      platforms.add(platform.key);
      if (platform.configKind === "company_identifiers") {
        config[platform.key] = {
          companyIdentifiers: ((source.config.company_identifiers as string[] | undefined) ?? []).join(", "),
        };
      } else if (platform.configKind === "jobspy_indeed") {
        config[platform.key] = { country: String(source.config.country ?? "") };
      }
    }
    setDraftSelectedPlatforms(platforms);
    setDraftPlatformConfig(config);
    setDraftUnmappedSourceIds(unmapped);

    setDraftLocation(s.filters.location ?? "");
    setDraftScheduleCron(s.schedule_cron ?? "");
    setScheduleBuilder(parseCronToBuilder(s.schedule_cron));
    setDraftActive(s.active);
    setCreateOpen(true);
  }

  async function handleToggleActive(id: string, active: boolean) {
    // Quick toggle straight from the list — doesn't need the full edit
    // dialog open, PATCH already accepts `active` on its own
    // (routers/saved_searches.py re-syncs APScheduler on this exact call).
    try {
      const updated = await api.updateSavedSearch(id, { active });
      setSavedSearches((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function handleCreateSearch() {
    const roleTitles = draftRoleTitles
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (
      !draftName.trim() ||
      !draftPersonaId ||
      roleTitles.length === 0 ||
      (draftSelectedPlatforms.size === 0 && draftUnmappedSourceIds.size === 0)
    ) {
      toast.error("Name, persona, at least one role title, and at least one source are all required");
      return;
    }
    setCreatingSearch(true);
    try {
      const sourceIds = await resolveSourceIds();
      if (sourceIds === null) return;
      const filters = draftLocation.trim() ? { location: draftLocation.trim() } : {};
      const scheduleCron = buildCronFromSchedule(scheduleBuilder, draftScheduleCron);
      if (editingSearchId) {
        const updated = await api.updateSavedSearch(editingSearchId, {
          name: draftName.trim(),
          role_titles: roleTitles,
          source_ids: sourceIds,
          filters,
          schedule_cron: scheduleCron,
          active: draftActive,
        });
        setSavedSearches((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        toast.success("Saved search updated");
      } else {
        const saved = await api.createSavedSearch({
          name: draftName.trim(),
          persona_id: draftPersonaId,
          role_titles: roleTitles,
          source_ids: sourceIds,
          filters,
          schedule_cron: scheduleCron,
        });
        setSavedSearches((prev) => [...prev, saved]);
        toast.success("Saved search created");
      }
      setCreateOpen(false);
      setEditingSearchId(null);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCreatingSearch(false);
    }
  }

  async function handleDeleteSearch(id: string) {
    try {
      await api.deleteSavedSearch(id);
      setSavedSearches((prev) => prev.filter((s) => s.id !== id));
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function handleCancelRun(agentRunId: string) {
    try {
      await api.cancelAgentRun(agentRunId);
      // Cooperative, not instant — the run notices at its next
      // checkpoint (between sources, or between individually
      // completing scored jobs), so this doesn't flip the UI to
      // "cancelled" itself. The real transition arrives through the
      // same "run_cancelled" SSE/replay event every other progress
      // update already goes through.
      toast.success("Cancelling — this takes effect at the run's next checkpoint, not instantly");
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function handleRun(savedSearch: SavedSearch) {
    cancelWatch(savedSearch.id);
    setRuns((prev) => ({ ...prev, [savedSearch.id]: initialRunState(savedSearch.id) }));
    try {
      for await (const event of api.streamRadarRun(savedSearch.id)) {
        applyRunEvent(savedSearch, event);
      }
    } catch (e) {
      setRuns((prev) => (prev[savedSearch.id] ? { ...prev, [savedSearch.id]: { ...prev[savedSearch.id], error: String(e) } } : prev));
      toast.error(String(e));
    }
    // Refreshes the persisted view even though the live `runs` state
    // above already reflects the outcome — this is what keeps the
    // page correct after a later navigate-away-and-back, not just
    // during the current live session.
    try {
      const runsList = await api.listSavedSearchRuns(savedSearch.id, 1);
      setLastRuns((prev) => ({ ...prev, [savedSearch.id]: runsList[0] ?? null }));
    } catch {
      // best-effort refresh — the live `runs` state above already
      // showed the outcome, so a failed re-fetch here isn't worth
      // surfacing as its own error to the user.
    }
    setJobsCache((prev) => {
      const next = { ...prev };
      delete next[savedSearch.id];
      return next;
    });
  }

  async function handleToggleJobs(savedSearchId: string) {
    if (expandedJobsFor === savedSearchId) {
      setExpandedJobsFor(null);
      return;
    }
    setExpandedJobsFor(savedSearchId);
    if (!jobsCache[savedSearchId]) {
      setLoadingJobs(true);
      try {
        const jobs = await api.listSavedSearchJobs(savedSearchId);
        setJobsCache((prev) => ({ ...prev, [savedSearchId]: jobs }));
      } catch (e) {
        toast.error(String(e));
      } finally {
        setLoadingJobs(false);
      }
    }
  }

  function applyRunEvent(savedSearch: SavedSearch, event: RadarRunProgressEvent, opts?: { silent?: boolean }) {
    setRuns((prevAll) => {
      const prev = prevAll[savedSearch.id];
      if (!prev) return prevAll;

      const next = ((): RunState => {
      if (event.type === "run_started") {
        return { ...prev, agentRunId: event.agent_run_id };
      }
      if (event.type === "run_cancelled") {
        return { ...prev, cancelled: true };
      }
      if (event.type === "source_started") {
        return {
          ...prev,
          sourceProgress: {
            ...prev.sourceProgress,
            [event.source_run_id]: { name: event.source_name, status: "running" },
          },
        };
      }
      if (event.type === "source_done") {
        const existing = prev.sourceProgress[event.source_run_id];
        return {
          ...prev,
          sourceProgress: {
            ...prev.sourceProgress,
            [event.source_run_id]: {
              name: existing?.name ?? "source",
              status: event.status,
              seen: event.seen,
              new: event.new,
              deduped: event.deduped,
              companyBreakdown: event.company_breakdown,
              message: event.message,
            },
          },
        };
      }
      if (event.type === "query_expansion_fallback") {
        return { ...prev, fallbacks: [...prev.fallbacks, `${event.role_title}: ${event.reason}`] };
      }
      if (event.type === "source_error") {
        return { ...prev, sourceErrors: [...prev.sourceErrors, event.message] };
      }
      if (event.type === "log") {
        // Capped so a very chatty adapter (JobSpy retrying a broken
        // site for minutes) can't grow this without bound in memory —
        // keeps the most recent lines, which is what matters live.
        return { ...prev, logs: [...prev.logs.slice(-199), event.message] };
      }
      if (event.type === "embedding_started") {
        return { ...prev, embedding: { status: "running", count: event.count } };
      }
      if (event.type === "embedding_done") {
        return {
          ...prev,
          embedding: { status: "done", count: prev.embedding?.count ?? 0, embedded: event.embedded, errors: event.errors },
        };
      }
      if (event.type === "scoring_started") {
        return { ...prev, scoring: { status: "running", count: event.count, scored: [], scoringErrors: [], summary: null } };
      }
      if (event.type === "job_scored") {
        const scoring = prev.scoring ?? { status: "running" as const, count: 0, scored: [], scoringErrors: [], summary: null };
        return {
          ...prev,
          scoring: {
            ...scoring,
            scored: [
              ...scoring.scored,
              {
                jobId: event.job_id,
                title: event.title,
                decision: event.decision,
                recommendation: event.recommendation,
                overallScore: event.overall_score,
              },
            ],
          },
        };
      }
      if (event.type === "job_scoring_error") {
        const scoring = prev.scoring ?? { status: "running" as const, count: 0, scored: [], scoringErrors: [], summary: null };
        return {
          ...prev,
          scoring: {
            ...scoring,
            scoringErrors: [...scoring.scoringErrors, { jobId: event.job_id, title: event.title, message: event.message }],
          },
        };
      }
      if (event.type === "scoring_done") {
        const scoring = prev.scoring ?? { status: "running" as const, count: 0, scored: [], scoringErrors: [], summary: null };
        return {
          ...prev,
          scoring: {
            ...scoring,
            status: "done",
            summary: { kept: event.kept, dropped: event.dropped, review: event.review, errors: event.errors },
          },
        };
      }
      if (event.type === "done") {
        return { ...prev, result: { cost_usd: event.result.cost_usd, source_runs: event.result.source_runs } };
      }
      return prev;
      })();

      return { ...prevAll, [savedSearch.id]: next };
    });
    if (event.type === "done" && !opts?.silent) {
      toast.success(`Radar run complete — cost ${money(event.result.cost_usd)}`);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Job Search</span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" disabled={!personas.length} onClick={openDiscovery}>
            Discover companies
          </Button>
          <Dialog open={discoveryOpen} onOpenChange={setDiscoveryOpen}>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Discover companies</DialogTitle>
                <DialogDescription>
                  Proposes real companies from this persona&apos;s preferences and resolves each against the six
                  ATS boards this app knows how to scan. Nothing gets queried until you approve it — resolved
                  candidates you approve join that ATS&apos;s scan list for this persona.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    For: <span className="font-medium text-foreground">{personas.find((p) => p.id === selectedPersonaId)?.name ?? "?"}</span>
                    {" "}— switch personas from the sidebar to run discovery for a different one.
                  </span>
                  <Button size="sm" onClick={handleRunDiscovery} disabled={discovering || !selectedPersonaId} className="ml-auto">
                    {discovering && <Loader2 className="size-3.5 animate-spin" />}
                    Run discovery
                  </Button>
                </div>

                <div className="flex flex-col gap-2 max-h-[55vh] overflow-auto">
                  {loadingCandidates ? (
                    <div className="text-sm text-muted-foreground font-mono">loading…</div>
                  ) : candidates.length === 0 ? (
                    <div className="text-sm text-muted-foreground border border-dashed border-input p-6 text-center">
                      No candidates yet — set preferences for this persona in Profile Studio, then run discovery.
                    </div>
                  ) : (
                    candidates.map((c) => {
                      const resolved = c.status !== "unresolved";
                      return (
                        <div key={c.id} className="border border-border px-3 py-2 flex flex-col gap-1.5">
                          <div className="flex items-start gap-2">
                            <span className="text-sm font-medium flex-1">{c.company_name}</span>
                            <Badge
                              variant="secondary"
                              className={cn(
                                "text-[9px] font-mono shrink-0",
                                resolved ? "bg-ok-bg text-ok" : "bg-muted text-muted-foreground",
                              )}
                            >
                              {resolved ? c.status.replace("resolved_", "") : "unresolved"}
                            </Badge>
                            <Badge variant="secondary" className="text-[9px] font-mono shrink-0">
                              {c.origin === "apply_link" ? "from a job's apply link" : "proposed"}
                            </Badge>
                          </div>
                          {c.rationale && <p className="text-xs text-muted-foreground">{c.rationale}</p>}
                          {resolved && c.discovered_url && (
                            <span className="font-mono text-[10px] text-muted-foreground break-all">
                              {c.discovered_url}
                            </span>
                          )}
                          <div className="flex justify-end">
                            {resolved ? (
                              <Button
                                size="sm"
                                variant={c.approved ? "outline" : "default"}
                                disabled={updatingCandidateId === c.id}
                                onClick={() => handleUpdateCandidate(c.id, !c.approved)}
                              >
                                {c.approved ? "Approved — remove from scan list" : "Approve — add to scan list"}
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                No known ATS matched — nothing to scan yet.
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </DialogContent>
          </Dialog>
          <Button size="sm" disabled={!personas.length} onClick={openCreateSearch}>
            New saved search
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-5 flex flex-col gap-4">
        {loading ? (
          <div className="text-sm text-muted-foreground font-mono">loading…</div>
        ) : savedSearches.length === 0 ? (
          <div className="text-sm text-muted-foreground border border-dashed border-input p-6 text-center">
            No saved searches yet. Set up a persona, then create one.
          </div>
        ) : (
          savedSearches.map((s) => {
            const rowRun = runs[s.id];
            const rowRunning =
              rowRun !== undefined && rowRun.result === null && rowRun.error === null && !rowRun.cancelled;
            const persona = personas.find((p) => p.id === s.persona_id);
            return (
              <div key={s.id} className="border border-border bg-card">
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <RadarIcon className="size-3.5 text-muted-foreground shrink-0" />
                      <span className="text-sm font-medium">{s.name}</span>
                      {s.schedule_cron && (
                        <label className="flex items-center gap-1.5 ml-1" title="Pause/resume the scheduled runs">
                          <Switch
                            checked={s.active}
                            onCheckedChange={(checked) => handleToggleActive(s.id, checked)}
                          />
                          <span className="text-[9px] font-mono text-muted-foreground">
                            {s.active ? "scheduled" : "paused"}
                          </span>
                        </label>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {s.role_titles.map((t) => (
                        <Badge key={t} variant="secondary" className="text-[9px] font-mono">
                          {t}
                        </Badge>
                      ))}
                    </div>
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      persona: {persona?.name ?? "?"} · {s.source_ids.length} source{s.source_ids.length === 1 ? "" : "s"}
                      {s.filters.location ? ` · ${s.filters.location}` : ""}
                      {s.schedule_cron ? (
                        <span title={s.schedule_cron}> · {formatCronSchedule(s.schedule_cron)}</span>
                      ) : (
                        " · manual only"
                      )}
                    </span>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button
                      size="sm"
                      disabled={rowRunning}
                      onClick={() => handleRun(s)}
                    >
                      {rowRunning ? "Running…" : "Run"}
                    </Button>
                    {rowRunning && rowRun?.agentRunId && (
                      <Button size="sm" variant="outline" onClick={() => handleCancelRun(rowRun.agentRunId!)}>
                        Cancel
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => openEditSearch(s)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => handleDeleteSearch(s.id)}>
                      Delete
                    </Button>
                  </div>
                </div>

                {rowRun && (
                  <div className="border-t border-border bg-secondary/40 px-4 py-3 flex flex-col gap-2">
                    {Object.entries(rowRun.sourceProgress).map(([id, p]) => {
                      const companies = Object.entries(p.companyBreakdown ?? {});
                      return (
                        <div key={id} className="flex flex-col gap-1">
                          <div className="flex items-center gap-2 text-xs">
                            {p.status === "running" ? (
                              <Loader2 className="size-3 animate-spin text-primary shrink-0" />
                            ) : (
                              <span
                                className={cn(
                                  "size-1.5 rounded-full shrink-0",
                                  p.status === "completed" ? "bg-ok" : "bg-crit",
                                )}
                              />
                            )}
                            <span className="font-mono">{p.name}</span>
                            {p.status === "completed" && (
                              <span className="text-muted-foreground">
                                seen {p.seen} · new {p.new} · deduped {p.deduped}
                              </span>
                            )}
                            {p.status === "failed" && <span className="text-crit">{p.message}</span>}
                          </div>
                          {/* M2 §6 — a scan-list source covers many companies at
                              once; only worth its own breakdown when there's more
                              than one to distinguish. */}
                          {companies.length > 1 && (
                            <div className="ml-3.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                              {companies.map(([company, stats]) => (
                                <span key={company} className="font-mono">
                                  {company}: {stats.seen}/{stats.new}n/{stats.deduped}d
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {rowRun.embedding && (
                      <div className="flex items-center gap-2 text-xs">
                        {rowRun.embedding.status === "running" ? (
                          <Loader2 className="size-3 animate-spin text-primary shrink-0" />
                        ) : (
                          <span className="size-1.5 rounded-full shrink-0 bg-ok" />
                        )}
                        <span className="font-mono">embedding</span>
                        <span className="text-muted-foreground">
                          {rowRun.embedding.status === "running"
                            ? `${rowRun.embedding.count} job${rowRun.embedding.count === 1 ? "" : "s"}`
                            : `${rowRun.embedding.embedded}/${rowRun.embedding.count} embedded`}
                        </span>
                        {!!rowRun.embedding.errors?.length && (
                          <span className="text-crit">{rowRun.embedding.errors.join("; ")}</span>
                        )}
                      </div>
                    )}
                    {rowRun.scoring && (
                      <div className="flex items-center gap-2 text-xs">
                        {rowRun.scoring.status === "running" ? (
                          <Loader2 className="size-3 animate-spin text-primary shrink-0" />
                        ) : (
                          <span className="size-1.5 rounded-full shrink-0 bg-ok" />
                        )}
                        <span className="font-mono">scoring</span>
                        <span className="text-muted-foreground">
                          {rowRun.scoring.summary
                            ? `${rowRun.scoring.summary.kept} keep · ${rowRun.scoring.summary.review} review · ${rowRun.scoring.summary.dropped} drop${rowRun.scoring.summary.errors ? ` · ${rowRun.scoring.summary.errors} errors` : ""}`
                            : `${rowRun.scoring.scored.length + rowRun.scoring.scoringErrors.length}/${rowRun.scoring.count} scored`}
                        </span>
                      </div>
                    )}
                    {rowRun.fallbacks.map((f, i) => (
                      <div key={i} className="text-[11px] text-warn font-mono">
                        query expansion fallback — {f}
                      </div>
                    ))}
                    {rowRun.sourceErrors.map((e, i) => (
                      <div key={i} className="text-[11px] text-crit font-mono">
                        {e}
                      </div>
                    ))}
                    {rowRun.error && <div className="text-xs text-crit">{rowRun.error}</div>}
                    {rowRun.cancelled && (
                      <div className="text-xs text-muted-foreground font-mono">cancelled by you</div>
                    )}

                    {/* Logs and per-job scores are verbose — collapsed
                        by default, one toggle for both, raised
                        directly by Adrian ("by default should be
                        hidden"). */}
                    {(rowRun.logs.length > 0 ||
                      (rowRun.scoring && rowRun.scoring.scored.length > 0) ||
                      (rowRun.scoring && rowRun.scoring.scoringErrors.length > 0)) && (
                      <button
                        onClick={() => toggleDetail(s.id)}
                        className="self-start flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        {expandedDetailFor.has(s.id) ? "Hide logs & scores" : "Show logs & scores"}
                        {expandedDetailFor.has(s.id) ? (
                          <ChevronUp className="size-3.5" />
                        ) : (
                          <ChevronDown className="size-3.5" />
                        )}
                      </button>
                    )}

                    {expandedDetailFor.has(s.id) && (
                      <div className="flex flex-col gap-2">
                        {rowRun.scoring && rowRun.scoring.scored.length > 0 && (
                          <div className="max-h-40 overflow-y-auto border border-border">
                            {rowRun.scoring.scored.map((sc) => (
                              <div
                                key={sc.jobId}
                                className="flex items-center gap-2 px-2 py-1 text-[11px] border-b border-border last:border-b-0"
                              >
                                <Badge
                                  variant="secondary"
                                  className={cn(
                                    "text-[9px] font-mono shrink-0",
                                    sc.decision === "keep"
                                      ? "bg-ok-bg text-ok"
                                      : sc.decision === "drop"
                                        ? "bg-muted text-muted-foreground"
                                        : "bg-warn-bg text-warn",
                                  )}
                                >
                                  {sc.recommendation ?? sc.decision}
                                </Badge>
                                <Link
                                  href={`/console/inbox?job_id=${encodeURIComponent(sc.jobId)}`}
                                  className="truncate flex-1 hover:underline"
                                >
                                  {sc.title}
                                </Link>
                                {sc.overallScore !== null && (
                                  <span className="font-mono text-muted-foreground shrink-0">{sc.overallScore}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {rowRun.scoring?.scoringErrors.map((e) => (
                          <div key={e.jobId} className="text-[11px] text-crit font-mono">
                            scoring failed — {e.title}: {e.message}
                          </div>
                        ))}
                        {rowRun.logs.length > 0 && (
                          <div className="flex flex-col gap-1">
                            <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                              Live log
                            </span>
                            <div
                              ref={(el) => {
                                // Auto-scroll-to-bottom on every render (one
                                // log box per saved search now, not a single
                                // shared ref) — an inline callback ref like
                                // this re-fires on every render, which is a
                                // cheap enough way to keep it pinned to the
                                // latest line without a per-row ref map.
                                if (el) el.scrollTop = el.scrollHeight;
                              }}
                              className="max-h-40 overflow-y-auto border border-border bg-background px-2 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground"
                            >
                              {rowRun.logs.map((line, i) => (
                                <div key={i} className="whitespace-pre-wrap break-all">
                                  {line}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {!rowRun && lastRuns[s.id] && (
                  <div className="border-t border-border bg-secondary/40 px-4 py-2 flex items-center justify-between gap-3">
                    <span className="text-xs text-muted-foreground">
                      Last run:{" "}
                      <span
                        className={cn(
                          "font-mono",
                          lastRuns[s.id]!.status === "completed" ? "text-ok" : "text-crit",
                        )}
                      >
                        {lastRuns[s.id]!.status}
                      </span>{" "}
                      · {new Date(lastRuns[s.id]!.started_at).toLocaleString()} · cost{" "}
                      {money(lastRuns[s.id]!.total_cost_usd)}
                    </span>
                    <Button size="sm" variant="outline" onClick={() => handleToggleJobs(s.id)} className="gap-1.5">
                      {expandedJobsFor === s.id ? "Hide results" : "View results"}
                      {expandedJobsFor === s.id ? (
                        <ChevronUp className="size-3.5" />
                      ) : (
                        <ChevronDown className="size-3.5" />
                      )}
                    </Button>
                  </div>
                )}

                {expandedJobsFor === s.id && (
                  <div className="border-t border-border px-4 py-3 flex flex-col gap-2">
                    {loadingJobs && !jobsCache[s.id] ? (
                      <span className="text-xs text-muted-foreground font-mono">loading…</span>
                    ) : !jobsCache[s.id]?.length ? (
                      <span className="text-xs text-muted-foreground">
                        No jobs discovered yet through this saved search&apos;s sources.
                      </span>
                    ) : (
                      jobsCache[s.id].map((job) => (
                        <div key={job.id} className="flex items-start gap-2 text-xs border-b border-border last:border-b-0 pb-2 last:pb-0">
                          <div className="flex-1 min-w-0">
                            <Link
                              href={`/console/inbox?job_id=${encodeURIComponent(job.id)}`}
                              className="font-medium hover:underline"
                            >
                              {job.title}
                            </Link>
                            <span className="block text-muted-foreground">
                              {job.company_name_raw}
                              {job.location ? ` · ${job.location}` : ""}
                              {job.remote_policy ? ` · ${job.remote_policy}` : ""}
                            </span>
                            {job.apply_url && (
                              <a
                                href={job.apply_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-block text-[10px] text-primary hover:underline"
                              >
                                Apply ↗
                              </a>
                            )}
                            {(job.salary_min || job.salary_max) && (
                              <span className="block font-mono text-[10px] text-muted-foreground tabular">
                                {job.salary_min ?? "?"}–{job.salary_max ?? "?"} {job.salary_currency ?? ""}
                              </span>
                            )}
                            {!!job.ghost_job_reasons.length && (
                              <span className="block text-[10px] text-warn">{job.ghost_job_reasons.join("; ")}</span>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingSearchId ? "Edit saved search" : "New saved search"}</DialogTitle>
            <DialogDescription>
              Runs manually via the Run button, and on a cron schedule if you set one below.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="search-name">Name</Label>
              <Input id="search-name" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="search-roles">Role titles (comma separated)</Label>
              <Input
                id="search-roles"
                placeholder="e.g. Software Engineer, Backend Engineer"
                value={draftRoleTitles}
                onChange={(e) => setDraftRoleTitles(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="search-persona">Persona</Label>
              {editingSearchId ? (
                <p className="text-sm text-muted-foreground font-mono">
                  {personas.find((p) => p.id === draftPersonaId)?.name ?? "?"} — can&apos;t be changed after
                  creation
                </p>
              ) : (
                <Select value={draftPersonaId} onValueChange={setDraftPersonaId}>
                  <SelectTrigger id="search-persona" className="w-full">
                    <SelectValue placeholder="Choose a persona" />
                  </SelectTrigger>
                  <SelectContent>
                    {personas.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label>Sources</Label>
              <div className="flex flex-wrap gap-1.5">
                {PLATFORMS.map((p) => {
                  const selected = draftSelectedPlatforms.has(p.key);
                  return (
                    <button
                      key={p.key}
                      type="button"
                      disabled={p.configKind === "coming_soon"}
                      onClick={() => toggleDraftPlatform(p.key)}
                      className={cn(
                        "flex items-center gap-1.5 border px-2 py-1.5 text-xs",
                        selected ? "border-foreground bg-accent" : "border-border",
                        p.configKind === "coming_soon" && "opacity-40 cursor-not-allowed",
                      )}
                    >
                      <PlatformLogo mark={p.mark} color={p.color} size={20} />
                      {p.label}
                      {p.configKind === "coming_soon" && (
                        <Badge variant="secondary" className="text-[9px] px-1 py-0">
                          Coming soon
                        </Badge>
                      )}
                    </button>
                  );
                })}
              </div>
              {Array.from(draftSelectedPlatforms).map((key) => {
                const platform = PLATFORM_BY_KEY[key];
                if (platform.configKind === "company_identifiers") {
                  return (
                    <div key={key} className="flex flex-col gap-1">
                      <span className="text-xs font-medium">{platform.label} companies</span>
                      <Input
                        placeholder="e.g. huggingface, notion, ..."
                        value={draftPlatformConfig[key]?.companyIdentifiers ?? ""}
                        onChange={(e) => setDraftPlatformField(key, "companyIdentifiers", e.target.value)}
                      />
                      <span className="text-xs text-muted-foreground">
                        Comma-separated — this scans every company listed, all in one run. Not a secret, no
                        signup: {COMPANY_IDENTIFIER_HINT[key]}.
                      </span>
                    </div>
                  );
                }
                if (platform.configKind === "jobspy_indeed") {
                  return (
                    <div key={key} className="flex flex-col gap-1">
                      <span className="text-xs font-medium">Indeed country</span>
                      <Input
                        placeholder="Country, e.g. Indonesia, USA, United Kingdom"
                        value={draftPlatformConfig[key]?.country ?? ""}
                        onChange={(e) => setDraftPlatformField(key, "country", e.target.value)}
                      />
                      <span className="text-xs text-muted-foreground">
                        Required — Indeed is country-scoped. Without it, a search outside the default country
                        silently returns zero results instead of an error.
                      </span>
                    </div>
                  );
                }
                return null;
              })}
              {(draftSelectedPlatforms.has("linkedin") || draftSelectedPlatforms.has("indeed")) && (
                <span className="text-xs text-warn border border-warn/40 bg-warn-bg px-2 py-1.5">
                  Scraping, not an official API — can get rate-limited. Enabled deliberately, with that
                  understood.
                </span>
              )}
              {draftUnmappedSourceIds.size > 0 && (
                <span className="text-xs text-muted-foreground">
                  + {draftUnmappedSourceIds.size} other already-attached source
                  {draftUnmappedSourceIds.size === 1 ? "" : "s"} kept as-is.
                </span>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="search-location">Location filter (optional)</Label>
              <Input id="search-location" value={draftLocation} onChange={(e) => setDraftLocation(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Schedule (optional)</Label>
              <div className="flex flex-wrap gap-1.5">
                {(Object.keys(SCHEDULE_MODE_LABELS) as ScheduleMode[]).map((m) => (
                  <Button
                    key={m}
                    type="button"
                    size="sm"
                    variant={scheduleBuilder.mode === m ? "default" : "outline"}
                    className="h-6 px-2 text-[11px]"
                    onClick={() => setScheduleBuilder((prev) => ({ ...prev, mode: m }))}
                  >
                    {SCHEDULE_MODE_LABELS[m]}
                  </Button>
                ))}
              </div>

              {scheduleBuilder.mode === "hourly" && (
                <div className="flex items-center gap-2 text-xs">
                  <span>Every</span>
                  <Select
                    value={String(scheduleBuilder.intervalHours)}
                    onValueChange={(v) => setScheduleBuilder((prev) => ({ ...prev, intervalHours: Number(v) }))}
                  >
                    <SelectTrigger className="h-7 w-[70px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {HOURLY_INTERVAL_OPTIONS.map((h) => (
                        <SelectItem key={h} value={String(h)}>
                          {h}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span>hour(s)</span>
                </div>
              )}

              {scheduleBuilder.mode === "weekly" && (
                <div className="flex items-center gap-1.5">
                  {WEEKDAY_ABBR.map((abbr, idx) => (
                    <button
                      key={idx}
                      type="button"
                      title={WEEKDAY_NAMES[idx]}
                      onClick={() =>
                        setScheduleBuilder((prev) => {
                          const next = new Set(prev.weekdays);
                          if (next.has(idx)) next.delete(idx);
                          else next.add(idx);
                          return { ...prev, weekdays: next };
                        })
                      }
                      className={cn(
                        "h-6 px-1.5 text-[10px] font-mono border border-input",
                        scheduleBuilder.weekdays.has(idx)
                          ? "bg-primary text-primary-foreground border-primary"
                          : "text-muted-foreground",
                      )}
                    >
                      {abbr}
                    </button>
                  ))}
                </div>
              )}

              {scheduleBuilder.mode === "monthly" && (
                <div className="flex items-center gap-2 text-xs">
                  <span>Day</span>
                  <Select
                    value={String(scheduleBuilder.dayOfMonth)}
                    onValueChange={(v) => setScheduleBuilder((prev) => ({ ...prev, dayOfMonth: Number(v) }))}
                  >
                    <SelectTrigger className="h-7 w-[70px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                        <SelectItem key={d} value={String(d)}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-muted-foreground">
                    of each month (capped at 28 so it&apos;s consistent every month)
                  </span>
                </div>
              )}

              {(scheduleBuilder.mode === "daily" ||
                scheduleBuilder.mode === "weekly" ||
                scheduleBuilder.mode === "monthly") && (
                <div className="flex items-center gap-2 text-xs">
                  <span>at</span>
                  <input
                    type="time"
                    value={`${String(scheduleBuilder.hour).padStart(2, "0")}:${String(scheduleBuilder.minute).padStart(2, "0")}`}
                    onChange={(e) => {
                      const [h, m] = e.target.value.split(":").map(Number);
                      if (Number.isInteger(h) && Number.isInteger(m)) {
                        setScheduleBuilder((prev) => ({ ...prev, hour: h, minute: m }));
                      }
                    }}
                    className="h-7 border border-input bg-transparent px-2 text-xs"
                  />
                </div>
              )}

              {scheduleBuilder.mode === "custom" && (
                <Input
                  placeholder="e.g. 0 8 * * *"
                  value={draftScheduleCron}
                  onChange={(e) => setDraftScheduleCron(e.target.value)}
                />
              )}

              {scheduleBuilder.mode !== "none" &&
                (() => {
                  const cron = buildCronFromSchedule(scheduleBuilder, draftScheduleCron);
                  return (
                    <span className="text-[11px] text-muted-foreground">
                      {cron ? formatCronSchedule(cron) : "Select at least one day"}
                    </span>
                  );
                })()}

              {scheduleBuilder.mode !== "none" && (
                <label className="mt-1 flex items-center gap-2 text-xs">
                  <Switch checked={draftActive} onCheckedChange={setDraftActive} />
                  {draftActive ? "Runs on schedule" : "Paused — schedule saved but won't run"}
                </label>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateOpen(false);
                setEditingSearchId(null);
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleCreateSearch} disabled={creatingSearch}>
              {creatingSearch ? "Saving…" : editingSearchId ? "Save changes" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
