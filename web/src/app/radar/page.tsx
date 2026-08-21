"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  api,
  SOURCE_ADAPTERS,
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { usePersona } from "@/components/persona-provider";
import { ChevronDown, ChevronUp, Loader2, Radar as RadarIcon } from "lucide-react";

const ADAPTER_LABEL: Record<SourceAdapterKey, string> = {
  greenhouse: "Greenhouse (ATS board)",
  lever: "Lever (ATS board)",
  workable: "Workable (ATS board)",
  ashby: "Ashby (ATS board)",
  smartrecruiters: "SmartRecruiters (ATS board)",
  recruitee: "Recruitee (ATS board)",
  remoteok: "RemoteOK (free aggregator)",
  jsearch: "JSearch (aggregator, needs RapidAPI key)",
  jobspy: "Multi-board scraper (LinkedIn/Indeed/Glassdoor/Google/ZipRecruiter)",
  socialfetch: "SocialFetch (LinkedIn, paid/credit-metered)",
};

// Scraping-based sources (vs. legitimate public/paid APIs) — shown
// with an explicit warning in the add-source form rather than left
// looking identical to Greenhouse/Lever/RemoteOK.
const SCRAPING_ADAPTERS: SourceAdapterKey[] = ["jobspy", "socialfetch"];

// Which config field(s) each adapter needs. All six ATS boards share
// the `company_identifiers` scan-list shape (M2 §6 retrofitted
// greenhouse/lever onto it too, matching the four M2 §4 adapters that
// started on it directly) — one Source scans every identifier the
// list holds, growable by discovery (PRD F2.10) or by hand here.
// Existing M1-era Source rows still carry the older singular
// `board_token` key; the adapters themselves read it as a one-element
// list (no data migration needed), but this form only ever writes the
// new `company_identifiers` shape going forward. jsearch/socialfetch
// need an API key, remoteok needs nothing at all (public, keyless),
// jobspy needs a site selection.
const ADAPTER_CONFIG: Record<SourceAdapterKey, "company_identifiers" | "api_key" | "none" | "jobspy"> = {
  greenhouse: "company_identifiers",
  lever: "company_identifiers",
  workable: "company_identifiers",
  ashby: "company_identifiers",
  smartrecruiters: "company_identifiers",
  recruitee: "company_identifiers",
  remoteok: "none",
  jsearch: "api_key",
  jobspy: "jobspy",
  socialfetch: "api_key",
};

const COMPANY_IDENTIFIER_HINT: Record<string, string> = {
  greenhouse: "the board token, e.g. job-boards.greenhouse.io/gitlab",
  lever: "the board token, e.g. jobs.lever.co/palantir",
  workable: "the account slug, e.g. apply.workable.com/huggingface",
  ashby: "the board name, e.g. jobs.ashbyhq.com/ramp",
  smartrecruiters: "the company identifier, e.g. jobs.smartrecruiters.com/Equinox",
  recruitee: "the subdomain, e.g. channable.recruitee.com",
};

const API_KEY_PLACEHOLDER: Partial<Record<SourceAdapterKey, string>> = {
  jsearch: "RapidAPI key for JSearch",
  socialfetch: "SocialFetch API key (sfk_...)",
};

const JOBSPY_SITES = [
  { value: "indeed", label: "Indeed" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "glassdoor", label: "Glassdoor" },
  { value: "google", label: "Google Jobs" },
  { value: "zip_recruiter", label: "ZipRecruiter" },
] as const;

