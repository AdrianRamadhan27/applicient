"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  api,
  type Application,
  type InboxJob,
  type InboxJobDetail,
  type JobDraft,
  type JobGroup,
  type Recommendation,
  type Source,
} from "@/lib/api";
import { usePersona } from "@/components/persona-provider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { Plus, Search, Sparkles, Trash2, X } from "lucide-react";

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

const RECOMMENDATION_LABEL: Record<Recommendation | "unscored", string> = {
  strong_apply: "strong apply",
  apply: "apply",
  stretch: "stretch",
  skip: "skip",
  unscored: "unscored",
};

function recommendationColor(rec: Recommendation | "unscored") {
  switch (rec) {
    case "strong_apply":
    case "apply":
      return "bg-ok-bg text-ok";
    case "stretch":
      return "bg-warn-bg text-warn";
    case "skip":
      return "bg-crit-bg text-crit";
    default:
      return "bg-muted text-muted-foreground";
  }
}

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
      router.push(`/pipeline?application_id=${application.id}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setStartingApplication(false);
    }
  }

  async function handleScoreJob() {
    setScoring(true);
    try {
      const scored = await api.scoreJob(jobId, personaId);
      setDetail((prev) => (prev ? { ...prev, fit_score: scored.fit_score, prefilter: scored.prefilter } : prev));
      onScored();
      toast.success(scored.fit_score ? `Scored: ${scored.fit_score.recommendation}` : "Scored — prefilter dropped it, see below");
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
                  onClick={handleStartApplication}
                  disabled={startingApplication}
                  title="Creates a tracked Application and opens it on the Pipeline board, where you can run the application-agent or mark it applied manually"
                >
                  {startingApplication ? "Adding…" : "Add to Pipeline"}
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

const EMPTY_JOB_DRAFT: JobDraft = {
  title: "",
  company_name: "",
  location: "",
  remote_policy: "",
  seniority: "",
  employment_type: "",
  salary_min: null,
  salary_max: null,
  salary_currency: "",
  requirements: "",
  responsibilities: "",
  benefits: "",
  apply_url: "",
  source_url: "",
};

// Both paths — paste a link, or just type the fields — land in the
// same form and the same POST /jobs call; parsing only prefills it,
// never saves anything on its own, so a bad/unrecognized page just
// means an empty form to fill by hand instead of a hard failure.
function AddJobDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (job: InboxJob) => void;
}) {
  const [urlInput, setUrlInput] = React.useState("");
  const [parsing, setParsing] = React.useState(false);
  const [draft, setDraft] = React.useState<JobDraft>(EMPTY_JOB_DRAFT);
  const [saving, setSaving] = React.useState(false);

  function field<K extends keyof JobDraft>(key: K, value: JobDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function handleParse() {
    const url = urlInput.trim();
    if (!url) return;
    setParsing(true);
    try {
      const parsed = await api.parseJobUrl(url);
      if (!parsed.found) {
        toast.error("That didn't look like a job posting — fill in the fields below by hand instead");
      } else {
        toast.success("Parsed — review the fields below before saving");
      }
      setDraft((prev) => ({
        ...prev,
        title: parsed.title ?? prev.title,
        company_name: parsed.company_name ?? prev.company_name,
        location: parsed.location ?? prev.location,
        remote_policy: parsed.remote_policy ?? prev.remote_policy,
        seniority: parsed.seniority ?? prev.seniority,
        employment_type: parsed.employment_type ?? prev.employment_type,
        salary_min: parsed.salary_min ?? prev.salary_min,
        salary_max: parsed.salary_max ?? prev.salary_max,
        salary_currency: parsed.salary_currency ?? prev.salary_currency,
        requirements: parsed.requirements ?? prev.requirements,
        responsibilities: parsed.responsibilities ?? prev.responsibilities,
        benefits: parsed.benefits ?? prev.benefits,
        apply_url: parsed.apply_url ?? prev.apply_url,
        source_url: url,
      }));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setParsing(false);
    }
  }

  async function handleSave() {
    const title = draft.title.trim();
    const company = draft.company_name.trim();
    if (!title || !company) {
      toast.error("Title and company are required");
      return;
    }
    setSaving(true);
    try {
      const created = await api.createJob({
        title,
        company_name: company,
        location: draft.location?.trim() || null,
        remote_policy: draft.remote_policy?.trim() || null,
        seniority: draft.seniority?.trim() || null,
        employment_type: draft.employment_type?.trim() || null,
        salary_min: draft.salary_min ?? null,
        salary_max: draft.salary_max ?? null,
        salary_currency: draft.salary_currency?.trim() || null,
        requirements: draft.requirements?.trim() || null,
        responsibilities: draft.responsibilities?.trim() || null,
        benefits: draft.benefits?.trim() || null,
        apply_url: draft.apply_url?.trim() || null,
        source_url: draft.source_url?.trim() || null,
      });
      toast.success(`"${created.title}" added to the inbox`);
      onCreated(created);
      setUrlInput("");
      setDraft(EMPTY_JOB_DRAFT);
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setUrlInput("");
          setDraft(EMPTY_JOB_DRAFT);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="w-full max-w-[min(92vw,42rem)] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a job</DialogTitle>
          <DialogDescription>
            Paste a job posting link to auto-fill the fields below, or just type them in — either way ends up
            in the same place.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="job-url">Job posting URL (optional)</Label>
            <div className="flex gap-2">
              <Input
                id="job-url"
                placeholder="https://www.linkedin.com/jobs/view/…"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleParse()}
              />
              <Button
                type="button"
                variant="outline"
                disabled={parsing || !urlInput.trim()}
                onClick={handleParse}
                className="gap-1.5 shrink-0"
              >
                <Sparkles className="size-3.5" />
                {parsing ? "Parsing…" : "Parse"}
              </Button>
            </div>
            <span className="text-xs text-muted-foreground">
              Works with any site — LinkedIn, Indeed, a company career page. An LLM reads the real page and
              fills in what it finds below; nothing is saved until you hit Save.
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="job-title">Title *</Label>
              <Input id="job-title" value={draft.title} onChange={(e) => field("title", e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-company">Company *</Label>
              <Input id="job-company" value={draft.company_name} onChange={(e) => field("company_name", e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-location">Location</Label>
              <Input id="job-location" value={draft.location ?? ""} onChange={(e) => field("location", e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-remote">Remote policy</Label>
              <Input
                id="job-remote"
                placeholder="remote / hybrid / onsite"
                value={draft.remote_policy ?? ""}
                onChange={(e) => field("remote_policy", e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-seniority">Seniority</Label>
              <Input id="job-seniority" value={draft.seniority ?? ""} onChange={(e) => field("seniority", e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-type">Employment type</Label>
              <Input
                id="job-type"
                placeholder="full_time / contract / …"
                value={draft.employment_type ?? ""}
                onChange={(e) => field("employment_type", e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-salary-min">Salary min</Label>
              <Input
                id="job-salary-min"
                type="number"
                value={draft.salary_min ?? ""}
                onChange={(e) => field("salary_min", e.target.value ? Number(e.target.value) : null)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-salary-max">Salary max</Label>
              <Input
                id="job-salary-max"
                type="number"
                value={draft.salary_max ?? ""}
                onChange={(e) => field("salary_max", e.target.value ? Number(e.target.value) : null)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-currency">Currency</Label>
              <Input
                id="job-currency"
                placeholder="USD"
                value={draft.salary_currency ?? ""}
                onChange={(e) => field("salary_currency", e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-apply-url">Apply URL</Label>
              <Input id="job-apply-url" value={draft.apply_url ?? ""} onChange={(e) => field("apply_url", e.target.value)} />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="job-requirements">Requirements</Label>
            <Textarea
              id="job-requirements"
              rows={3}
              value={draft.requirements ?? ""}
              onChange={(e) => field("requirements", e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="job-responsibilities">Responsibilities</Label>
            <Textarea
              id="job-responsibilities"
              rows={3}
              value={draft.responsibilities ?? ""}
              onChange={(e) => field("responsibilities", e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="job-benefits">Benefits</Label>
            <Textarea id="job-benefits" rows={2} value={draft.benefits ?? ""} onChange={(e) => field("benefits", e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSave} disabled={saving || !draft.title.trim() || !draft.company_name.trim()}>
            {saving ? "Saving…" : "Save job"}
          </Button>
        </DialogFooter>
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
    router.replace(`/inbox?job_id=${encodeURIComponent(jobId)}`, { scroll: false });
  }

  function closeJobDetail() {
    setSelectedJobId(null);
    router.replace("/inbox", { scroll: false });
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
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAddJobOpen(true)}>
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
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={!!jobs && jobs.length > 0 && selectedIds.size === jobs.length}
                  onCheckedChange={toggleSelectAll}
                  disabled={!jobs || jobs.length === 0}
                  aria-label="Select all filtered jobs"
                />
                <span className="text-[11px] text-muted-foreground">
                  {selectedIds.size > 0 ? `${selectedIds.size} selected` : "select all"}
                </span>
              </div>
              {selectedIds.size > 0 && (
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
                      {job.source_names.map((s) => (
                        <Badge key={s} variant="outline" className="text-[9px] font-mono">
                          {s}
                        </Badge>
                      ))}
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
    </div>
  );
}
