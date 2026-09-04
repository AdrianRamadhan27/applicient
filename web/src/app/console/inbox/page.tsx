"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  api,
  type Application,
  type InboxJob,
  type InboxJobDetail,
  type JobGroup,
  type Recommendation,
  type Source,
} from "@/lib/api";
import { usePersona } from "@/components/persona-provider";
import { AddJobDialog } from "@/components/add-job-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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
import { platformForSourceName } from "@/lib/platforms";
import { PlatformLogo } from "@/components/platform-logo";
import { RECOMMENDATION_LABEL, recommendationColor } from "@/lib/recommendation";
import { Layers, Plus, Search, Send, Trash2, X } from "lucide-react";

// Skills come straight from the model's own free-form output, not a
// controlled vocabulary — sometimes that's a real short skill name,
// sometimes it's a whole clause like "Linux/Windows environment (not
// stated above, but candidate has cloud experience with GCP/AWS –
// partial, not exact)". Badge's own base classes force `whitespace-nowrap`
// and a fixed `h-5`, both correct for every OTHER badge in this app
// (short, known-length tags) but wrong here — overridden per-instance
// rather than changed on the shared component, since changing Badge
// itself would affect every short tag elsewhere that's fine as-is.
const SKILL_BADGE_CLASS = "text-[9px] font-mono whitespace-normal h-auto max-w-full break-words text-left leading-snug py-1";

const RECOMMENDATIONS: (Recommendation | "unscored")[] = ["strong_apply", "apply", "stretch", "skip", "unscored"];

