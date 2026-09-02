"use client";

import * as React from "react";
import { toast } from "sonner";
import { api, type AgentRunDetail, type CostRun } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function timestamp(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function money(v: number) {
  if (v === 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(2)}`;
}

function duration(startedAt: string, finishedAt: string | null) {
  if (!finishedAt) return "running…";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusColor(status: string) {
  if (status === "completed" || status === "ok") return "text-ok";
  if (status === "failed" || status === "error") return "text-crit";
  return "text-warn";
}

function StepDetail({ label, data }: { label: string; data: Record<string, unknown> }) {
  const keys = Object.keys(data);
  if (keys.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[9px] tracking-wider uppercase text-muted-foreground">{label}</span>
      <pre className="font-mono text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-all">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

export default function RunConsolePage() {
  const [runs, setRuns] = React.useState<CostRun[] | null>(null);
  const [loadingRuns, setLoadingRuns] = React.useState(true);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<AgentRunDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = React.useState(false);

  React.useEffect(() => {
    (async () => {
      try {
        const r = await api.listCostRuns({ limit: 50 });
        setRuns(r);
        if (r.length > 0) setSelectedId(r[0].id);
      } catch (e) {
        toast.error(String(e));
      } finally {
        setLoadingRuns(false);
      }
    })();
  }, []);

  React.useEffect(() => {
    if (!selectedId) return;
    (async () => {
      setLoadingDetail(true);
      try {
        const d = await api.getAgentRun(selectedId);
        setDetail(d);
      } catch (e) {
        toast.error(String(e));
      } finally {
        setLoadingDetail(false);
      }
    })();
  }, [selectedId]);

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Run Console</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          the AgentStep trace for any run — works without LangSmith configured
        </span>
      </header>

      <div className="flex-1 overflow-hidden flex">
        <div className="w-72 shrink-0 border-r border-border overflow-y-auto">
          {loadingRuns ? (
            <div className="p-4 text-sm text-muted-foreground font-mono">loading…</div>
          ) : !runs || runs.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No runs yet.</div>
          ) : (
            runs.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className={cn(
                  "w-full text-left px-4 py-2.5 border-b border-border flex flex-col gap-0.5 hover:bg-secondary/40",
                  selectedId === r.id && "bg-secondary/60",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{r.run_type}</span>
                  <span className={cn("font-mono text-[9px] ml-auto", statusColor(r.status))}>{r.status}</span>
                </div>
                <span className="font-mono text-[10px] text-muted-foreground">{timestamp(r.started_at)}</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {r.call_count} calls · {money(r.total_cost_usd)}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {!selectedId ? (
            <div className="text-sm text-muted-foreground">Select a run on the left.</div>
          ) : loadingDetail || !detail ? (
            <div className="text-sm text-muted-foreground font-mono">loading…</div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="border border-border bg-card p-4 flex flex-col gap-2">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold">{detail.run_type}</span>
                  <span className={cn("font-mono text-xs", statusColor(detail.status))}>{detail.status}</span>
                  <span className="ml-auto font-mono text-sm font-semibold tabular">
                    {money(detail.total_cost_usd)}
                  </span>
                </div>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {timestamp(detail.started_at)} · {duration(detail.started_at, detail.finished_at)}
                </span>
                {detail.profile_revision !== null && (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    profile revision {detail.profile_revision}
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                  Steps ({detail.steps.length})
                </span>
                {detail.steps.length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    No AgentStep rows for this run — either it failed before any step completed, or this run
                    type doesn&apos;t emit steps yet.
                  </span>
                ) : (
                  <div className="flex flex-col gap-2">
                    {detail.steps.map((s, i) => (
                      <div key={s.id} className="border border-border bg-card p-3 flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-[9px] font-mono">
                            {i + 1}
                          </Badge>
                          <span className="text-xs font-medium">{s.step_type}</span>
                          {s.subagent_name && (
                            <Badge variant="outline" className="text-[9px] font-mono">
                              {s.subagent_name}
                            </Badge>
                          )}
                          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                            {duration(s.started_at, s.finished_at)}
                          </span>
                          {s.cost_usd > 0 && (
                            <span className="font-mono text-[10px] tabular">{money(s.cost_usd)}</span>
                          )}
                        </div>
                        <StepDetail label="Input" data={s.input_summary} />
                        <StepDetail label="Output" data={s.output_summary} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
