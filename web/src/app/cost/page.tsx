"use client";

import * as React from "react";
import { toast } from "sonner";
import { api, type CostSummary } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function money(v: number) {
  if (v === 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(2)}`;
}

export default function CostPage() {
  const [summary, setSummary] = React.useState<CostSummary | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.getCostSummary();
        if (!cancelled) setSummary(s);
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Cost &amp; Usage</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          every call from the LlmCall ledger — nothing estimated
        </span>
      </header>

      <div className="flex-1 overflow-auto p-5 flex flex-col gap-6">
        {loading || !summary ? (
          <div className="text-sm text-muted-foreground font-mono">loading…</div>
        ) : (
          <>
            <section className="grid grid-cols-4 gap-3">
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
                <span className="font-mono text-2xl font-semibold tabular">
                  {summary.total_calls}
                </span>
              </div>
              <div className="border border-border bg-card p-4 flex flex-col gap-1 col-span-2">
                <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                  Unknown-cost calls
                </span>
                <span className="font-mono text-2xl font-semibold tabular">
                  {summary.unknown_cost_calls}
                </span>
                <span className="text-xs text-muted-foreground">
                  Calls logged with real tokens but no matching catalog price — never
                  silently reported as free (F13.6).
                </span>
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                By stage
              </span>
              <div className="flex flex-col gap-1.5">
                {Object.entries(summary.by_stage).map(([stage, cost]) => {
                  const pct =
                    summary.total_cost_usd > 0 ? (cost / summary.total_cost_usd) * 100 : 0;
                  return (
                    <div key={stage} className="flex items-center gap-3">
                      <span className="w-32 font-mono text-xs text-muted-foreground truncate">
                        {stage}
                      </span>
                      <div className="flex-1 h-1.5 bg-muted">
                        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-20 text-right font-mono text-xs tabular">
                        {money(cost)}
                      </span>
                    </div>
                  );
                })}
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
                        <TableCell className="font-mono text-xs">{c.stage ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {c.model_id}
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