function statusColor(status: Source["status"]) {
  switch (status) {
    case "ok":
      return "bg-ok-bg text-ok";
    case "untested":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-crit-bg text-crit";
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

  const [setupOpen, setSetupOpen] = React.useState(false);
  // M2 §5 — F2.10 discovery review/approval. Its own dialog, always
  // scoped to the globally-selected persona — discovery acts *for*
  // that persona, so there's no separate local override here.
  const [discoveryOpen, setDiscoveryOpen] = React.useState(false);
  const [candidates, setCandidates] = React.useState<CompanyCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = React.useState(false);
  const [discovering, setDiscovering] = React.useState(false);
  const [updatingCandidateId, setUpdatingCandidateId] = React.useState<string | null>(null);
  const [newSourceName, setNewSourceName] = React.useState("");
  const [newSourceAdapter, setNewSourceAdapter] = React.useState<SourceAdapterKey>("greenhouse");
  // Comma-separated, same tag-input convention as Preference's
  // target_roles/locations — one Source scans every identifier here
  // (M2 §4/§6), not one Source per company.
  const [newSourceCompanyIdentifiers, setNewSourceCompanyIdentifiers] = React.useState("");
  const [newSourceApiKey, setNewSourceApiKey] = React.useState("");
  const [newSourceJobspySites, setNewSourceJobspySites] = React.useState<Set<string>>(new Set(["indeed"]));
  const [newSourceJobspyCountry, setNewSourceJobspyCountry] = React.useState("");
  const [creatingSource, setCreatingSource] = React.useState(false);
  const [testingSourceId, setTestingSourceId] = React.useState<string | null>(null);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editingSearchId, setEditingSearchId] = React.useState<string | null>(null);
  const [draftName, setDraftName] = React.useState("");
  const [draftRoleTitles, setDraftRoleTitles] = React.useState("");
  const [draftPersonaId, setDraftPersonaId] = React.useState<string>("");
  const [draftSourceIds, setDraftSourceIds] = React.useState<Set<string>>(new Set());
  const [draftLocation, setDraftLocation] = React.useState("");
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
        if (token.cancelled || run_status !== "running") break;
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

  async function handleCreateSource() {
    if (!newSourceName.trim()) return;
    const configKind = ADAPTER_CONFIG[newSourceAdapter];
    const jobspySitesNeedingCountry = ["indeed", "glassdoor"];
    const companyIdentifiers = newSourceCompanyIdentifiers
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    const config: Record<string, string | string[]> =
      configKind === "company_identifiers"
        ? { company_identifiers: companyIdentifiers }
        : configKind === "api_key"
          ? { api_key: newSourceApiKey.trim() }
          : configKind === "jobspy"
            ? {
                sites: Array.from(newSourceJobspySites).join(","),
                ...(newSourceJobspyCountry.trim() ? { country: newSourceJobspyCountry.trim() } : {}),
              }
            : {};
    if (configKind === "company_identifiers" && companyIdentifiers.length === 0) {
      toast.error(`At least one company identifier is required for ${ADAPTER_LABEL[newSourceAdapter]}`);
      return;
    }
    if (configKind === "api_key" && !config.api_key) {
      toast.error(`API key is required for ${ADAPTER_LABEL[newSourceAdapter]}`);
      return;
    }
    if (configKind === "jobspy" && newSourceJobspySites.size === 0) {
      toast.error("Pick at least one site to scrape");
      return;
    }
    if (
      configKind === "jobspy" &&
      !config.country &&
      Array.from(newSourceJobspySites).some((s) => jobspySitesNeedingCountry.includes(s))
    ) {
      toast.error("Country is required when Indeed or Glassdoor is selected");
      return;
    }
    setCreatingSource(true);
    try {
      const source = await api.createSource({
        name: newSourceName.trim(),
        tier: "tier1_api",
        adapter_key: newSourceAdapter,
        config,
      });
      setSources((prev) => [...prev, source]);
      setNewSourceName("");
      setNewSourceCompanyIdentifiers("");
      setNewSourceApiKey("");
      setNewSourceJobspyCountry("");
      toast.success("Source added — test it to verify");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCreatingSource(false);
    }
  }

  async function handleTestSource(id: string) {
    setTestingSourceId(id);
    try {
      const updated = await api.testSource(id);
      setSources((prev) => prev.map((s) => (s.id === id ? updated : s)));
      toast[updated.status === "ok" ? "success" : "error"](
        updated.status === "ok" ? "Connection OK" : (updated.last_error ?? updated.status),
      );
    } catch (e) {
      toast.error(String(e));
    } finally {
      setTestingSourceId(null);
    }
  }

  async function handleDeleteSource(id: string) {
    try {
      await api.deleteSource(id);
      setSources((prev) => prev.filter((s) => s.id !== id));
      // A saved search referencing this source by id just skips it at
      // run time (radar.py emits a "source no longer exists" event) —
      // nothing here needs to touch saved_searches.
    } catch (e) {
      toast.error(String(e));
    }
  }

  function openCreateSearch() {
    setEditingSearchId(null);
    setDraftName("");
    setDraftRoleTitles("");
    setDraftPersonaId(selectedPersonaId);
    setDraftSourceIds(new Set());
    setDraftLocation("");
    setCreateOpen(true);
  }

  function openEditSearch(s: SavedSearch) {
    setEditingSearchId(s.id);
    setDraftName(s.name);
    setDraftRoleTitles(s.role_titles.join(", "));
    setDraftPersonaId(s.persona_id);
    setDraftSourceIds(new Set(s.source_ids));
    setDraftLocation(s.filters.location ?? "");
    setCreateOpen(true);
  }

  async function handleCreateSearch() {
    const roleTitles = draftRoleTitles
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (!draftName.trim() || !draftPersonaId || roleTitles.length === 0 || draftSourceIds.size === 0) {
      toast.error("Name, persona, at least one role title, and at least one source are all required");
      return;
    }
    setCreatingSearch(true);
    try {
      const filters = draftLocation.trim() ? { location: draftLocation.trim() } : {};
      if (editingSearchId) {
        const updated = await api.updateSavedSearch(editingSearchId, {
          name: draftName.trim(),
          role_titles: roleTitles,
          source_ids: Array.from(draftSourceIds),
          filters,
        });
        setSavedSearches((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        toast.success("Saved search updated");
      } else {
        const saved = await api.createSavedSearch({
          name: draftName.trim(),
          persona_id: draftPersonaId,
          role_titles: roleTitles,
          source_ids: Array.from(draftSourceIds),
          filters,
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
        <span className="text-sm font-semibold">Radar</span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" disabled={!personas.length} onClick={openDiscovery}>
            Discover companies
          </Button>
          <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                Setup
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>Sources</DialogTitle>
                <DialogDescription>
                  A saved search runs against a persona (switch personas from the sidebar) and one or more
                  sources — set sources up here.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-5 py-2 max-h-[60vh] overflow-auto">
                <div className="flex flex-col gap-2">
                  <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                    Sources
                  </span>
                  {sources.map((s) => (
                    <div key={s.id} className="flex items-center gap-2 border border-border px-3 py-1.5 text-sm">
                      <span className="flex-1 truncate">
                        {s.name} <span className="text-muted-foreground font-mono text-[10px]">({s.adapter_key})</span>
                      </span>
                      <span className={cn("px-1.5 py-0.5 font-mono text-[9px] uppercase", statusColor(s.status))}>
                        {s.status}
                      </span>
                      <Button size="sm" variant="outline" disabled={testingSourceId === s.id} onClick={() => handleTestSource(s.id)}>
                        Test
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => handleDeleteSource(s.id)}>
                        Delete
                      </Button>
                    </div>
                  ))}
                  <div className="flex flex-col gap-2 border border-dashed border-input p-3">
                    <div className="flex gap-2">
                      <Input
                        placeholder="Label, e.g. GitLab"
                        value={newSourceName}
                        onChange={(e) => setNewSourceName(e.target.value)}
                      />
                      <Select value={newSourceAdapter} onValueChange={(v) => setNewSourceAdapter(v as SourceAdapterKey)}>
                        <SelectTrigger className="w-56">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SOURCE_ADAPTERS.map((a) => (
                            <SelectItem key={a} value={a}>
                              {ADAPTER_LABEL[a]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {ADAPTER_CONFIG[newSourceAdapter] === "company_identifiers" && (
                      <div className="flex flex-col gap-1">
                        <Input
                          placeholder="e.g. huggingface, notion, ..."
                          value={newSourceCompanyIdentifiers}
                          onChange={(e) => setNewSourceCompanyIdentifiers(e.target.value)}
                        />
                        <span className="text-xs text-muted-foreground">
                          Comma-separated — this one source scans every company listed, all in one run. Not a
                          secret, no signup: {COMPANY_IDENTIFIER_HINT[newSourceAdapter]}.
                        </span>
                      </div>
                    )}
                    {ADAPTER_CONFIG[newSourceAdapter] === "api_key" && (
                      <Input
                        placeholder={API_KEY_PLACEHOLDER[newSourceAdapter]}
                        type="password"
                        value={newSourceApiKey}
                        onChange={(e) => setNewSourceApiKey(e.target.value)}
                      />
                    )}
                    {ADAPTER_CONFIG[newSourceAdapter] === "jobspy" && (
                      <div className="flex flex-col gap-1.5">
                        <div className="flex flex-wrap gap-3">
                          {JOBSPY_SITES.map((site) => (
                            <label key={site.value} className="flex items-center gap-1.5 text-sm cursor-pointer">
                              <input
                                type="checkbox"
                                checked={newSourceJobspySites.has(site.value)}
                                onChange={(e) =>
                                  setNewSourceJobspySites((prev) => {
                                    const next = new Set(prev);
                                    if (e.target.checked) next.add(site.value);
                                    else next.delete(site.value);
                                    return next;
                                  })
                                }
                              />
                              {site.label}
                            </label>
                          ))}
                        </div>
                        {(newSourceJobspySites.has("indeed") || newSourceJobspySites.has("glassdoor")) && (
                          <div className="flex flex-col gap-1">
                            <Input
                              placeholder="Country, e.g. Indonesia, USA, United Kingdom"
                              value={newSourceJobspyCountry}
                              onChange={(e) => setNewSourceJobspyCountry(e.target.value)}
                            />
                            <span className="text-xs text-muted-foreground">
                              Required for Indeed/Glassdoor — they&apos;re country-scoped. Without it, a search
                              outside the default country silently returns zero results instead of an error.
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                    {SCRAPING_ADAPTERS.includes(newSourceAdapter) && (
                      <span className="text-xs text-warn border border-warn/40 bg-warn-bg px-2 py-1.5">
                        Scraping, not an official API — violates the target site&apos;s terms of service and can
                        get blocked or rate-limited. Enabled deliberately, with that understood.
                      </span>
                    )}
                    {ADAPTER_CONFIG[newSourceAdapter] === "none" && (
                      <span className="text-xs text-muted-foreground">
                        No configuration needed — public and keyless.
                      </span>
                    )}
                    <Button size="sm" onClick={handleCreateSource} disabled={creatingSource || !newSourceName.trim()}>
                      Add source
                    </Button>
                  </div>
                </div>
              </div>
            </DialogContent>
          </Dialog>
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
          <Button size="sm" disabled={!personas.length || !sources.length} onClick={openCreateSearch}>
            New saved search
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-5 flex flex-col gap-4">
        {loading ? (
          <div className="text-sm text-muted-foreground font-mono">loading…</div>
        ) : savedSearches.length === 0 ? (
          <div className="text-sm text-muted-foreground border border-dashed border-input p-6 text-center">
            No saved searches yet. Set up a persona and at least one source, then create one.
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
                      {!s.active && (
                        <Badge variant="secondary" className="text-[9px] font-mono bg-muted text-muted-foreground">
                          inactive
                        </Badge>
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
                                  href={`/inbox?job_id=${encodeURIComponent(sc.jobId)}`}
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
                              href={`/inbox?job_id=${encodeURIComponent(job.id)}`}
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
            <DialogDescription>Manual run only in this milestone — scheduling comes later.</DialogDescription>
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
              <div className="flex flex-col gap-1 border border-border">
                {sources.map((s) => (
                  <label
                    key={s.id}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm border-b border-border last:border-b-0 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={draftSourceIds.has(s.id)}
                      onChange={(e) =>
                        setDraftSourceIds((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(s.id);
                          else next.delete(s.id);
                          return next;
                        })
                      }
                    />
                    {s.name}
                    <span className="text-muted-foreground font-mono text-[10px]">({s.adapter_key})</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="search-location">Location filter (optional)</Label>
              <Input id="search-location" value={draftLocation} onChange={(e) => setDraftLocation(e.target.value)} />
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
