"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api, type ApplicationDetail, type EmailMessage, type GmailConnection } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Mail } from "lucide-react";

const SCAN_WINDOW_OPTIONS = [1, 3, 7, 14, 30];

/** M5 F8.1/F8.2 — one Gmail account per user, feeding email ingestion.
 * Was on the Credentials page; moved here to sit next to the feature
 * it actually feeds instead of alongside unrelated site-login
 * credentials (raised directly by Adrian). Connect is a real
 * navigation (not a fetch) since OAuth needs the browser at Google's
 * own consent screen; the callback lands back here with
 * ?gmail=connected, which just triggers a toast + reload. */
function GmailSection() {
  const [connection, setConnection] = React.useState<GmailConnection | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [disconnecting, setDisconnecting] = React.useState(false);
  const [updatingWindow, setUpdatingWindow] = React.useState(false);
  const [togglingPolling, setTogglingPolling] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const list = await api.listGmailConnections();
      setConnection(list[0] ?? null);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    (async () => {
      await load();
      if (new URLSearchParams(window.location.search).get("gmail") === "connected") {
        toast.success("Gmail connected");
        window.history.replaceState({}, "", window.location.pathname);
      }
    })();
  }, [load]);

  async function handleScanWindowChange(days: string) {
    if (!connection) return;
    setUpdatingWindow(true);
    try {
      const updated = await api.updateGmailConnection(connection.id, { scan_window_days: Number(days) });
      setConnection(updated);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setUpdatingWindow(false);
    }
  }

  async function handleTogglePolling(enabled: boolean) {
    if (!connection) return;
    setTogglingPolling(true);
    try {
      const updated = await api.updateGmailConnection(connection.id, { polling_enabled: enabled });
      setConnection(updated);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setTogglingPolling(false);
    }
  }

  async function handleDisconnect() {
    if (!connection) return;
    if (!window.confirm(`Disconnect ${connection.google_email}? Email ingestion stops until reconnected.`)) return;
    setDisconnecting(true);
    try {
      await api.deleteGmailConnection(connection.id);
      setConnection(null);
      toast.success("Gmail disconnected");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="border border-border bg-card p-4 mb-5">
      <div className="flex items-center gap-2 mb-2">
        <Mail className="size-4 text-muted-foreground" strokeWidth={1.5} />
        <span className="text-sm font-semibold">Gmail</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          read-only — scanned for application-related keywords (interview, offer, rejection, etc.), not your whole
          inbox verbatim
        </span>
      </div>
      {loading ? (
        <div className="text-sm text-muted-foreground font-mono">loading…</div>
      ) : connection ? (
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs min-w-0">
            <div className="font-mono">{connection.google_email}</div>
            <div className="text-muted-foreground mt-0.5">
              status: {connection.status}
              {connection.last_synced_at && ` · last synced ${new Date(connection.last_synced_at).toLocaleString()}`}
              {connection.last_error && <span className="text-crit"> · {connection.last_error}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <label className="flex items-center gap-1.5" title="Pause/resume Gmail inbox polling">
              <Switch
                checked={connection.polling_enabled}
                disabled={togglingPolling}
                onCheckedChange={handleTogglePolling}
              />
              <span className="text-xs text-muted-foreground">
                {connection.polling_enabled ? "polling" : "paused"}
              </span>
            </label>
            <span className="text-xs text-muted-foreground">scan last</span>
            <Select
              value={String(connection.scan_window_days)}
              onValueChange={handleScanWindowChange}
              disabled={updatingWindow}
            >
              <SelectTrigger className="h-7 w-[90px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCAN_WINDOW_OPTIONS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d} day{d !== 1 ? "s" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="destructive" disabled={disconnecting} onClick={handleDisconnect}>
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Not connected — the assistant can&apos;t read application-related emails yet.
          </span>
          <Button size="sm" asChild>
            <a href={api.gmailConnectUrl()}>Connect Gmail</a>
          </Button>
        </div>
      )}
    </div>
  );
}

/** M5 F8.4/F8.6 — the review queue for anything email_ingestion.py
 * flagged `review_needed`: either a low-confidence/unmatched email, or
 * a matched one whose proposed state transition wasn't confident
 * enough to auto-apply. The proposed state itself isn't on EmailMessage
 * — it only exists in the matched Application's own event log (the
 * "email_matched" ApplicationEvent email_ingestion.py writes), so each
 * matched row fetches that application's detail to find it. */

function findPendingProposal(app: ApplicationDetail): { proposedState: string; reason: string | null } | null {
  const pending = app.events.find(
    (e) => e.event_type === "email_matched" && e.payload?.needs_confirmation === true,
  );
  if (!pending) return null;
  const proposedState = pending.payload?.proposed_state;
  if (typeof proposedState !== "string") return null;
  const reason = typeof pending.payload?.reason === "string" ? pending.payload.reason : null;
  return { proposedState, reason };
}

function ReviewRow({
  message,
  appDetail,
  onResolved,
}: {
  message: EmailMessage;
  appDetail: ApplicationDetail | null | undefined;
  onResolved: (id: string) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const proposal = appDetail ? findPendingProposal(appDetail) : null;

  async function handleApprove() {
    if (!proposal) return;
    setBusy(true);
    try {
      await api.confirmEmailTransition(message.id, { approve: true, new_state: proposal.proposedState });
      toast.success(`Application moved to "${proposal.proposedState}"`);
      onResolved(message.id);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDismiss() {
    setBusy(true);
    try {
      await api.confirmEmailTransition(message.id, { approve: false });
      toast.success("Dismissed");
      onResolved(message.id);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-border bg-card px-4 py-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{message.subject || "(no subject)"}</div>
          {message.snippet && <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{message.snippet}</div>}
          <div className="text-[11px] text-muted-foreground font-mono mt-1 flex items-center gap-2 flex-wrap">
            <span>{new Date(message.received_at).toLocaleString()}</span>
            {message.classification && <Badge variant="outline">{message.classification}</Badge>}
            {message.match_confidence !== null && (
              <span>match confidence: {(message.match_confidence * 100).toFixed(0)}%</span>
            )}
          </div>
        </div>
      </div>

      {appDetail ? (
        <div className="text-xs border-t border-border pt-2 flex items-center justify-between gap-3">
          <div>
            <Link href={`/console/pipeline?application_id=${appDetail.id}`} className="underline hover:text-foreground">
              {appDetail.job_title} — {appDetail.company_name}
            </Link>
            {proposal ? (
              <div className="text-muted-foreground mt-0.5">
                proposes moving to <span className="font-mono">{proposal.proposedState}</span>
                {proposal.reason && ` (${proposal.reason})`}
              </div>
            ) : (
              <div className="text-muted-foreground mt-0.5">matched, but no state change proposed</div>
            )}
          </div>
          <div className="flex gap-2 shrink-0">
            {proposal && (
              <Button size="sm" disabled={busy} onClick={handleApprove}>
                Approve
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={busy} onClick={handleDismiss}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : message.matched_application_id ? (
        <div className="text-xs text-muted-foreground border-t border-border pt-2">loading matched application…</div>
      ) : (
        <div className="text-xs border-t border-border pt-2 flex items-center justify-between gap-3">
          <span className="text-muted-foreground">not matched to any application</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={handleDismiss}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

export default function EmailReviewPage() {
  const [messages, setMessages] = React.useState<EmailMessage[]>([]);
  const [appDetails, setAppDetails] = React.useState<Record<string, ApplicationDetail>>({});
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    try {
      const list = await api.listEmailMessages(true);
      setMessages(list);
      const appIds = Array.from(new Set(list.map((m) => m.matched_application_id).filter((id): id is string => !!id)));
      const fetched = await Promise.all(
        appIds.map(async (id) => {
          try {
            return await api.getApplication(id);
          } catch {
            return null;
          }
        }),
      );
      setAppDetails((prev) => {
        const next = { ...prev };
        fetched.forEach((detail) => {
          if (detail) next[detail.id] = detail;
        });
        return next;
      });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);

  function handleResolved(messageId: string) {
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  }

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Email Review</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          emails the assistant couldn&apos;t confidently act on by itself
        </span>
      </header>

      <div className="flex-1 overflow-auto p-5">
        <GmailSection />
        {loading ? (
          <div className="text-sm text-muted-foreground font-mono">loading…</div>
        ) : messages.length === 0 ? (
          <div className="text-sm text-muted-foreground border border-dashed border-input p-6 text-center">
            Nothing pending review — every ingested email was either confidently matched and applied, or didn&apos;t
            need a decision.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((m) => (
              <ReviewRow
                key={m.id}
                message={m}
                appDetail={m.matched_application_id ? appDetails[m.matched_application_id] : null}
                onResolved={handleResolved}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