function money(v: number) {
  if (v === 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(2)}`;
}

function salaryLabel(job: Pick<InboxJob, "salary_min" | "salary_max" | "salary_currency">) {
  if (job.salary_min === null && job.salary_max === null) return "not stated";
  const currency = job.salary_currency ?? "";
  if (job.salary_min !== null && job.salary_max !== null && job.salary_min !== job.salary_max) {
    return `${currency} ${job.salary_min.toLocaleString()}–${job.salary_max.toLocaleString()}`;
  }
  const one = job.salary_min ?? job.salary_max;
  return `${currency} ${one!.toLocaleString()}`;
}

function relativeDays(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

function DimensionRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center justify-between text-xs border-b border-border last:border-b-0 py-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value ?? "—"}</span>
    </div>
  );
}

function JobDetailDrawer({
  jobId,
  personaId,
  onClose,
  onScored,
}: {
  jobId: string;
  personaId: string;
  onClose: () => void;
  onScored: () => void;
}) {
  const router = useRouter();
  const [detail, setDetail] = React.useState<InboxJobDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [jobGroups, setJobGroups] = React.useState<JobGroup[]>([]);
  const [newGroupName, setNewGroupName] = React.useState("");
  const [addingToGroup, setAddingToGroup] = React.useState(false);
  const [startingApplication, setStartingApplication] = React.useState(false);
  const [scoring, setScoring] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [d, groups] = await Promise.all([
          api.getInboxJob(jobId, personaId),
          api.listJobGroups(personaId),
        ]);
        if (!cancelled) {
          setDetail(d);
          setJobGroups(groups);
        }
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, personaId]);

  async function handleAddToGroup(groupId: string) {
    setAddingToGroup(true);
    try {
      const updated = await api.addJobGroupMember(groupId, jobId);
      setJobGroups((prev) => prev.map((g) => (g.id === updated.id ? updated : g)));
      toast.success(`Added to "${updated.name}" — tailor it from the Composer`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setAddingToGroup(false);
    }
  }

  async function handleStartApplication() {
    setStartingApplication(true);
    try {
      // create_application is idempotent server-side (returns the
      // existing row if this job already has one), so this is safe to
      // click again on a job you've already added — it just reopens it.
      const application: Application = await api.createApplication({ job_id: jobId, persona_id: personaId });
      setDetail((prev) => (prev ? { ...prev, in_pipeline: true } : prev));
      router.push(`/console/pipeline?application_id=${application.id}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setStartingApplication(false);
    }
  }

  async function handleScoreJob() {
    setScoring(true);
    try {
      const wasAlreadyInPipeline = detail?.in_pipeline ?? false;
      const scored = await api.scoreJob(jobId, personaId);
      setDetail((prev) =>
        prev ? { ...prev, fit_score: scored.fit_score, prefilter: scored.prefilter, in_pipeline: scored.in_pipeline } : prev,
      );
      onScored();
      toast.success(
        scored.fit_score
          ? scored.in_pipeline && !wasAlreadyInPipeline
            ? `Scored: ${scored.fit_score.recommendation} — auto-added to your pipeline`
            : `Scored: ${scored.fit_score.recommendation}`
          : "Scored — prefilter dropped it, see below",
      );
    } catch (e) {
      toast.error(String(e));
    } finally {
      setScoring(false);
    }
  }

  async function handleCreateGroupAndAdd() {
    if (!newGroupName.trim()) return;
    setAddingToGroup(true);
    try {
      const group = await api.createJobGroup(personaId, { name: newGroupName.trim(), job_ids: [jobId] });
      setJobGroups((prev) => [...prev, group]);
      setNewGroupName("");
      toast.success(`Created "${group.name}" and added this job`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setAddingToGroup(false);
    }
  }

  const fs = detail?.fit_score ?? null;
  const groupsWithThisJob = jobGroups.filter((g) => g.job_ids.includes(jobId));
  const groupsWithoutThisJob = jobGroups.filter((g) => !g.job_ids.includes(jobId));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      {/* `w-fit` (shrink-to-fit) doesn't work here: browsers size a
          shrink-to-fit box from children's max-content width, which
          IGNORES text-overflow/truncate — a truncated element still
          contributes its full untruncated width to that calculation,
          so a long URL/skill string blew the dialog past the viewport
          with truncation never actually engaging. A bounded `w-full`
          (fills up to max-w, never exceeds it) is what lets
          truncation/wrapping work inside a fixed width instead. */}
      <DialogContent className="flex w-full max-w-[min(95vw,80rem)] max-h-[85vh] flex-col overflow-hidden">
        {loading || !detail ? (
          <div className="text-sm text-muted-foreground font-mono py-8 text-center">loading…</div>
        ) : (
          <>
            {/* A real sibling of the scrolling body below, not a
                `sticky` element inside it — a genuinely non-scrolling
                header is simpler and more robust than fighting
                sticky-inside-a-grid-container edge cases, and it's what
                actually keeps the close button (X) reliably on top:
                that button is positioned relative to DialogContent
                itself, so as long as it isn't nested inside the part
                that scrolls, it never needs z-index games either. */}
            <DialogHeader className="shrink-0 border-b border-border pb-3">
              <DialogTitle>{detail.title}</DialogTitle>
              <DialogDescription>
                {detail.company_name_raw}
                {detail.location ? ` · ${detail.location}` : ""}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto py-2">
              {fs ? (
                <>
                  <div className="flex items-center gap-3">
                    <Badge className={cn("text-[10px] font-mono", recommendationColor(fs.recommendation))}>
                      {RECOMMENDATION_LABEL[fs.recommendation]}
                    </Badge>
                    <span className="font-mono text-2xl font-semibold tabular">{fs.overall_score}</span>
                    <span className="text-xs text-muted-foreground">/ 100 · higher is a better fit</span>
                  </div>

                  {fs.hard_blocker && (
                    <div className="border border-crit bg-crit-bg px-3 py-2 text-xs text-crit">
                      Hard blocker: {fs.hard_blocker}
                    </div>
                  )}

                  <div className="border border-border">
                    <DimensionRow
                      label="Hard requirements"
                      value={`${fs.hard_requirements_met}/${fs.hard_requirements_total}`}
                    />
                    <DimensionRow
                      label="Experience delta"
                      value={fs.experience_delta_years === null ? null : `${fs.experience_delta_years > 0 ? "+" : ""}${fs.experience_delta_years} yrs`}
                    />
                    <DimensionRow label="Seniority fit" value={fs.seniority_fit} />
                    <DimensionRow label="Domain fit" value={fs.domain_fit} />
                    <DimensionRow label="Location fit" value={fs.location_fit} />
                    <DimensionRow label="Salary overlap" value={fs.salary_overlap} />
                    <DimensionRow label="Company stage fit" value={fs.company_stage_fit} />
                    <DimensionRow label="Language fit" value={fs.language_fit} />
                  </div>

                  {(fs.skills_matched.length > 0 || fs.skills_partial.length > 0 || fs.skills_missing.length > 0) && (
                    <div className="flex flex-col gap-1.5">
                      <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                        Skills
                      </span>
                      {fs.skills_matched.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {fs.skills_matched.map((s) => (
                            <Badge
                              key={s}
                              className={cn(SKILL_BADGE_CLASS, "bg-ok-bg text-ok")}
                            >
                              {s}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {fs.skills_partial.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {fs.skills_partial.map((s) => (
                            <Badge
                              key={s}
                              className={cn(SKILL_BADGE_CLASS, "bg-warn-bg text-warn")}
                            >
                              {s}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {fs.skills_missing.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {fs.skills_missing.map((s) => (
                            <Badge
                              key={s}
                              variant="secondary"
                              className={cn(SKILL_BADGE_CLASS, "text-muted-foreground")}
                            >
                              {s}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {fs.evidence_spans.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                        Evidence (quoted from the job posting)
                      </span>
                      <div className="flex flex-col gap-1.5">
                        {fs.evidence_spans.map((span, i) => (
                          <div key={i} className="border border-border px-2 py-1.5 text-xs break-words">
                            <div className="italic text-muted-foreground">&ldquo;{span.quote}&rdquo;</div>
                            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground break-words">{span.supports}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {fs.gap_closers && (
                    <div className="flex flex-col gap-1">
                      <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                        What would close the gap
                      </span>
                      <span className="text-xs">{fs.gap_closers}</span>
                    </div>
                  )}

                  {fs.red_flags.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <span className="font-mono text-[10px] tracking-wider uppercase text-warn">Red flags</span>
                      {fs.red_flags.map((r, i) => (
                        <span key={i} className="text-xs text-warn">
                          {r}
                        </span>
                      ))}
                    </div>
                  )}

                  {detail.ghost_job_reasons.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <span className="font-mono text-[10px] tracking-wider uppercase text-warn">
                        Ghost-job signal ({detail.ghost_job_score})
                      </span>
                      {detail.ghost_job_reasons.map((r, i) => (
                        <span key={i} className="text-xs text-warn">
                          {r}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center justify-between border-t border-border pt-2 text-[10px] font-mono text-muted-foreground">
                    <span>
                      scoring v{fs.scoring_version} · {fs.model_used ?? "unknown model"}
                    </span>
                    <span>{money(fs.cost_usd)}</span>
                  </div>
                </>
              ) : detail.prefilter ? (
                <div className="border border-border px-3 py-2 flex flex-col gap-1">
                  <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                    Prefilter only — {detail.prefilter.decision}
                  </span>
                  <span className="text-xs">{detail.prefilter.reason}</span>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Not scored yet for this persona.</span>
                  <Button size="sm" variant="outline" disabled={scoring} onClick={handleScoreJob}>
                    {scoring ? "Scoring…" : "Score this job"}
                  </Button>
                </div>
              )}

              <div className="flex flex-col gap-1.5 border-t border-border pt-3">
                <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                  Source lineage
                </span>
                {detail.sightings.map((s) => (
                  <a
                    key={s.id}
                    href={s.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs hover:underline flex items-center gap-2"
                  >
                    <Badge variant="secondary" className="text-[9px] font-mono shrink-0">
                      {s.source_name}
                    </Badge>
                    <span className="text-muted-foreground truncate flex-1 min-w-0">{s.source_url}</span>
                  </a>
                ))}
              </div>

              <div className="flex items-center gap-2">
                {detail.apply_url && (
                  <Button asChild size="sm" variant="outline">
                    <a href={detail.apply_url} target="_blank" rel="noopener noreferrer">
                      Open apply page ↗
                    </a>
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={detail.in_pipeline ? "outline" : "default"}
                  onClick={handleStartApplication}
                  disabled={startingApplication}
                  title={
                    detail.in_pipeline
                      ? "Already in your pipeline — open it on the Pipeline board"
                      : "Creates a tracked Application and opens it on the Pipeline board, where you can run the application-agent or mark it applied manually"
                  }
                >
                  {startingApplication ? "Adding…" : detail.in_pipeline ? "✓ In pipeline" : "Add to Pipeline"}
                </Button>
              </div>

              <div className="border-t border-border pt-3 space-y-1.5">
                <span className="text-xs font-semibold text-muted-foreground uppercase">
                  Job groups (Composer tailoring)
                </span>
                {groupsWithThisJob.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {groupsWithThisJob.map((g) => (
                      <Badge key={g.id} variant="secondary">
                        {g.name}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  {groupsWithoutThisJob.length > 0 && (
                    <Select onValueChange={handleAddToGroup} value="" disabled={addingToGroup}>
                      <SelectTrigger className="w-56 h-8 text-xs">
                        <SelectValue placeholder="+ add to an existing group" />
                      </SelectTrigger>
                      <SelectContent>
                        {groupsWithoutThisJob.map((g) => (
                          <SelectItem key={g.id} value={g.id}>
                            {g.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Input
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    placeholder="or new group name…"
                    className="h-8 text-xs w-44"
                    onKeyDown={(e) => e.key === "Enter" && handleCreateGroupAndAdd()}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleCreateGroupAndAdd}
                    disabled={addingToGroup || !newGroupName.trim()}
                  >
                    Create &amp; add
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function InboxPage() {
  // Persona selection is app-wide now (AppShell's sidebar switcher) —
  // used directly, not mirrored into a second local override. An
  // earlier version seeded a separate local selector from this once
  // and let it drift independently after that; Adrian correctly
  // pointed out that meant the sidebar switcher looked broken from
  // here (it had no further effect once this page's own copy diverged).
  const { personas, selectedPersonaId } = usePersona();
  const router = useRouter();
  const personaId = selectedPersonaId;
  const [sources, setSources] = React.useState<Source[]>([]);
  const [jobs, setJobs] = React.useState<InboxJob[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingList, setLoadingList] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null);
  // General-purpose multi-select, not delete-specific — the same set
  // is meant to back later bulk actions (bulk apply, etc.), raised
  // directly by Adrian with that in mind, so this isn't named or
  // shaped around delete alone.
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [deleting, setDeleting] = React.useState(false);
  const [addJobOpen, setAddJobOpen] = React.useState(false);
  const [addingToPipeline, setAddingToPipeline] = React.useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = React.useState(false);
  const [jobGroupsForBulk, setJobGroupsForBulk] = React.useState<JobGroup[]>([]);
  const [bulkTargetGroupId, setBulkTargetGroupId] = React.useState("");
  const [bulkNewGroupName, setBulkNewGroupName] = React.useState("");
  const [addingToGroupBulk, setAddingToGroupBulk] = React.useState(false);

  const [recFilter, setRecFilter] = React.useState<Set<Recommendation | "unscored">>(new Set());
  const [sourceFilter, setSourceFilter] = React.useState<string>("");
  const [searchInput, setSearchInput] = React.useState("");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [locationInput, setLocationInput] = React.useState("");
  const [locationFilter, setLocationFilter] = React.useState("");
  const [minScore, setMinScore] = React.useState("");
  const [maxScore, setMaxScore] = React.useState("");
  const [sortBy, setSortBy] = React.useState<"recommended" | "newest_posted" | "newest_scanned" | "oldest_scanned">(
    "recommended",
  );

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.listSources();
        if (cancelled) return;
        setSources(s);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadJobs = React.useCallback(async () => {
    if (!personaId) return;
    setLoadingList(true);
    setError(null);
    try {
      const result = await api.listInboxJobs(personaId, {
        recommendation: recFilter.size > 0 ? Array.from(recFilter) : undefined,
        sourceId: sourceFilter || undefined,
        search: searchQuery || undefined,
        location: locationFilter || undefined,
        minScore: minScore ? Number(minScore) : undefined,
        maxScore: maxScore ? Number(maxScore) : undefined,
        sort: sortBy,
        limit: 200,
      });
      setJobs(result);
      // A fresh filtered list may no longer contain some (or any) of
      // the previously selected jobs — clearing avoids "select all"
      // silently carrying over stale ids from a different filter.
      setSelectedIds(new Set());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingList(false);
    }
  }, [personaId, recFilter, sourceFilter, searchQuery, locationFilter, minScore, maxScore, sortBy]);

  React.useEffect(() => {
    (async () => {
      await loadJobs();
    })();
  }, [loadJobs]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const jobId = new URLSearchParams(window.location.search).get("job_id");
      if (jobId && !cancelled) setSelectedJobId(jobId);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function openJobDetail(jobId: string) {
    setSelectedJobId(jobId);
    router.replace(`/console/inbox?job_id=${encodeURIComponent(jobId)}`, { scroll: false });
  }

  function closeJobDetail() {
    setSelectedJobId(null);
    router.replace("/console/inbox", { scroll: false });
  }

  function submitSearch() {
    setSearchQuery(searchInput.trim());
  }

  function toggleRec(rec: Recommendation | "unscored") {
    setRecFilter((prev) => {
      const next = new Set(prev);
      if (next.has(rec)) next.delete(rec);
      else next.add(rec);
      return next;
    });
  }

  function toggleSelected(jobId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  // "Select all" only ever means "all jobs currently matching the
  // active filters" — `jobs` already IS that filtered set (it's what
  // the API returned for the current filter params), so this never
  // needs to know about filters directly.
  function toggleSelectAll() {
    if (!jobs) return;
    setSelectedIds((prev) => (prev.size === jobs.length ? new Set() : new Set(jobs.map((j) => j.id))));
  }

  async function handleDeleteSelected() {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`Delete ${selectedIds.size} job${selectedIds.size === 1 ? "" : "s"}? This can't be undone.`)) {
      return;
    }
    setDeleting(true);
    try {
      const { deleted } = await api.bulkDeleteJobs(Array.from(selectedIds));
      setJobs((prev) => (prev ? prev.filter((j) => !selectedIds.has(j.id)) : prev));
      setSelectedIds(new Set());
      toast.success(`Deleted ${deleted} job${deleted === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDeleting(false);
    }
  }

  async function handleBulkAddToPipeline() {
    if (selectedIds.size === 0 || !personaId) return;
    setAddingToPipeline(true);
    // create_application is idempotent server-side (same as the
    // single-job path in JobDetailDrawer) — safe to loop over jobs
    // that already have an Application, it just leaves them as-is.
    // Individual failures are reported but don't stop the rest.
    let succeeded = 0;
    for (const jobId of selectedIds) {
      try {
        await api.createApplication({ job_id: jobId, persona_id: personaId });
        succeeded++;
      } catch (e) {
        toast.error(String(e));
      }
    }
    setAddingToPipeline(false);
    setSelectedIds(new Set());
    if (succeeded > 0) toast.success(`Added ${succeeded} job${succeeded === 1 ? "" : "s"} to Pipeline`);
  }

  function openGroupDialog() {
    if (!personaId) return;
    setBulkTargetGroupId("");
    setBulkNewGroupName("");
    setGroupDialogOpen(true);
    (async () => {
      try {
        setJobGroupsForBulk(await api.listJobGroups(personaId));
      } catch (e) {
        toast.error(String(e));
      }
    })();
  }

  async function handleBulkAddToGroup() {
    if (!personaId || selectedIds.size === 0) return;
    setAddingToGroupBulk(true);
    try {
      if (bulkTargetGroupId) {
        let succeeded = 0;
        for (const jobId of selectedIds) {
          try {
            await api.addJobGroupMember(bulkTargetGroupId, jobId);
            succeeded++;
          } catch (e) {
            toast.error(String(e));
          }
        }
        if (succeeded > 0) toast.success(`Added ${succeeded} job${succeeded === 1 ? "" : "s"} to the group`);
      } else {
        if (!bulkNewGroupName.trim()) {
          toast.error("Enter a name for the new group");
          return;
        }
        const group = await api.createJobGroup(personaId, {
          name: bulkNewGroupName.trim(),
          job_ids: Array.from(selectedIds),
        });
        toast.success(`Created "${group.name}" with ${selectedIds.size} job${selectedIds.size === 1 ? "" : "s"}`);
      }
      setSelectedIds(new Set());
      setGroupDialogOpen(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setAddingToGroupBulk(false);
    }
  }

  async function handleDeleteOne(jobId: string) {
    try {
      await api.bulkDeleteJobs([jobId]);
      setJobs((prev) => (prev ? prev.filter((j) => j.id !== jobId) : prev));
      setSelectedIds((prev) => {
        if (!prev.has(jobId)) return prev;
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    } catch (e) {
      toast.error(String(e));
    }
  }

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Job Inbox</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          ranked by fit — real API data only, no sample jobs
        </span>
        <div className="ml-auto flex items-center gap-3">
          <Button size="sm" className="gap-1.5" onClick={() => setAddJobOpen(true)}>
            <Plus className="size-3.5" />
            Add job
          </Button>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Persona:</span>
            <span className="font-medium text-foreground">
              {personas.find((p) => p.id === personaId)?.name ?? "?"}
            </span>
            <span>— switch from the sidebar</span>
          </div>
        </div>
      </header>

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground font-mono">
          loading…
        </div>
      ) : personas.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground border border-dashed border-input m-5 text-center p-6">
          No personas yet — set one up from Radar first.
        </div>
      ) : (
        // No padding on the scroll container itself — see profile/page.tsx's
        // identical comment for why a padded scroll container leaves a
        // gutter around a sticky child that scrolled content can peek
        // through instead of being covered by it. The sticky filter bar
        // goes edge-to-edge instead and re-applies p-5's horizontal
        // rhythm internally; the job list gets its own padded wrapper.
        <div className="flex-1 overflow-auto flex flex-col isolate">
          <div className="sticky top-0 z-20 border-b border-border bg-card px-5 py-3 flex flex-col gap-3 shadow-md">
            <div className="flex flex-wrap items-center gap-3">
              {/* Hidden until at least one row's own checkbox is
                  checked — a per-row checkbox is the discoverable way
                  to start selecting; this bar (select-all + bulk
                  actions) is only useful once selection mode is
                  already on, so it stays out of the way otherwise
                  (raised directly by Adrian). */}
              {selectedIds.size > 0 && (
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={!!jobs && jobs.length > 0 && selectedIds.size === jobs.length}
                    onCheckedChange={toggleSelectAll}
                    disabled={!jobs || jobs.length === 0}
                    aria-label="Select all filtered jobs"
                  />
                  <span className="text-[11px] text-muted-foreground">{selectedIds.size} selected</span>
                </div>
              )}
              {selectedIds.size > 0 && (
                <>
                  <Button
                    size="sm"
                    disabled={addingToPipeline}
                    onClick={handleBulkAddToPipeline}
                    className="h-7 text-xs gap-1.5"
                  >
                    <Send className="size-3.5" />
                    {addingToPipeline ? "Adding…" : `Add ${selectedIds.size} to Pipeline`}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={openGroupDialog}
                    className="h-7 text-xs gap-1.5 border-ok text-ok hover:bg-ok-bg hover:text-ok"
                  >
                    <Layers className="size-3.5" />
                    Add {selectedIds.size} to job group
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={deleting}
                    onClick={handleDeleteSelected}
                    className="h-7 text-xs gap-1.5"
                  >
                    <Trash2 className="size-3.5" />
                    {deleting ? "Deleting…" : `Delete ${selectedIds.size}`}
                  </Button>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground mr-1">
                Recommendation
              </span>
              {RECOMMENDATIONS.map((r) => (
                <Badge
                  key={r}
                  onClick={() => toggleRec(r)}
                  className={cn(
                    "text-[10px] font-mono cursor-pointer select-none",
                    recFilter.has(r) ? recommendationColor(r) : "bg-muted text-muted-foreground opacity-60",
                  )}
                >
                  {RECOMMENDATION_LABEL[r]}
                </Badge>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] text-muted-foreground">Search jobs</Label>
                <div className="flex items-center gap-1">
                  <Input
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submitSearch()}
                    placeholder="Title or company"
                    className="h-8 w-44 text-xs"
                    aria-label="Search jobs by title or company"
                  />
                  <Button type="button" size="sm" onClick={submitSearch} className="h-8 gap-1 px-2.5">
                    <Search className="size-3.5" />
                    Search
                  </Button>
                  {searchQuery && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setSearchInput("");
                        setSearchQuery("");
                      }}
                      className="h-8 px-2"
                      aria-label="Clear job search"
                    >
                      <X className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] text-muted-foreground">Source</Label>
                <Select value={sourceFilter || "any"} onValueChange={(v) => setSourceFilter(v === "any" ? "" : v)}>
                  <SelectTrigger className="w-40 h-8 text-xs">
                    <SelectValue placeholder="Any source" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any source</SelectItem>
                    {sources.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] text-muted-foreground">Sort</Label>
                <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                  <SelectTrigger className="w-40 h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="recommended">Recommended</SelectItem>
                    <SelectItem value="newest_posted">Newest posted</SelectItem>
                    <SelectItem value="newest_scanned">Newest scanned</SelectItem>
                    <SelectItem value="oldest_scanned">Oldest scanned</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] text-muted-foreground">Location</Label>
                <Input
                  value={locationInput}
                  onChange={(e) => setLocationInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && setLocationFilter(locationInput.trim())}
                  onBlur={() => setLocationFilter(locationInput.trim())}
                  placeholder="e.g. Jakarta"
                  className="h-8 w-40 text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] text-muted-foreground">Min score</Label>
                <Input
                  value={minScore}
                  onChange={(e) => setMinScore(e.target.value)}
                  type="number"
                  min={0}
                  max={100}
                  className="h-8 w-20 text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] text-muted-foreground">Max score</Label>
                <Input
                  value={maxScore}
                  onChange={(e) => setMaxScore(e.target.value)}
                  type="number"
                  min={0}
                  max={100}
                  className="h-8 w-20 text-xs"
                />
              </div>
            </div>
          </div>

          <div className="p-5 pt-4 flex flex-col gap-4">
          {error ? (
            <div className="text-sm text-crit font-mono">{error}</div>
          ) : loadingList || jobs === null ? (
            <div className="text-sm text-muted-foreground font-mono">loading…</div>
          ) : jobs.length === 0 ? (
            <div className="border border-dashed border-input p-6 text-center text-sm text-muted-foreground">
              No jobs match these filters.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {jobs.map((job) => (
                <div
                  key={job.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openJobDetail(job.id)}
                  onKeyDown={(e) => e.key === "Enter" && openJobDetail(job.id)}
                  className="text-left border border-border bg-card p-3 flex items-start gap-3 hover:border-primary transition-colors cursor-pointer"
                >
                  <Checkbox
                    checked={selectedIds.has(job.id)}
                    onCheckedChange={() => toggleSelected(job.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="mt-1 shrink-0"
                    aria-label={`Select ${job.title}`}
                  />
                  <Badge
                    className={cn(
                      "text-[10px] font-mono shrink-0 mt-0.5",
                      job.fit_score ? recommendationColor(job.fit_score.recommendation) : "bg-muted text-muted-foreground",
                    )}
                  >
                    {job.fit_score ? RECOMMENDATION_LABEL[job.fit_score.recommendation] : "unscored"}
                  </Badge>
                  {job.in_pipeline && (
                    <Badge
                      variant="outline"
                      className="text-[10px] font-mono shrink-0 mt-0.5"
                      title="Already in your Application Pipeline"
                    >
                      ✓ in pipeline
                    </Badge>
                  )}
                  <div className="flex-1 min-w-0 flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{job.title}</span>
                      <span className="text-xs text-muted-foreground shrink-0">{job.company_name_raw}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      {job.location && <span>{job.location}</span>}
                      {job.remote_policy && (
                        <Badge variant="secondary" className="text-[9px] font-mono">
                          {job.remote_policy}
                        </Badge>
                      )}
                      <span>{salaryLabel(job)}</span>
                      <span title={job.posted_at ? new Date(job.posted_at).toLocaleString() : "not stated by the source"}>
                        Posted {job.posted_at ? relativeDays(job.posted_at) : "unknown"}
                      </span>
                      <span title={new Date(job.discovered_at).toLocaleString()}>
                        · Scanned {relativeDays(job.discovered_at)}
                      </span>
                      {job.source_names.map((s) => {
                        // Same logo/color used in the "New saved
                        // search" source picker (raised directly by
                        // Adrian) — falls back to a plain text badge
                        // for a source name that doesn't map to one of
                        // the known platforms (a renamed source, or a
                        // legacy/custom one).
                        const platform = platformForSourceName(s);
                        return platform ? (
                          <span key={s} className="inline-flex items-center gap-1 text-[9px] font-mono">
                            <PlatformLogo mark={platform.mark} color={platform.color} size={14} />
                            {platform.label}
                          </span>
                        ) : (
                          <Badge key={s} variant="outline" className="text-[9px] font-mono">
                            {s}
                          </Badge>
                        );
                      })}
                      {job.ghost_job_reasons.length > 0 && (
                        <Badge className="text-[9px] font-mono bg-warn-bg text-warn">
                          ghost signal
                        </Badge>
                      )}
                    </div>
                    {job.fit_score?.hard_blocker && (
                      <span className="text-[11px] text-crit">{job.fit_score.hard_blocker}</span>
                    )}
                    {!job.fit_score && job.prefilter && (
                      <span className="text-[11px] text-muted-foreground">
                        prefilter: {job.prefilter.decision} — {job.prefilter.reason}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteOne(job.id);
                      }}
                      className="text-muted-foreground hover:text-crit transition-colors"
                      aria-label={`Delete ${job.title}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                    {job.fit_score && (
                      <span className="font-mono text-lg font-semibold tabular">{job.fit_score.overall_score}</span>
                    )}
                    {job.apply_url && (
                      <a
                        href={job.apply_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-[11px] text-primary hover:underline"
                      >
                        Apply ↗
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          </div>
        </div>
      )}

      {selectedJobId && personaId && (
        <JobDetailDrawer jobId={selectedJobId} personaId={personaId} onClose={closeJobDetail} onScored={loadJobs} />
      )}

      <AddJobDialog
        open={addJobOpen}
        onOpenChange={setAddJobOpen}
        onCreated={(job) => {
          loadJobs();
          setSelectedJobId(job.id);
        }}
      />

      <Dialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Add {selectedIds.size} job{selectedIds.size === 1 ? "" : "s"} to a job group
            </DialogTitle>
            <DialogDescription>
              Job groups are what Composer tailors one CV against — pick an existing one or create a new one.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {jobGroupsForBulk.length > 0 && (
              <div className="space-y-1.5">
                <Label>Existing group</Label>
                <Select
                  value={bulkTargetGroupId}
                  onValueChange={(v) => {
                    setBulkTargetGroupId(v);
                    setBulkNewGroupName("");
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a group" />
                  </SelectTrigger>
                  <SelectContent>
                    {jobGroupsForBulk.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name} ({g.job_ids.length} job{g.job_ids.length === 1 ? "" : "s"})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>{jobGroupsForBulk.length > 0 ? "Or create a new group" : "New group name"}</Label>
              <Input
                value={bulkNewGroupName}
                onChange={(e) => {
                  setBulkNewGroupName(e.target.value);
                  setBulkTargetGroupId("");
                }}
                placeholder="e.g. Backend roles"
                onKeyDown={(e) => e.key === "Enter" && handleBulkAddToGroup()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={handleBulkAddToGroup}
              disabled={addingToGroupBulk || (!bulkTargetGroupId && !bulkNewGroupName.trim())}
            >
              {addingToGroupBulk ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
