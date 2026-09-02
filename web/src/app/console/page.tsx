"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  api,
  CATEGORY_COLOR_CLASS,
  CV_PARSE_STAGES,
  EVIDENCE_CATEGORIES,
  type Application,
  type CVParseStage,
  type DashboardSummary,
  type EvidenceCategory,
  type EvidenceItem,
  type InboxJob,
  type PipelineStage,
  type Preference,
  type PreferenceUpsert,
  type Profile,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { usePersona } from "@/components/persona-provider";
import { RECOMMENDATION_LABEL, recommendationColor } from "@/lib/recommendation";
import { Check, Circle, FileText, Loader2, Plus, Search, UploadCloud, Users } from "lucide-react";

// Dashboard = the old /console (account-wide stats) merged with the
// old Profile Studio (/console/profile) into one page with its own
// tabs — the sidebar's "Profile Studio" entry and the app logo both
// point here now, under the name "Dashboard" (raised directly by
// Adrian). See nav.ts and app-shell.tsx for the other halves of this
// change.

const CATEGORY_LABEL: Record<EvidenceCategory, string> = {
  experience: "Experience",
  education: "Education",
  certification: "Certifications",
  project: "Projects",
  achievement: "Achievements",
  skill: "Skills",
  other: "Other",
};

const UNGROUPED = "__ungrouped__"; // sentinel — never a real employer string

const STAGE_LABEL: Record<CVParseStage, string> = {
  extracting: "Extracting text",
  resolving_models: "Resolving models",
  parsing: "Parsing with AI",
  saving: "Saving evidence",
  embedding: "Embedding evidence",
};

type ProfileDraft = {
  full_name: string;
  headline: string;
  email: string;
  phone: string;
  location: string;
  links: string;
  summary: string;
  skills: string;
};

function profileDraftFromProfile(profile: Profile): ProfileDraft {
  const p = profile.parsed_profile ?? {};
  return {
    full_name: p.full_name ?? "",
    headline: p.headline ?? "",
    email: p.email ?? "",
    phone: p.phone ?? "",
    location: p.location ?? "",
    links: (p.links ?? []).join(", "),
    summary: p.summary ?? "",
    skills: (p.skills ?? []).join(", "),
  };
}

type EvidenceDraft = {
  category: EvidenceCategory;
  title: string;
  text: string;
  skills: string;
  metrics: string;
  employer: string;
  date_start: string;
  date_end: string;
};

function draftFromItem(item: EvidenceItem): EvidenceDraft {
  return {
    category: item.category,
    title: item.title ?? "",
    text: item.text,
    skills: item.skills.join(", "),
    metrics: JSON.stringify(item.metrics, null, 2),
    employer: item.employer ?? "",
    date_start: item.date_start ?? "",
    date_end: item.date_end ?? "",
  };
}

function emptyEvidenceDraft(): EvidenceDraft {
  return { category: "experience", title: "", text: "", skills: "", metrics: "{}", employer: "", date_start: "", date_end: "" };
}

function hasParsedProfile(profile: Profile): boolean {
  return Object.values(profile.parsed_profile ?? {}).some((value) =>
    Array.isArray(value) ? value.length > 0 : Boolean(value),
  );
}

function formatDateRange(item: EvidenceItem): string | null {
  if (!item.date_start && !item.date_end) return null;
  return `${item.date_start ?? "?"} — ${item.date_end ?? "ongoing"}`;
}

/** Items under one employer/role rarely share identical dates once
 * you allow for minor drift, but usually agree closely enough to show
 * one range in the group header — use the widest span present. */
function groupDateRange(items: EvidenceItem[]): string | null {
  const starts = items.map((i) => i.date_start).filter((d): d is string => !!d);
  const ends = items.map((i) => i.date_end).filter((d): d is string => !!d);
  const hasOngoing = items.some((i) => i.date_start && !i.date_end);
  if (starts.length === 0) return null;
  const start = starts.sort()[0];
  const end = hasOngoing ? "ongoing" : ends.length ? ends.sort().at(-1) : "?";
  return `${start} — ${end}`;
}

const SENIORITY_OPTIONS = ["intern", "junior", "mid", "senior", "lead", "staff", "principal"];
const REMOTE_POLICY_OPTIONS = ["onsite", "hybrid", "remote"];
const COMPANY_SIZE_OPTIONS = ["startup", "scale-up", "mid-size", "enterprise"];

type PreferenceDraft = {
  target_roles: string;
  seniority: string[];
  salary_floor: string;
  salary_target: string;
  salary_currency: string;
  locations: string;
  willing_to_relocate: boolean;
  remote_policy: string[];
  industries_include: string;
  industries_exclude: string;
  company_size_pref: string[];
  deal_breakers: string;
};

function preferenceDraftFromPreference(pref: Preference | null): PreferenceDraft {
  return {
    target_roles: (pref?.target_roles ?? []).join(", "),
    seniority: pref?.seniority ?? [],
    salary_floor: pref?.salary_floor != null ? String(pref.salary_floor) : "",
    salary_target: pref?.salary_target != null ? String(pref.salary_target) : "",
    salary_currency: pref?.salary_currency ?? "IDR",
    locations: (pref?.locations ?? []).join(", "),
    willing_to_relocate: pref?.willing_to_relocate ?? false,
    remote_policy: pref?.remote_policy ?? [],
    industries_include: (pref?.industries_include ?? []).join(", "),
    industries_exclude: (pref?.industries_exclude ?? []).join(", "),
    company_size_pref: pref?.company_size_pref ?? [],
    deal_breakers: (pref?.deal_breakers ?? []).join(", "),
  };
}

