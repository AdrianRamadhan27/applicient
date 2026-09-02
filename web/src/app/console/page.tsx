"use client";

import * as React from "react";
import { toast } from "sonner";
import { api, type DashboardSummary } from "@/lib/api";

// Phase 14 (v2 plan) — the new authenticated home. Account-wide (not
// persona-scoped, unlike most other pages) since Job/Application/
// Document are all only ever filtered by user_id at the model level —
// a real per-persona breakdown would need new query plumbing this
// first pass doesn't build.
export default function DashboardPage() {
  const [summary, setSummary] = React.useState<DashboardSummary | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    (async () => {
      try {
        setSummary(await api.getDashboardSummary());
      } catch (e) {
        toast.error(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const totalApplications = summary?.applications_by_stage.reduce((sum, s) => sum + s.count, 0) ?? 0;
  const maxStageCount = Math.max(1, ...(summary?.applications_by_stage.map((s) => s.count) ?? [1]));
  const maxDailyCount = Math.max(
    1,
    ...(summary?.daily_activity.flatMap((d) => [d.jobs_discovered, d.applications_created]) ?? [1]),
  );

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center px-5">
        <span className="text-sm font-semibold">Dashboard</span>
      </header>

      <div className="flex-1 overflow-auto p-5 flex flex-col gap-6">
        {loading || !summary ? (
          <div className="text-sm text-muted-foreground font-mono">loading…</div>
        ) : (
          <>
            <section className="grid grid-cols-3 gap-3 max-w-3xl">
              <div className="border border-border bg-card p-4 flex flex-col gap-1">
                <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                  Jobs discovered
                </span>
                <span className="font-mono text-2xl font-semibold tabular">{summary.job_count}</span>
              </div>
              <div className="border border-border bg-card p-4 flex flex-col gap-1">
                <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                  Applications tracked
                </span>
                <span className="font-mono text-2xl font-semibold tabular">{totalApplications}</span>
              </div>
              <div className="border border-border bg-card p-4 flex flex-col gap-1">
                <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                  Documents generated
                </span>
                <span className="font-mono text-2xl font-semibold tabular">{summary.document_count}</span>
              </div>
            </section>

            {summary.applications_by_stage.length > 0 && (
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
          </>
        )}
      </div>
    </div>
  );
}
