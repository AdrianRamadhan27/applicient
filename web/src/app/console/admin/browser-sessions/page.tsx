"use client";

import * as React from "react";
import { toast } from "sonner";
import { api, type BrowserSession } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Trash2 } from "lucide-react";

// Adrian, direct: hit "2 concurrent browser sessions already open" in
// production and asked for an admin page to monitor + kill them.
// Polls the same way Run Console's own live views already do — there's
// no push channel for this (browser-worker is a plain HTTP shell, no
// SSE/WS for session-list changes), so a plain interval is the
// simplest thing that stays honest about being a snapshot, not a live
// feed.
const POLL_INTERVAL_MS = 5000;

function elapsedSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** "user:<uuid>:app:<uuid>" -> a short, readable tag — the full IDs are
 * still there in the label for anyone who needs to grep logs/DB by
 * them, this just avoids a wall of raw UUIDs in the table. */
function describeLabel(label: string | null): string {
  if (!label) return "unlabeled";
  const m = /^user:([0-9a-f-]+):app:([0-9a-f-]+)$/i.exec(label);
  if (m) return `application ${m[2].slice(0, 8)}…`;
  if (label === "job-url-parse") return "job URL parse";
  return label;
}

export default function AdminBrowserSessionsPage() {
  const [sessions, setSessions] = React.useState<BrowserSession[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [killingId, setKillingId] = React.useState<string | null>(null);
  const [killingAll, setKillingAll] = React.useState(false);
  // Re-rendered every second purely to keep "elapsed" ticking between
  // polls — the session list itself only actually refreshes on the
  // slower POLL_INTERVAL_MS cadence above.
  const [, forceTick] = React.useState(0);

  const load = React.useCallback(async (opts?: { silent?: boolean }) => {
    try {
      const list = await api.listBrowserSessions();
      setSessions(list);
    } catch (e) {
      if (!opts?.silent) toast.error(e instanceof Error ? e.message : "Failed to load browser sessions");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    (async () => {
      await load();
    })();
    const poll = window.setInterval(() => void load({ silent: true }), POLL_INTERVAL_MS);
    const tick = window.setInterval(() => forceTick((t) => t + 1), 1000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [load]);

  async function handleKill(sessionId: string) {
    setKillingId(sessionId);
    try {
      await api.killBrowserSession(sessionId);
      toast.success("Session closed");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to close session");
    } finally {
      setKillingId(null);
    }
  }

  async function handleKillAll() {
    if (!sessions || sessions.length === 0) return;
    if (!window.confirm(`Close all ${sessions.length} open browser session(s)? Any in-progress agent run using one will fail its next browser action.`)) {
      return;
    }
    setKillingAll(true);
    try {
      const { closed } = await api.killAllBrowserSessions();
      toast.success(`Closed ${closed} session(s)`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to close sessions");
    } finally {
      setKillingAll(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Browser Sessions</span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => load()}>
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={killingAll || !sessions || sessions.length === 0}
            onClick={handleKillAll}
          >
            {killingAll ? "Closing…" : "Close all"}
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-5">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Every currently-open browser-worker session, across every user — this is the shared concurrency budget
            (<code className="font-mono">BROWSER_WORKER_MAX_SESSIONS</code>) that &ldquo;N concurrent browser
            sessions already open&rdquo; errors are hitting. Closing a session here is immediate and does not tell
            the agent run using it — its next browser action will fail with a clear error instead of continuing
            silently.
          </p>

          {loading ? (
            <div className="text-sm text-muted-foreground font-mono">loading…</div>
          ) : !sessions || sessions.length === 0 ? (
            <div className="border border-dashed border-input p-8 text-center text-sm text-muted-foreground">
              No browser sessions currently open.
            </div>
          ) : (
            <div className="flex flex-col border border-border bg-card">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="font-mono text-[9px]">
                        {describeLabel(s.label)}
                      </Badge>
                      <span className="font-mono text-[10px] text-muted-foreground">{elapsedSince(s.created_at)}</span>
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground" title={s.url}>
                      {s.url}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 text-crit hover:text-crit"
                    disabled={killingId === s.id}
                    onClick={() => handleKill(s.id)}
                  >
                    <Trash2 className="size-3.5" />
                    {killingId === s.id ? "Closing…" : "Close"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
