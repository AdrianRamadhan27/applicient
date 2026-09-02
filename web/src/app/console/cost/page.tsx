"use client";

import * as React from "react";
import { toast } from "sonner";
import { api, type CostRun, type CostSummary } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const TIME_RANGES = {
  all: { label: "All time", hours: null },
  "24h": { label: "Last 24h", hours: 24 },
  "7d": { label: "Last 7 days", hours: 24 * 7 },
  "30d": { label: "Last 30 days", hours: 24 * 30 },
} as const;
type TimeRangeKey = keyof typeof TIME_RANGES;

type BreakdownKey = "by_stage" | "by_tier" | "by_provider" | "by_model" | "by_source";
const BREAKDOWNS: { key: BreakdownKey; label: string }[] = [
  { key: "by_stage", label: "Stage" },
  { key: "by_tier", label: "Tier" },
  { key: "by_provider", label: "Provider" },
  { key: "by_model", label: "Model" },
  { key: "by_source", label: "Source" },
];

function timestamp(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function money(v: number) {
  if (v === 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(2)}`;
}

export default function CostPage() {
  const [summary, setSummary] = React.useState<CostSummary | null>(null);
  const [runs, setRuns] = React.useState<CostRun[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [range, setRange] = React.useState<TimeRangeKey>("all");
  const [breakdown, setBreakdown] = React.useState<BreakdownKey>("by_stage");

  const load = React.useCallback(async (r: TimeRangeKey) => {
    setLoading(true);
    try {
      const hours = TIME_RANGES[r].hours;
      const since = hours ? new Date(Date.now() - hours * 3600_000).toISOString() : undefined;
      const [s, rn] = await Promise.all([api.getCostSummary({ since }), api.listCostRuns({ limit: 30 })]);
      setSummary(s);
      setRuns(rn);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    (async () => {
      await load(range);
    })();
  }, [range, load]);

  const breakdownData = summary ? (summary[breakdown] as Record<string, number>) : {};
  const breakdownEntries = Object.entries(breakdownData).sort((a, b) => b[1] - a[1]);
  const breakdownTotal = breakdownEntries.reduce((sum, [, v]) => sum + v, 0);

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Cost &amp; Usage</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          every call from the LlmCall ledger — nothing estimated
        </span>
        <div className="ml-auto">
          <Select value={range} onValueChange={(v) => setRange(v as TimeRangeKey)}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(TIME_RANGES) as TimeRangeKey[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {TIME_RANGES[k].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-5 flex flex-col gap-6">
        {loading || !summary ? (
          <div className="text-sm text-muted-foreground font-mono">loading…</div>
        ) : (
          <>
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="border border-border bg-card p-4 flex flex-col gap-1">
                <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                  Total spend
                </span>
                <span className="font-mono text-2xl font-semibold tabular">
                  {money(summary.total_cost_usd)}
                </span>
              </div>
              <div className="border border-border bg-card p-4 flex flex-col gap-1">
                <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                  Total calls
                </span>
                <span className="font-mono text-2xl font-semibold tabular">{summary.total_calls}</span>
                <span className="text-xs text-muted-foreground">
                  {summary.total_input_tokens.toLocaleString()} in / {summary.total_output_tokens.toLocaleString()} out tokens
                </span>
              </div>
              <div className="border border-border bg-card p-4 flex flex-col gap-1">
                <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                  Cost per scored job
                </span>
                <span className="font-mono text-2xl font-semibold tabular">
                  {summary.cost_per_scored_job === null ? "—" : money(summary.cost_per_scored_job)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {summary.cost_per_scored_job === null ? "no scored jobs in range" : "avg. prefilter + rubric"}
                </span>
              </div>
              <div className="border border-border bg-card p-4 flex flex-col gap-1">
                <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                  Unknown-cost calls
                </span>
                <span className="font-mono text-2xl font-semibold tabular">{summary.unknown_cost_calls}</span>
                <span className="text-xs text-muted-foreground">
                  Real tokens, no matching catalog price — never silently reported as free (F13.6).
                </span>
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <Tabs value={breakdown} onValueChange={(v) => setBreakdown(v as BreakdownKey)}>
                <TabsList>
                  {BREAKDOWNS.map((b) => (
                    <TabsTrigger key={b.key} value={b.key}>
                      {b.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <div className="flex flex-col gap-1.5">
                {breakdownEntries.length === 0 ? (
                  <span className="text-xs text-muted-foreground">No calls in this range for this breakdown.</span>
                ) : (
                  breakdownEntries.map(([key, cost]) => {
                    const pct = breakdownTotal > 0 ? (cost / breakdownTotal) * 100 : 0;
                    return (
                      <div key={key} className="flex items-center gap-3">
                        <span className="w-40 font-mono text-xs text-muted-foreground truncate" title={key}>
                          {key}
                        </span>
                        <div className="flex-1 h-1.5 bg-muted">
                          <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="w-20 text-right font-mono text-xs tabular">{money(cost)}</span>
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                Run history
              </span>
              <div className="border border-border bg-card overflow-auto max-h-[320px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[150px]">Started</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="w-[90px]">Status</TableHead>
                      <TableHead className="text-right w-[70px]">Calls</TableHead>
                      <TableHead className="text-right w-[90px]">Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(runs ?? []).map((r) => (
                      <TableRow key={r.id}>
                        <TableCell
                          className="font-mono text-xs text-muted-foreground tabular"
                          title={new Date(r.started_at).toISOString()}
                        >
                          {timestamp(r.started_at)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{r.run_type}</TableCell>
                        <TableCell>
                          <span
                            className={cn(
                              "font-mono text-[10px]",
                              r.status === "completed" ? "text-ok" : r.status === "failed" ? "text-crit" : "text-warn",
                            )}
                          >
                            {r.status}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular">{r.call_count}</TableCell>
                        <TableCell className="text-right font-mono text-xs tabular">{money(r.total_cost_usd)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                Recent calls
              </span>
              <div className="border border-border bg-card overflow-auto max-h-[480px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[140px]">When</TableHead>
                      <TableHead>Stage</TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead className="w-[70px]">Tier</TableHead>
                      <TableHead className="text-right w-[110px]">Tokens in/out</TableHead>
                      <TableHead className="text-right w-[90px]">Cost</TableHead>
                      <TableHead className="w-[70px]">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.recent_calls.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell
                          className="font-mono text-xs text-muted-foreground tabular"
                          title={new Date(c.created_at).toISOString()}
                        >
                          {timestamp(c.created_at)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{c.stage ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          <span title={c.pricing_version ? `pricing: ${c.pricing_version}` : undefined}>
                            {c.model_id}
                          </span>
                          {c.fallback_from_model && (
                            <Badge variant="secondary" className="ml-1.5 text-[9px] font-mono">
                              fallback from {c.fallback_from_model}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="text-[9px] font-mono">
                            {c.tier ?? "—"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular">
                          {c.input_tokens}/{c.output_tokens}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular">
                          {c.cost_known ? money(c.cost_usd) : "unknown"}
                        </TableCell>
                        <TableCell>
                          <span
                            className={
                              c.status === "ok"
                                ? "font-mono text-[10px] text-ok"
                                : "font-mono text-[10px] text-crit"
                            }
                            title={c.error_message ?? undefined}
                          >
                            {c.status}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