function splitTags(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function toggleInArray(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function optionLabel(value: string): string {
  return value[0].toUpperCase() + value.slice(1);
}

/** M2 §2 follow-up — Adrian wanted these multi-select, not one-of:
 * being open to both "senior" and "lead", or both "hybrid" and
 * "remote", is the common case, not the exception. */
function CheckboxGroup({
  legend,
  options,
  selected,
  onToggle,
}: {
  legend: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{legend}</Label>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {options.map((opt) => {
          const id = `${legend}-${opt}`.replace(/\s+/g, "-").toLowerCase();
          return (
            <div key={opt} className="flex items-center gap-1.5">
              <Checkbox id={id} checked={selected.includes(opt)} onCheckedChange={() => onToggle(opt)} />
              <Label htmlFor={id} className="font-normal">
                {optionLabel(opt)}
              </Label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Shared empty-state for the two "top 3" cards below — both bottom
// out at the same place (nothing's been discovered yet), so both
// point at the same fix (raised directly by Adrian: "if none has been
// made yet it will just say no job discovered, start discovering in
// job search redirect").
function NoJobsYet() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
      <span className="text-xs text-muted-foreground">No jobs discovered yet.</span>
      <Button size="sm" variant="outline" asChild>
        <Link href="/console/radar">Start discovering</Link>
      </Button>
    </div>
  );
}

// Overview — the Dashboard's landing tab, meant to be a real place to
// start working from rather than just a stats readout (raised
// directly by Adrian: "more than just stats... start using the
// features without checking the sidebar"). Everything below the
// persona gate is scoped to whichever persona is selected in the
// sidebar, same as the other three tabs — only the stats section at
// the bottom stays account-wide (Job/Application/Document are only
// ever filtered by user_id at the model level, not persona_id).
// `items`/`onUploadCv` come from DashboardPage — reusing its
// already-loaded evidence bank and its Upload CV dialog instead of a
// second copy of both.
function OverviewPanel({
  items,
  onUploadCv,
}: {
  items: EvidenceItem[];
  onUploadCv: () => void;
}) {
  const router = useRouter();
  const {
    personas,
    loading: personaLoading,
    selectedPersona,
    selectedPersonaId,
    setSelectedPersonaId,
    refreshPersonas,
  } = usePersona();

  const [newPersonaOpen, setNewPersonaOpen] = React.useState(false);
  const [newPersonaName, setNewPersonaName] = React.useState("");
  const [creatingPersona, setCreatingPersona] = React.useState(false);

  async function handleCreatePersona() {
    if (!newPersonaName.trim()) return;
    setCreatingPersona(true);
    try {
      const persona = await api.createPersona({ name: newPersonaName.trim() });
      setNewPersonaName("");
      setNewPersonaOpen(false);
      await refreshPersonas();
      setSelectedPersonaId(persona.id);
      toast.success("Persona created — upload a CV below to get started");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCreatingPersona(false);
    }
  }

  const [searchQuery, setSearchQuery] = React.useState("");
  function handleSearch() {
    const q = searchQuery.trim();
    if (!q) return;
    router.push(`/console/radar?prefill=${encodeURIComponent(q)}`);
  }

  // Base CV preview — same render call Composer's own BaseCvPanel
  // uses, just the first available template (no switcher here; the
  // full controls live in Composer, this is a peek, not the editor).
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [renderingCv, setRenderingCv] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (() =>
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      }))();
    if (!selectedPersonaId || items.length === 0) return;
    (async () => {
      setRenderingCv(true);
      try {
        const templates = await api.listTemplates();
        const first = templates[0]?.id;
        if (!first || cancelled) return;
        const blob = await api.renderBaseCv(selectedPersonaId, first);
        if (cancelled) return;
        setPreviewUrl(URL.createObjectURL(blob));
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      } finally {
        if (!cancelled) setRenderingCv(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPersonaId, items.length]);

  // Top 3 discovered jobs — same "recommended" sort Job Inbox itself
  // defaults to, just capped at 3.
  const [topJobs, setTopJobs] = React.useState<InboxJob[] | null>(null);

  React.useEffect(() => {
    if (!selectedPersonaId) {
      (() => setTopJobs(null))();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const jobs = await api.listInboxJobs(selectedPersonaId, { sort: "recommended", limit: 3 });
        if (!cancelled) setTopJobs(jobs);
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPersonaId]);

  // Top 3 furthest-along pipeline applications — "furthest" = highest
  // PipelineStage.position in this user's own custom stage order,
  // which already includes terminal stages like Rejected/Offer
  // wherever the user placed them, so no special-casing needed to
  // include those ("even including rejected etc.", per Adrian).
  // PipelineStage is account-wide (one board per user, not one per
  // persona — listPipelineStages takes no persona param), so only the
  // application filter below is persona-scoped.
  const [topPipeline, setTopPipeline] = React.useState<Application[] | null>(null);
  const [pipelineStages, setPipelineStages] = React.useState<PipelineStage[]>([]);

  React.useEffect(() => {
    if (!selectedPersonaId) {
      (() => setTopPipeline(null))();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [apps, stages] = await Promise.all([api.listApplications(), api.listPipelineStages()]);
        if (cancelled) return;
        setPipelineStages(stages);
        const positionByKey = new Map(stages.map((s) => [s.key, s.position]));
        const mine = apps
          .filter((a) => a.persona_id === selectedPersonaId)
          .sort((a, b) => {
            const pa = positionByKey.get(a.state) ?? -1;
            const pb = positionByKey.get(b.state) ?? -1;
            if (pa !== pb) return pb - pa;
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
          })
          .slice(0, 3);
        setTopPipeline(mine);
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPersonaId]);

  const stageDisplayName = React.useCallback(
    (key: string) => pipelineStages.find((s) => s.key === key)?.display_name ?? key,
    [pipelineStages],
  );

  // Account-wide stats — unchanged from the page this tab replaced.
  const [summary, setSummary] = React.useState<DashboardSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = React.useState(true);

  React.useEffect(() => {
    (async () => {
      try {
        setSummary(await api.getDashboardSummary());
      } catch (e) {
        toast.error(String(e));
      } finally {
        setLoadingSummary(false);
      }
    })();
  }, []);

  const totalApplications = summary?.applications_by_stage.reduce((sum, s) => sum + s.count, 0) ?? 0;
  const maxStageCount = Math.max(1, ...(summary?.applications_by_stage.map((s) => s.count) ?? [1]));
  const maxDailyCount = Math.max(
    1,
    ...(summary?.daily_activity.flatMap((d) => [d.jobs_discovered, d.applications_created]) ?? [1]),
  );

  if (personaLoading) {
    return <div className="text-sm text-muted-foreground font-mono">loading…</div>;
  }

  if (personas.length === 0) {
    return (
      <div className="flex max-w-md flex-col items-center gap-3 border border-dashed border-input p-8 text-center">
        <Users className="size-6 text-muted-foreground" strokeWidth={1.5} />
        <div>
          <div className="text-sm font-medium">Create your first persona</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Every profile, evidence bank, saved search, and application belongs to a persona — create one to get
            started.
          </div>
        </div>
        <div className="flex w-full gap-2">
          <Input
            placeholder="e.g. Backend Engineer track"
            value={newPersonaName}
            onChange={(e) => setNewPersonaName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreatePersona()}
          />
          <Button onClick={handleCreatePersona} disabled={creatingPersona || !newPersonaName.trim()}>
            {creatingPersona ? "Creating…" : "Create"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          Working as <span className="font-medium text-foreground">{selectedPersona?.name ?? "?"}</span>
        </div>
        {newPersonaOpen ? (
          <div className="flex gap-2">
            <Input
              autoFocus
              className="h-8 w-48 text-xs"
              placeholder="e.g. PM track"
              value={newPersonaName}
              onChange={(e) => setNewPersonaName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreatePersona()}
            />
            <Button size="sm" onClick={handleCreatePersona} disabled={creatingPersona || !newPersonaName.trim()}>
              {creatingPersona ? "Creating…" : "Create"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setNewPersonaOpen(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setNewPersonaOpen(true)}>
            <Plus className="size-3.5" />
            New persona
          </Button>
        )}
      </section>

      <section className="flex max-w-xl gap-2">
        <Input
          placeholder="e.g. Backend Engineer in Jakarta"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          className="flex-1"
        />
        <Button onClick={handleSearch} disabled={!searchQuery.trim()}>
          <Search className="size-3.5" />
          Search
        </Button>
      </section>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3 max-w-3xl">
        <div className="border border-border bg-card p-4 flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
            Jobs discovered
          </span>
          <span className="font-mono text-2xl font-semibold tabular">
            {loadingSummary || !summary ? "—" : summary.job_count}
          </span>
        </div>
        <div className="border border-border bg-card p-4 flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
            Applications tracked
          </span>
          <span className="font-mono text-2xl font-semibold tabular">
            {loadingSummary || !summary ? "—" : totalApplications}
          </span>
        </div>
        <div className="border border-border bg-card p-4 flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
            Documents generated
          </span>
          <span className="font-mono text-2xl font-semibold tabular">
            {loadingSummary || !summary ? "—" : summary.document_count}
          </span>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Base CV preview */}
        <div className="flex flex-col border border-border bg-card">
          <div className="h-9 border-b border-border bg-secondary flex items-center justify-between px-3">
            <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">Base CV</span>
            <Link href="/console/composer" className="text-[11px] text-muted-foreground hover:text-foreground underline">
              See more CVs
            </Link>
          </div>
          <div className="flex-1 p-3">
            {items.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
                <UploadCloud className="size-5 text-muted-foreground" strokeWidth={1.5} />
                <span className="text-xs text-muted-foreground">
                  No evidence yet — upload a CV to generate one.
                </span>
                <Button size="sm" variant="outline" onClick={onUploadCv}>
                  Upload CV
                </Button>
              </div>
            ) : (
              <div className="h-64 overflow-hidden border border-border bg-muted/30">
                {previewUrl ? (
                  <iframe src={previewUrl} className="w-full h-full" title="Base CV preview" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground font-mono">
                    {renderingCv ? "Rendering…" : "—"}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Top 3 discovered jobs */}
        <div className="flex flex-col border border-border bg-card">
          <div className="h-9 border-b border-border bg-secondary flex items-center justify-between px-3">
            <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
              Top discovered jobs
            </span>
            <Link href="/console/inbox" className="text-[11px] text-muted-foreground hover:text-foreground underline">
              See more
            </Link>
          </div>
          <div className="flex flex-1 flex-col p-3">
            {!topJobs ? (
              <span className="text-xs text-muted-foreground font-mono">loading…</span>
            ) : topJobs.length === 0 ? (
              <NoJobsYet />
            ) : (
              <div className="flex flex-col gap-2">
                {topJobs.map((job) => (
                  <Link
                    key={job.id}
                    href="/console/inbox"
                    className="flex items-start gap-2 border border-border px-2.5 py-2 hover:border-primary transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium truncate">{job.title}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{job.company_name_raw}</div>
                    </div>
                    <Badge
                      className={cn(
                        "text-[9px] font-mono shrink-0",
                        job.fit_score ? recommendationColor(job.fit_score.recommendation) : "bg-muted text-muted-foreground",
                      )}
                    >
                      {job.fit_score ? RECOMMENDATION_LABEL[job.fit_score.recommendation] : "unscored"}
                    </Badge>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Top 3 furthest-along pipeline applications */}
        <div className="flex flex-col border border-border bg-card">
          <div className="h-9 border-b border-border bg-secondary flex items-center justify-between px-3">
            <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
              Pipeline progress
            </span>
            <Link href="/console/pipeline" className="text-[11px] text-muted-foreground hover:text-foreground underline">
              See more
            </Link>
          </div>
          <div className="flex flex-1 flex-col p-3">
            {!topPipeline ? (
              <span className="text-xs text-muted-foreground font-mono">loading…</span>
            ) : topPipeline.length === 0 ? (
              <NoJobsYet />
            ) : (
              <div className="flex flex-col gap-2">
                {topPipeline.map((app) => (
                  <Link
                    key={app.id}
                    href={`/console/pipeline?application_id=${app.id}`}
                    className="flex items-start gap-2 border border-border px-2.5 py-2 hover:border-primary transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium truncate">{app.job_title}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{app.company_name}</div>
                    </div>
                    <Badge variant="outline" className="text-[9px] font-mono shrink-0">
                      {stageDisplayName(app.state)}
                    </Badge>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {summary && summary.applications_by_stage.length > 0 && (
        <section className="flex flex-col gap-2 max-w-2xl">
          <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
            Pipeline by stage
          </span>
          <div className="border border-border bg-card p-4 flex flex-col gap-2">
            {summary.applications_by_stage.map((s) => (
              <div key={s.stage} className="flex items-center gap-3 text-xs">
                <span className="w-40 shrink-0 truncate" title={s.display_name}>
                  {s.display_name}
                </span>
                <div className="flex-1 h-2 bg-secondary overflow-hidden">
                  <div className="h-full bg-primary" style={{ width: `${(s.count / maxStageCount) * 100}%` }} />
                </div>
                <span className="w-6 text-right font-mono tabular">{s.count}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {summary && (
        <section className="flex flex-col gap-2 max-w-3xl">
          <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
            Daily activity — last {summary.daily_activity.length} days
          </span>
          <div className="border border-border bg-card p-4">
            <div className="flex items-end gap-1" style={{ height: 110 }}>
              {summary.daily_activity.map((d) => (
                <div key={d.date} className="flex-1 h-full flex items-end gap-0.5" title={d.date}>
                  <div
                    className="flex-1 bg-primary min-h-px"
                    style={{ height: `${(d.jobs_discovered / maxDailyCount) * 100}%` }}
                  />
                  <div
                    className="flex-1 bg-ok min-h-px"
                    style={{ height: `${(d.applications_created / maxDailyCount) * 100}%` }}
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between mt-2 text-[10px] text-muted-foreground font-mono">
              <span>{summary.daily_activity[0]?.date}</span>
              <span>{summary.daily_activity[summary.daily_activity.length - 1]?.date}</span>
            </div>
            <div className="flex items-center gap-4 mt-2 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="size-2 bg-primary inline-block" /> Jobs discovered
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 bg-ok inline-block" /> Applications created
              </span>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

/** F1.9 — each Preference field as its own plain-language question with
 * structured input, not one free-text box standing in for the schema.
 * Persona selection is global now (AppShell's sidebar switcher) — this
 * just reads `usePersona()` instead of fetching/selecting its own. */
function PreferencesPanel() {
  const { selectedPersonaId } = usePersona();
  const [draft, setDraft] = React.useState<PreferenceDraft>(preferenceDraftFromPreference(null));
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!selectedPersonaId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const pref = await api.getPreference(selectedPersonaId);
        if (!cancelled) setDraft(preferenceDraftFromPreference(pref));
      } catch {
        if (!cancelled) toast.error("Failed to load preferences");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPersonaId]);

  async function handleSave() {
    if (!selectedPersonaId) return;
    setSaving(true);
    try {
      const body: PreferenceUpsert = {
        target_roles: splitTags(draft.target_roles),
        seniority: draft.seniority,
        salary_floor: draft.salary_floor ? Number(draft.salary_floor) : null,
        salary_target: draft.salary_target ? Number(draft.salary_target) : null,
        salary_currency: draft.salary_currency.trim().toUpperCase() || "IDR",
        locations: splitTags(draft.locations),
        willing_to_relocate: draft.willing_to_relocate,
        remote_policy: draft.remote_policy,
        industries_include: splitTags(draft.industries_include),
        industries_exclude: splitTags(draft.industries_exclude),
        company_size_pref: draft.company_size_pref,
        deal_breakers: splitTags(draft.deal_breakers),
      };
      const saved = await api.upsertPreference(selectedPersonaId, body);
      setDraft(preferenceDraftFromPreference(saved));
      toast.success("Preferences saved");
    } catch {
      toast.error("Failed to save preferences");
    } finally {
      setSaving(false);
    }
  }

  if (!selectedPersonaId) return null; // no persona selected yet (or none exist) — nothing to attach preferences to

  return (
    <div className="border border-border bg-card">
      <div className="h-10 border-b border-border bg-secondary flex items-center px-3">
        <span className="font-mono text-[11px] tracking-wider uppercase text-muted-foreground">Preferences</span>
      </div>
      <div className="p-4 flex flex-col gap-4">
        {loading ? (
          <div className="text-sm text-muted-foreground font-mono">loading…</div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label>What roles are you targeting?</Label>
                <Input
                  value={draft.target_roles}
                  onChange={(e) => setDraft({ ...draft, target_roles: e.target.value })}
                  placeholder="AI Engineer, ML Engineer, Data Scientist"
                />
              </div>

              <CheckboxGroup
                legend="What seniority levels are acceptable?"
                options={SENIORITY_OPTIONS}
                selected={draft.seniority}
                onToggle={(v) => setDraft({ ...draft, seniority: toggleInArray(draft.seniority, v) })}
              />

              <CheckboxGroup
                legend="What remote-work arrangements are acceptable?"
                options={REMOTE_POLICY_OPTIONS}
                selected={draft.remote_policy}
                onToggle={(v) => setDraft({ ...draft, remote_policy: toggleInArray(draft.remote_policy, v) })}
              />

              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label>Which locations are you targeting?</Label>
                <Input
                  value={draft.locations}
                  onChange={(e) => setDraft({ ...draft, locations: e.target.value })}
                  placeholder="Jakarta, Singapore, Remote"
                />
              </div>

              <div className="flex items-center gap-2 sm:col-span-2">
                <Checkbox
                  id="willing-to-relocate"
                  checked={draft.willing_to_relocate}
                  onCheckedChange={(v) => setDraft({ ...draft, willing_to_relocate: v === true })}
                />
                <Label htmlFor="willing-to-relocate" className="font-normal">
                  I&apos;m open to relocating for the right role, even outside the locations above
                </Label>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Minimum acceptable salary</Label>
                <div className="flex gap-2">
                  <Input
                    className="w-20"
                    value={draft.salary_currency}
                    onChange={(e) => setDraft({ ...draft, salary_currency: e.target.value })}
                    placeholder="IDR"
                    maxLength={3}
                  />
                  <Input
                    type="number"
                    value={draft.salary_floor}
                    onChange={(e) => setDraft({ ...draft, salary_floor: e.target.value })}
                    placeholder="e.g. 15000000"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Target salary</Label>
                <Input
                  type="number"
                  value={draft.salary_target}
                  onChange={(e) => setDraft({ ...draft, salary_target: e.target.value })}
                  placeholder="e.g. 25000000"
                />
              </div>

              <CheckboxGroup
                legend="What company sizes do you prefer?"
                options={COMPANY_SIZE_OPTIONS}
                selected={draft.company_size_pref}
                onToggle={(v) => setDraft({ ...draft, company_size_pref: toggleInArray(draft.company_size_pref, v) })}
              />

              <div className="flex flex-col gap-1.5">
                <Label>Which industries do you want?</Label>
                <Input
                  value={draft.industries_include}
                  onChange={(e) => setDraft({ ...draft, industries_include: e.target.value })}
                  placeholder="Fintech, AI/ML"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Which industries do you want to avoid?</Label>
                <Input
                  value={draft.industries_exclude}
                  onChange={(e) => setDraft({ ...draft, industries_exclude: e.target.value })}
                  placeholder="Gambling, MLM"
                />
              </div>

              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label>Any deal-breakers?</Label>
                <Input
                  value={draft.deal_breakers}
                  onChange={(e) => setDraft({ ...draft, deal_breakers: e.target.value })}
                  placeholder="No unpaid overtime, no equity-only comp"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="size-3.5 animate-spin" />}
                Save preferences
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  // Every persona owns its own profile/evidence bank exclusively now —
  // the Preferences/Profile/Experience tabs always operate on whichever
  // persona is selected in the sidebar, not "the" one global profile.
  // Overview (above) is the one exception — account-wide, no persona
  // dependency.
  const { selectedPersona, loading: personaLoading } = usePersona();
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [items, setItems] = React.useState<EvidenceItem[]>([]);
  // Top-level section — separate from `tab` below (that one filters
  // WHICH evidence category shows inside the Experience section).
  const [studioTab, setStudioTab] = React.useState<"overview" | "preferences" | "profile" | "evidence">("overview");
  const [tab, setTab] = React.useState<"all" | EvidenceCategory>("all");
  const [loading, setLoading] = React.useState(true);
  // `parsing` stays the single source of truth for "a parse is in
  // flight" — it gates the header button/confirm control regardless of
  // whether the modal is open, since closing the modal must not stop
  // the actual request (it's driven by this component's own async
  // generator consumption below, not by anything the modal renders).
  const [parsing, setParsing] = React.useState(false);
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [pendingFile, setPendingFile] = React.useState<File | null>(null);
  const [activeStage, setActiveStage] = React.useState<CVParseStage | null>(null);
  const [completedStages, setCompletedStages] = React.useState<Set<CVParseStage>>(new Set());
  const [parseError, setParseError] = React.useState<string | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [editing, setEditing] = React.useState<EvidenceItem | null>(null);
  const [draft, setDraft] = React.useState<EvidenceDraft | null>(null);
  const [savingEdit, setSavingEdit] = React.useState(false);
  const [addingEvidence, setAddingEvidence] = React.useState(false);
  const [newDraft, setNewDraft] = React.useState<EvidenceDraft>(emptyEvidenceDraft());
  const [savingNew, setSavingNew] = React.useState(false);
  const [editingProfile, setEditingProfile] = React.useState(false);
  const [profileDraft, setProfileDraft] = React.useState<ProfileDraft | null>(null);
  const [savingProfile, setSavingProfile] = React.useState(false);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [resetConfirmText, setResetConfirmText] = React.useState("");
  const [resetting, setResetting] = React.useState(false);
  const modalFileInputRef = React.useRef<HTMLInputElement>(null);

  const loadAll = React.useCallback(async () => {
    if (!selectedPersona) {
      setProfile(null);
      setItems([]);
      return;
    }
    const p = await api.getProfile(selectedPersona.profile_id);
    setProfile(p);
    const evidence = await api.listEvidence(p.id);
    setItems(evidence);
  }, [selectedPersona]);

  React.useEffect(() => {
    if (personaLoading) return; // wait for the sidebar's persona context to resolve first
    let cancelled = false;
    (async () => {
      setLoading(true);
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
  }, [loadAll, personaLoading]);

  function openUploadModal() {
    // Reopening while a parse is already running just brings the
    // progress screen back — it does not start a second upload. The
    // in-flight request lives in `runParse` below, entirely independent
    // of whether this modal is mounted/open, so closing and reopening
    // never affects it.
    if (!parsing) {
      setPendingFile(null);
      setActiveStage(null);
      setCompletedStages(new Set());
      setParseError(null);
    }
    setUploadOpen(true);
  }

  function selectFile(file: File) {
    setPendingFile(file);
    setParseError(null);
  }

  async function runParse() {
    if (!profile || !pendingFile) return;

    setParsing(true);
    setParseError(null);
    setActiveStage(null);
    setCompletedStages(new Set());

    try {
      for await (const event of api.streamParseCV(profile.id, pendingFile)) {
        if (event.type === "stage") {
          if (event.status === "started") {
            setActiveStage(event.stage);
          } else {
            setCompletedStages((prev) => new Set(prev).add(event.stage));
          }
        } else if (event.type === "done") {
          setItems(event.result.evidence_items);
          setProfile(event.result.profile);
          toast.success(
            `Extracted ${event.result.evidence_items.length} evidence items — cost $${event.result.cost_usd.toFixed(6)}`,
          );
          setTab("all");
          setUploadOpen(false);
          setPendingFile(null);
        } else if (event.type === "error") {
          setParseError(event.message);
          toast.error(event.message);
        }
      }
    } catch (err) {
      setParseError(String(err));
      toast.error(String(err));
    } finally {
      setParsing(false);
    }
  }

  function handleModalFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) selectFile(file);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) selectFile(file);
  }

  function openEdit(item: EvidenceItem) {
    setEditing(item);
    setDraft(draftFromItem(item));
  }

  async function handleSaveEdit() {
    if (!profile || !editing || !draft) return;
    if (!draft.text.trim()) {
      toast.error("Evidence text cannot be empty");
      return;
    }

    let metrics: Record<string, string>;
    try {
      const parsed = JSON.parse(draft.metrics || "{}");
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("metrics must be a JSON object");
      }
      metrics = parsed as Record<string, string>;
    } catch (e) {
      toast.error(`Metrics JSON is invalid: ${String(e)}`);
      return;
    }

    setSavingEdit(true);
    try {
      const updated = await api.updateEvidence(profile.id, editing.id, {
        category: draft.category,
        title: draft.title.trim() || null,
        text: draft.text.trim(),
        skills: draft.skills
          .split(",")
          .map((skill) => skill.trim())
          .filter(Boolean),
        metrics,
        employer: draft.employer.trim() || null,
        date_start: draft.date_start || null,
        date_end: draft.date_end || null,
      });
      setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setEditing(null);
      setDraft(null);
      setProfile(await api.getProfile(profile.id));
      toast.success("Evidence updated and re-embedded");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleCreateEvidence() {
    if (!profile) return;
    if (!newDraft.text.trim()) {
      toast.error("Evidence text cannot be empty");
      return;
    }

    let metrics: Record<string, string>;
    try {
      const parsed = JSON.parse(newDraft.metrics || "{}");
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("metrics must be a JSON object");
      }
      metrics = parsed as Record<string, string>;
    } catch (e) {
      toast.error(`Metrics JSON is invalid: ${String(e)}`);
      return;
    }

    setSavingNew(true);
    try {
      const created = await api.createEvidence(profile.id, {
        category: newDraft.category,
        title: newDraft.title.trim() || null,
        text: newDraft.text.trim(),
        skills: newDraft.skills
          .split(",")
          .map((skill) => skill.trim())
          .filter(Boolean),
        metrics,
        employer: newDraft.employer.trim() || null,
        date_start: newDraft.date_start || null,
        date_end: newDraft.date_end || null,
      });
      setItems((prev) => [...prev, created]);
      setAddingEvidence(false);
      setNewDraft(emptyEvidenceDraft());
      setProfile(await api.getProfile(profile.id));
      toast.success("Evidence added and embedded");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSavingNew(false);
    }
  }

  async function handleDelete(id: string) {
    if (!profile) return;
    try {
      await api.deleteEvidence(profile.id, id);
      setItems((prev) => prev.filter((it) => it.id !== id));
      setProfile(await api.getProfile(profile.id));
    } catch (e) {
      toast.error(String(e));
    }
  }

  function openProfileEdit() {
    if (!profile) return;
    setProfileDraft(profileDraftFromProfile(profile));
    setEditingProfile(true);
  }

  async function handleSaveProfile() {
    if (!profile || !profileDraft) return;
    setSavingProfile(true);
    try {
      const updated = await api.updateProfile(profile.id, {
        parsed_profile: {
          full_name: profileDraft.full_name.trim() || null,
          headline: profileDraft.headline.trim() || null,
          email: profileDraft.email.trim() || null,
          phone: profileDraft.phone.trim() || null,
          location: profileDraft.location.trim() || null,
          links: profileDraft.links
            .split(",")
            .map((l) => l.trim())
            .filter(Boolean),
          summary: profileDraft.summary.trim() || null,
          skills: profileDraft.skills
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      setProfile(updated);
      setItems((prev) => prev.map((item) => ({ ...item, verified: updated.confirmed })));
      setEditingProfile(false);
      setProfileDraft(null);
      toast.success("Profile updated — confirmation reset, review before re-confirming");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleReset() {
    if (!profile) return;
    setResetting(true);
    try {
      const fresh = await api.resetProfile(profile.id);
      setProfile(fresh);
      setItems([]);
      setTab("all");
      setResetOpen(false);
      setResetConfirmText("");
      toast.success("Profile reset — all evidence and downstream data deleted");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setResetting(false);
    }
  }

  async function handleConfirm() {
    if (!profile) return;
    if (!profile.confirmed && (!items.length || items.some((item) => !item.embedded))) {
      toast.error("Parse the CV and make sure every evidence item is embedded first");
      return;
    }
    try {
      const updated = await api.updateProfile(profile.id, { confirmed: !profile.confirmed });
      setProfile(updated);
      setItems((prev) => prev.map((item) => ({ ...item, verified: updated.confirmed })));
      toast.success(updated.confirmed ? "Profile confirmed" : "Profile unconfirmed");
    } catch (e) {
      toast.error(String(e));
    }
  }

  const counts = React.useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    for (const cat of EVIDENCE_CATEGORIES) c[cat] = 0;
    for (const item of items) c[item.category] = (c[item.category] ?? 0) + 1;
    return c;
  }, [items]);

  const visible = tab === "all" ? items : items.filter((it) => it.category === tab);

  // Each atomic accomplishment stays its own separately-selectable
  // evidence row underneath (the tailoring agent will need to pick
  // individual ones later, not whole employers) — grouping here is
  // display only, so it reads like a CV instead of a flat item dump.
  // Sub-grouped by title within each employer, not just by employer:
  // a promotion (two roles, one company) reads as two labeled blocks
  // instead of one undifferentiated list — this is exactly what was
  // missing before `title` existed as a field at all.
  const groups = React.useMemo(() => {
    const map = new Map<string, EvidenceItem[]>();
    for (const item of visible) {
      const key = item.employer ?? UNGROUPED;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return Array.from(map.entries()).map(([employer, employerItems]) => {
      const titleMap = new Map<string, EvidenceItem[]>();
      for (const item of employerItems) {
        const key = item.title ?? "";
        if (!titleMap.has(key)) titleMap.set(key, []);
        titleMap.get(key)!.push(item);
      }
      return [employer, Array.from(titleMap.entries())] as const;
    });
  }, [visible]);

  const embeddedCount = items.filter((item) => item.embedded).length;

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Dashboard</span>
        {studioTab !== "overview" && profile && (
          <span
            className={cn(
              "font-mono text-[10px] uppercase px-2 py-0.5",
              profile.confirmed ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn",
            )}
          >
            {profile.confirmed ? "confirmed" : "unconfirmed"}
          </span>
        )}
        {studioTab !== "overview" && (
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!profile}
              onClick={openUploadModal}
            >
              {parsing ? "Parsing…" : "Upload CV"}
            </Button>
            <Button
              size="sm"
              disabled={
                !profile ||
                parsing ||
                (!profile.confirmed && (!items.length || embeddedCount !== items.length))
              }
              onClick={handleConfirm}
            >
              {profile?.confirmed ? "Unconfirm" : "Confirm profile"}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={!profile}
              onClick={() => setResetOpen(true)}
            >
              Reset profile
            </Button>
          </div>
        )}
      </header>

      {/* Always visible now (used to gate on `profile && !loading` —
          Overview has no persona/profile dependency at all, so the tab
          bar itself can't wait on that the way the other three tabs'
          own content still does, below). */}
      <div className="shrink-0 border-b border-border bg-card px-5">
        <Tabs value={studioTab} onValueChange={(v) => setStudioTab(v as typeof studioTab)}>
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="preferences">Preferences</TabsTrigger>
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="evidence">Experience ({items.length})</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* No padding on the scroll container itself — a sticky child
          can only ever paint over the space its OWN box covers, and
          this container's padding would otherwise leave a permanent
          gutter (top/left/right) around the sticky bar where
          scrolled-under content is visible, peeking around it rather
          than being covered by it. The Experience section's sticky
          toolbar goes edge-to-edge instead (same pattern as the page's
          own <header>); everything else is wrapped in its own padded div. */}
      <div className="flex-1 overflow-auto flex flex-col isolate">
        {studioTab === "overview" ? (
          <div className="p-5">
            <OverviewPanel items={items} onUploadCv={openUploadModal} />
          </div>
        ) : loading ? (
          <div className="text-sm text-muted-foreground font-mono p-5">loading…</div>
        ) : !selectedPersona ? (
          <div className="text-sm text-muted-foreground border border-dashed border-input p-6 text-center m-5">
            No persona yet — every profile belongs to one. Create your first persona from the sidebar to get
            started.
          </div>
        ) : !profile ? (
          <div className="text-sm text-muted-foreground font-mono p-5">loading…</div>
        ) : studioTab === "preferences" ? (
          <div className="p-5">
            <PreferencesPanel />
          </div>
        ) : studioTab === "profile" ? (
          <section className="p-5 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                  Structured profile
                </span>
                <span className="text-xs text-muted-foreground">
                  Parsed fields are kept with revision {profile.revision} and stay behind the confirmation gate.
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {profile.parsed_at && (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    parsed {new Date(profile.parsed_at).toLocaleDateString()}
                  </span>
                )}
                <Button size="sm" variant="outline" onClick={openProfileEdit}>
                  Edit
                </Button>
              </div>
            </div>
            {!hasParsedProfile(profile) ? (
              <p className="text-sm text-muted-foreground">
                Upload a CV to populate the structured profile. Configure and verify the deep and embedding tiers in Models &amp; Providers first.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {[
                  ["Name", profile.parsed_profile.full_name],
                  ["Headline", profile.parsed_profile.headline],
                  ["Email", profile.parsed_profile.email],
                  ["Phone", profile.parsed_profile.phone],
                  ["Location", profile.parsed_profile.location],
                ].map(([label, value]) =>
                  value ? (
                    <div key={label} className="flex flex-col gap-1">
                      <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                        {label}
                      </span>
                      <span className="text-sm">{value}</span>
                    </div>
                  ) : null,
                )}
                {profile.parsed_profile.summary && (
                  <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-3">
                    <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                      Summary
                    </span>
                    <span className="text-sm leading-relaxed">{profile.parsed_profile.summary}</span>
                  </div>
                )}
                {!!profile.parsed_profile.skills?.length && (
                  <div className="flex flex-col gap-1 lg:col-span-4">
                    <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                      Skills
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {profile.parsed_profile.skills.map((skill) => (
                        <Badge key={skill} variant="secondary" className="text-[9px] font-mono">
                          {skill}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        ) : (
          <>
            {/* Sticky area covers what you need pinned while scrolling
                the evidence list below — the evidence-bank stats row
                AND the category tabs. Only the actual evidence item
                groups scroll underneath. Lighter now that the profile
                summary lives in its own tab instead of stacking on
                top of this. */}
            <div className="sticky top-0 z-20 border-b border-border bg-card shadow-md flex flex-col">
            <div className="px-5 py-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                <span className="font-mono text-[10px] tracking-wider uppercase">Evidence bank</span>
                <span>·</span>
                <span>{items.length} atomic records</span>
                <span>·</span>
                <span className={embeddedCount === items.length ? "text-ok" : "text-warn"}>
                  {embeddedCount}/{items.length} embedded
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-[10px] text-muted-foreground">
                  {profile.confirmed ? "verified for downstream use" : "review before confirming"}
                </span>
                <Button size="sm" variant="outline" onClick={() => setAddingEvidence(true)}>
                  Add evidence
                </Button>
              </div>
            </div>

            {items.length > 0 && (
              <div className="px-5 pb-2">
                <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
                  <TabsList>
                    <TabsTrigger value="all">All ({counts.all})</TabsTrigger>
                    {EVIDENCE_CATEGORIES.filter((cat) => counts[cat] > 0).map((cat) => (
                      <TabsTrigger key={cat} value={cat}>
                        {CATEGORY_LABEL[cat]} ({counts[cat]})
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </div>
            )}
            </div>

            <div className="p-5 pt-4 flex flex-col gap-4">
            {items.length === 0 ? (
              <div className="text-sm text-muted-foreground border border-dashed border-input p-6 text-center">
                No evidence yet. Upload a CV (.pdf or .docx) — it&apos;s parsed into atomic,
                individually-citable accomplishment records, each one a future CV bullet
                has to trace back to.
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-4">
                  {groups.map(([employer, titleGroups]) => {
                    const allItems = titleGroups.flatMap(([, groupItems]) => groupItems);
                    const range = groupDateRange(allItems);
                    return (
                      <div key={employer} className="border border-border bg-card">
                        {employer !== UNGROUPED && (
                          <div className="h-9 border-b border-border bg-secondary flex items-center gap-2 px-3">
                            <span className="text-sm font-medium">{employer}</span>
                            {range && (
                              <span className="font-mono text-[11px] text-muted-foreground tabular">
                                {range}
                              </span>
                            )}
                            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                              {allItems.length} item{allItems.length === 1 ? "" : "s"}
                            </span>
                          </div>
                        )}
                        {titleGroups.map(([title, groupItems]) => (
                          <div key={title || "__no_title__"}>
                            {title && (
                              <div className="h-7 flex items-center px-3 border-b border-border bg-muted/40">
                                <span className="text-xs font-medium text-muted-foreground">{title}</span>
                              </div>
                            )}
                            <div className="flex flex-col">
                              {groupItems.map((item) => {
                                const itemRange = formatDateRange(item);
                                return (
                                  <div
                                    key={item.id}
                                    className="flex items-start gap-3 px-3 py-2.5 border-b border-border last:border-b-0"
                                  >
                                    <span className="text-muted-foreground text-sm leading-6">–</span>
                                    <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        {/* title already shown as a subheader when grouped by employer,
                                            but the ungrouped ("other"/no-employer) case has none — show it
                                            inline there so a title never silently disappears. */}
                                        {employer === UNGROUPED && item.title && (
                                          <span className="text-xs font-medium">{item.title}</span>
                                        )}
                                        <Badge
                                          variant="secondary"
                                          className={cn("text-[9px] font-mono", CATEGORY_COLOR_CLASS[item.category])}
                                        >
                                          {item.category}
                                        </Badge>
                                        <Badge
                                          variant="secondary"
                                          className={cn(
                                            "text-[9px] font-mono",
                                            item.embedded ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn",
                                          )}
                                        >
                                          {item.embedded ? "embedded" : "needs embedding"}
                                        </Badge>
                                        {employer === UNGROUPED && itemRange && (
                                          <span className="font-mono text-[10px] text-muted-foreground tabular">
                                            {itemRange}
                                          </span>
                                        )}
                                      </div>
                                      <p className="text-sm leading-relaxed">{item.text}</p>
                                      {item.skills.length > 0 && (
                                        <div className="flex flex-wrap gap-1">
                                          {item.skills.map((s) => (
                                            <Badge
                                              key={s}
                                              variant="secondary"
                                              className="text-[9px] font-mono"
                                            >
                                              {s}
                                            </Badge>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                    <div className="flex gap-2 shrink-0">
                                      <Button size="sm" variant="outline" onClick={() => openEdit(item)}>
                                        Edit
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => handleDelete(item.id)}
                                      >
                                        Delete
                                      </Button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            </div>
          </>
        )}
      </div>

      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setDraft(null);
          }
        }}
      >
        <DialogContent className="flex max-h-[85vh] max-w-xl flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>Edit evidence</DialogTitle>
            <DialogDescription>
              Title, text and skills changes are re-embedded before saving and require confirmation again.
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="grid gap-4 overflow-y-auto py-2">
              <div className="grid gap-1.5">
                <Label htmlFor="evidence-category">Category</Label>
                <Select
                  value={draft.category}
                  onValueChange={(value) =>
                    setDraft((current) =>
                      current ? { ...current, category: value as EvidenceCategory } : current,
                    )
                  }
                >
                  <SelectTrigger id="evidence-category" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EVIDENCE_CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category}>
                        {CATEGORY_LABEL[category]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="evidence-title">Title (role / degree / certificate)</Label>
                <Input
                  id="evidence-title"
                  placeholder="e.g. Machine Learning Engineer Intern"
                  value={draft.title}
                  onChange={(event) =>
                    setDraft((current) => (current ? { ...current, title: event.target.value } : current))
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="evidence-text">Evidence text</Label>
                <textarea
                  id="evidence-text"
                  value={draft.text}
                  onChange={(event) =>
                    setDraft((current) => (current ? { ...current, text: event.target.value } : current))
                  }
                  className="min-h-24 w-full border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="evidence-skills">Skills (comma separated)</Label>
                <Input
                  id="evidence-skills"
                  value={draft.skills}
                  onChange={(event) =>
                    setDraft((current) => (current ? { ...current, skills: event.target.value } : current))
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="evidence-employer">Employer / project</Label>
                <Input
                  id="evidence-employer"
                  value={draft.employer}
                  onChange={(event) =>
                    setDraft((current) => (current ? { ...current, employer: event.target.value } : current))
                  }
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="evidence-start">Start date</Label>
                  <Input
                    id="evidence-start"
                    type="date"
                    value={draft.date_start}
                    onChange={(event) =>
                      setDraft((current) => (current ? { ...current, date_start: event.target.value } : current))
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="evidence-end">End date</Label>
                  <Input
                    id="evidence-end"
                    type="date"
                    value={draft.date_end}
                    onChange={(event) =>
                      setDraft((current) => (current ? { ...current, date_end: event.target.value } : current))
                    }
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="evidence-metrics">Metrics (JSON object)</Label>
                <textarea
                  id="evidence-metrics"
                  value={draft.metrics}
                  onChange={(event) =>
                    setDraft((current) => (current ? { ...current, metrics: event.target.value } : current))
                  }
                  className="min-h-20 w-full border border-input bg-transparent px-2.5 py-2 font-mono text-xs outline-none focus-visible:border-ring"
                />
              </div>
            </div>
          )}
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={savingEdit}>
              {savingEdit ? "Saving…" : "Save evidence"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={addingEvidence}
        onOpenChange={(open) => {
          setAddingEvidence(open);
          if (!open) setNewDraft(emptyEvidenceDraft());
        }}
      >
        <DialogContent className="flex max-h-[85vh] max-w-xl flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>Add evidence</DialogTitle>
            <DialogDescription>
              A manually-added accomplishment, embedded the same way a parsed one is — usable by scoring and
              tailoring right away, not just kept for display.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 overflow-y-auto py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="new-evidence-category">Category</Label>
              <Select
                value={newDraft.category}
                onValueChange={(value) =>
                  setNewDraft((current) => ({ ...current, category: value as EvidenceCategory }))
                }
              >
                <SelectTrigger id="new-evidence-category" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EVIDENCE_CATEGORIES.map((category) => (
                    <SelectItem key={category} value={category}>
                      {CATEGORY_LABEL[category]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-evidence-title">Title (role / degree / certificate)</Label>
              <Input
                id="new-evidence-title"
                placeholder="e.g. Machine Learning Engineer Intern"
                value={newDraft.title}
                onChange={(event) => setNewDraft((current) => ({ ...current, title: event.target.value }))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-evidence-text">Evidence text</Label>
              <textarea
                id="new-evidence-text"
                placeholder="One clear, standalone sentence describing a single accomplishment."
                value={newDraft.text}
                onChange={(event) => setNewDraft((current) => ({ ...current, text: event.target.value }))}
                className="min-h-24 w-full border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-evidence-skills">Skills (comma separated)</Label>
              <Input
                id="new-evidence-skills"
                value={newDraft.skills}
                onChange={(event) => setNewDraft((current) => ({ ...current, skills: event.target.value }))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-evidence-employer">Employer / project</Label>
              <Input
                id="new-evidence-employer"
                value={newDraft.employer}
                onChange={(event) => setNewDraft((current) => ({ ...current, employer: event.target.value }))}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="new-evidence-start">Start date</Label>
                <Input
                  id="new-evidence-start"
                  type="date"
                  value={newDraft.date_start}
                  onChange={(event) => setNewDraft((current) => ({ ...current, date_start: event.target.value }))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="new-evidence-end">End date</Label>
                <Input
                  id="new-evidence-end"
                  type="date"
                  value={newDraft.date_end}
                  onChange={(event) => setNewDraft((current) => ({ ...current, date_end: event.target.value }))}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-evidence-metrics">Metrics (JSON object)</Label>
              <textarea
                id="new-evidence-metrics"
                value={newDraft.metrics}
                onChange={(event) => setNewDraft((current) => ({ ...current, metrics: event.target.value }))}
                className="min-h-20 w-full border border-input bg-transparent px-2.5 py-2 font-mono text-xs outline-none focus-visible:border-ring"
              />
            </div>
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setAddingEvidence(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateEvidence} disabled={savingNew || !newDraft.text.trim()}>
              {savingNew ? "Adding…" : "Add evidence"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editingProfile}
        onOpenChange={(open) => {
          if (!open) {
            setEditingProfile(false);
            setProfileDraft(null);
          }
        }}
      >
        <DialogContent className="flex max-h-[85vh] max-w-xl flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>Edit profile</DialogTitle>
            <DialogDescription>
              Changes reset confirmation — review evidence again before re-confirming.
            </DialogDescription>
          </DialogHeader>
          {profileDraft && (
            <div className="grid gap-4 overflow-y-auto py-2">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="profile-name">Full name</Label>
                  <Input
                    id="profile-name"
                    value={profileDraft.full_name}
                    onChange={(e) =>
                      setProfileDraft((d) => (d ? { ...d, full_name: e.target.value } : d))
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="profile-headline">Headline</Label>
                  <Input
                    id="profile-headline"
                    value={profileDraft.headline}
                    onChange={(e) =>
                      setProfileDraft((d) => (d ? { ...d, headline: e.target.value } : d))
                    }
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="profile-email">Email</Label>
                  <Input
                    id="profile-email"
                    type="email"
                    value={profileDraft.email}
                    onChange={(e) => setProfileDraft((d) => (d ? { ...d, email: e.target.value } : d))}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="profile-phone">Phone</Label>
                  <Input
                    id="profile-phone"
                    value={profileDraft.phone}
                    onChange={(e) => setProfileDraft((d) => (d ? { ...d, phone: e.target.value } : d))}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="profile-location">Location</Label>
                <Input
                  id="profile-location"
                  value={profileDraft.location}
                  onChange={(e) => setProfileDraft((d) => (d ? { ...d, location: e.target.value } : d))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="profile-links">Links (comma separated)</Label>
                <Input
                  id="profile-links"
                  value={profileDraft.links}
                  onChange={(e) => setProfileDraft((d) => (d ? { ...d, links: e.target.value } : d))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="profile-summary">Summary</Label>
                <textarea
                  id="profile-summary"
                  value={profileDraft.summary}
                  onChange={(e) => setProfileDraft((d) => (d ? { ...d, summary: e.target.value } : d))}
                  className="min-h-24 w-full border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="profile-skills">Skills (comma separated)</Label>
                <Input
                  id="profile-skills"
                  value={profileDraft.skills}
                  onChange={(e) => setProfileDraft((d) => (d ? { ...d, skills: e.target.value } : d))}
                />
              </div>
            </div>
          )}
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setEditingProfile(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveProfile} disabled={savingProfile}>
              {savingProfile ? "Saving…" : "Save profile"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={resetOpen}
        onOpenChange={(open) => {
          setResetOpen(open);
          if (!open) setResetConfirmText("");
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reset profile</DialogTitle>
            <DialogDescription>
              Permanently deletes every evidence item, persona, document, and downstream
              score or application tied to this profile, then replaces it with a blank
              shell. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5 py-2">
            <Label htmlFor="reset-confirm">
              Type <span className="font-mono">RESET</span> to confirm
            </Label>
            <Input
              id="reset-confirm"
              value={resetConfirmText}
              onChange={(e) => setResetConfirmText(e.target.value)}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={resetConfirmText !== "RESET" || resetting}
              onClick={handleReset}
            >
              {resetting ? "Resetting…" : "Delete everything"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Upload CV</DialogTitle>
            <DialogDescription>
              {parsing
                ? "Runs in the background — closing this is fine, it keeps going."
                : "PDF or DOCX. Parsed into atomic, individually-citable evidence."}
            </DialogDescription>
          </DialogHeader>

          {parsing ? (
            <div className="flex flex-col gap-3 py-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <FileText className="size-3.5" />
                <span className="truncate">{pendingFile?.name}</span>
              </div>
              <div className="flex flex-col gap-0.5 border border-border">
                {CV_PARSE_STAGES.map((stage, i) => {
                  const isDone = completedStages.has(stage);
                  const isActive = activeStage === stage && !isDone;
                  return (
                    <div
                      key={stage}
                      className={cn(
                        "flex items-center gap-2.5 px-3 py-2",
                        i < CV_PARSE_STAGES.length - 1 && "border-b border-border",
                        isActive && "bg-accent",
                      )}
                    >
                      {isDone ? (
                        <Check className="size-3.5 text-ok shrink-0" />
                      ) : isActive ? (
                        <Loader2 className="size-3.5 animate-spin text-primary shrink-0" />
                      ) : (
                        <Circle className="size-3.5 text-muted-foreground shrink-0" />
                      )}
                      <span
                        className={cn(
                          "text-sm",
                          isDone ? "text-muted-foreground" : isActive ? "font-medium" : "text-muted-foreground",
                        )}
                      >
                        {STAGE_LABEL[stage]}
                      </span>
                      {isActive && (
                        <span className="ml-auto font-mono text-[10px] text-muted-foreground">running…</span>
                      )}
                    </div>
                  );
                })}
              </div>
              {activeStage === "parsing" && (
                <p className="text-xs text-muted-foreground">
                  This step calls the AI model and is the slow one — usually the longest wait in the whole flow.
                </p>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setUploadOpen(false)}>
                  Close — keep running in background
                </Button>
              </DialogFooter>
            </div>
          ) : pendingFile ? (
            <div className="flex flex-col gap-3 py-2">
              <div className="flex items-center gap-2 border border-border px-3 py-2.5">
                <FileText className="size-4 text-muted-foreground shrink-0" />
                <span className="text-sm truncate">{pendingFile.name}</span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {(pendingFile.size / 1024).toFixed(0)} KB
                </span>
              </div>
              {parseError && (
                <div className="border border-crit bg-crit-bg px-3 py-2 text-xs text-crit">{parseError}</div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setPendingFile(null)}>
                  Choose different file
                </Button>
                <Button onClick={runParse}>{parseError ? "Try again" : "Parse CV"}</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="flex flex-col gap-3 py-2">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => modalFileInputRef.current?.click()}
                className={cn(
                  "flex flex-col items-center gap-2 border border-dashed px-6 py-10 text-center cursor-pointer transition-colors",
                  dragOver ? "border-primary bg-accent" : "border-input hover:bg-secondary",
                )}
              >
                <UploadCloud className="size-6 text-muted-foreground" />
                <span className="text-sm">Drop a file here, or click to browse</span>
                <span className="text-xs text-muted-foreground">.pdf or .docx</span>
              </div>
              <input
                ref={modalFileInputRef}
                type="file"
                accept=".pdf,.docx"
                className="hidden"
                onChange={handleModalFileInput}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
