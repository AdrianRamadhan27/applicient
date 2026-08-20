"use client";

import * as React from "react";
import { toast } from "sonner";
import { api, type InboxJob, type InboxJobDetail, type Persona, type Recommendation, type Source } from "@/lib/api";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

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
}: {
  jobId: string;
  personaId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = React.useState<InboxJobDetail | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const d = await api.getInboxJob(jobId, personaId);
        if (!cancelled) setDetail(d);
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

  const fs = detail?.fit_score ?? null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        {loading || !detail ? (
          <div className="text-sm text-muted-foreground font-mono py-8 text-center">loading…</div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{detail.title}</DialogTitle>
              <DialogDescription>
                {detail.company_name_raw}
                {detail.location ? ` · ${detail.location}` : ""}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4 py-2">
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
                            <Badge key={s} className="text-[9px] font-mono bg-ok-bg text-ok">
                              {s}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {fs.skills_partial.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {fs.skills_partial.map((s) => (
                            <Badge key={s} className="text-[9px] font-mono bg-warn-bg text-warn">
                              {s}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {fs.skills_missing.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {fs.skills_missing.map((s) => (
                            <Badge key={s} variant="secondary" className="text-[9px] font-mono text-muted-foreground">
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
                          <div key={i} className="border border-border px-2 py-1.5 text-xs">
                            <div className="italic text-muted-foreground">&ldquo;{span.quote}&rdquo;</div>
                            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{span.supports}</div>
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
                <span className="text-xs text-muted-foreground">Not scored yet for this persona.</span>
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
                    <Badge variant="secondary" className="text-[9px] font-mono">
                      {s.source_name}
                    </Badge>
                    <span className="text-muted-foreground truncate">{s.source_url}</span>
                  </a>
                ))}
              </div>

              {detail.apply_url && (
                <Button asChild size="sm" className="self-start">
                  <a href={detail.apply_url} target="_blank" rel="noopener noreferrer">
                    Apply
                  </a>
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function InboxPage() {
  const [personas, setPersonas] = React.useState<Persona[]>([]);
  const [sources, setSources] = React.useState<Source[]>([]);
  const [personaId, setPersonaId] = React.useState<string>("");
  const [jobs, setJobs] = React.useState<InboxJob[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingList, setLoadingList] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null);

  const [recFilter, setRecFilter] = React.useState<Set<Recommendation | "unscored">>(new Set());
  const [sourceFilter, setSourceFilter] = React.useState<string>("");
  const [locationInput, setLocationInput] = React.useState("");
  const [locationFilter, setLocationFilter] = React.useState("");
  const [minScore, setMinScore] = React.useState("");
  const [maxScore, setMaxScore] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, s] = await Promise.all([api.listPersonas(), api.listSources()]);
        if (cancelled) return;
        setPersonas(p);
        setSources(s);
        setPersonaId(p.find((x) => x.active)?.id ?? p[0]?.id ?? "");
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
        location: locationFilter || undefined,
        minScore: minScore ? Number(minScore) : undefined,
        maxScore: maxScore ? Number(maxScore) : undefined,
        limit: 200,
      });
      setJobs(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingList(false);
    }
  }, [personaId, recFilter, sourceFilter, locationFilter, minScore, maxScore]);

  React.useEffect(() => {
    (async () => {
      await loadJobs();
    })();
  }, [loadJobs]);

  function toggleRec(rec: Recommendation | "unscored") {
    setRecFilter((prev) => {
      const next = new Set(prev);
      if (next.has(rec)) next.delete(rec);
      else next.add(rec);
      return next;
    });
  }

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Job Inbox</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          ranked by fit — real API data only, no sample jobs
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor="inbox-persona" className="text-xs text-muted-foreground">
            Persona
          </Label>
          <Select value={personaId} onValueChange={setPersonaId}>
            <SelectTrigger id="inbox-persona" className="w-44">
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
        <div className="flex-1 overflow-auto p-5 flex flex-col gap-4">
          <div className="border border-border bg-card p-3 flex flex-col gap-3">
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
                <button
                  key={job.id}
                  onClick={() => setSelectedJobId(job.id)}
                  className="text-left border border-border bg-card p-3 flex items-start gap-3 hover:border-primary transition-colors"
                >
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
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {selectedJobId && personaId && (
        <JobDetailDrawer jobId={selectedJobId} personaId={personaId} onClose={() => setSelectedJobId(null)} />
      )}
    </div>
  );
}
