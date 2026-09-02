"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api, apiWebSocketUrl, getAuthToken, type InterruptDecision, type InterruptRequest } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// F6.5/§8.3's dedicated Live Browser page — previously disclosed as
// not built (the handoff decision only ever surfaced as a blind
// "type what you did, then continue" box in the Pipeline panel; the
// screencast WebSocket it consumes already worked). Reads
// application_id/attempt_id/session_id from the query string via
// window.location (not next/navigation's useSearchParams) — same
// choice pipeline/page.tsx already made, to avoid a Suspense boundary
// for what is, on this "use client" page, plain client-side state.
type ConnState = "connecting" | "open" | "closed" | "error";

export default function LiveBrowserPage() {
  const [params, setParams] = React.useState<{
    applicationId: string;
    attemptId: string;
    sessionId: string;
  } | null>(null);
  const [missingParams, setMissingParams] = React.useState(false);
  const [connState, setConnState] = React.useState<ConnState>("connecting");
  const [frameUrl, setFrameUrl] = React.useState<string | null>(null);
  const [typeText, setTypeText] = React.useState("");

  // Real gap this closes: this page used to have zero awareness of an
  // `ask_user`/submit-review/handoff interrupt at all — someone
  // watching only the live view had no way to know the agent was
  // sitting there waiting on them unless they also had the Pipeline
  // tab open. Polled (not pushed) since this page has no SSE
  // connection of its own — `getApplicationAttemptEvents` is the same
  // plain REST replay `pipeline/page.tsx`'s own reconnect path uses.
  const [pendingInterrupt, setPendingInterrupt] = React.useState<InterruptRequest[] | null>(null);
  const [respondMessage, setRespondMessage] = React.useState("");
  const [sendingDecision, setSendingDecision] = React.useState(false);

  const imgRef = React.useRef<HTMLImageElement>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const frameUrlRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const search = new URLSearchParams(window.location.search);
      const applicationId = search.get("application_id");
      const attemptId = search.get("attempt_id");
      const sessionId = search.get("session_id");
      if (cancelled) return;
      if (applicationId && attemptId && sessionId) {
        setParams({ applicationId, attemptId, sessionId });
      } else {
        setMissingParams(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!params) return;
    let cancelled = false;
    let ws: WebSocket | null = null;
    (async () => {
      if (cancelled) return;
      setConnState("connecting");
      const authToken = getAuthToken();
      ws = new WebSocket(
        apiWebSocketUrl(
          `/applications/${params.applicationId}/attempts/${params.attemptId}/live-browser` +
            `?session_id=${encodeURIComponent(params.sessionId)}` +
            (authToken ? `&token=${encodeURIComponent(authToken)}` : ""),
        ),
      );
      wsRef.current = ws;
      ws.onopen = () => setConnState("open");
      ws.onerror = () => setConnState("error");
      ws.onclose = () => setConnState("closed");
      ws.onmessage = (evt) => {
        if (!(evt.data instanceof Blob)) return;
        const url = URL.createObjectURL(evt.data);
        if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = url;
        setFrameUrl(url);
      };
    })();
    return () => {
      cancelled = true;
      ws?.close();
      if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
      frameUrlRef.current = null;
    };
  }, [params]);

  React.useEffect(() => {
    if (!params) return;
    let cancelled = false;

    async function poll() {
      try {
        const events = await api.getApplicationAttemptEvents(params!.applicationId, params!.attemptId);
        if (cancelled) return;
        let pending: InterruptRequest[] | null = null;
        for (const evt of events) {
          if (evt.type === "interrupt") pending = evt.requests;
          else if (evt.type === "done" || evt.type === "error") pending = null;
        }
        setPendingInterrupt(pending);
      } catch {
        // Best-effort — a transient fetch failure just tries again next tick.
      }
    }

    (async () => {
      if (!cancelled) await poll();
    })();
    const interval = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [params]);

  async function handleDecision(decision: InterruptDecision) {
    if (!params) return;
    setSendingDecision(true);
    try {
      for await (const evt of api.streamResumeApplication(params.applicationId, params.attemptId, [decision])) {
        if (evt.type === "interrupt") {
          setPendingInterrupt(evt.requests);
          break;
        } else if (evt.type === "done") {
          setPendingInterrupt(null);
          toast.success("Run finished");
          break;
        } else if (evt.type === "error") {
          setPendingInterrupt(null);
          toast.error(evt.message);
          break;
        }
        // "stage" events are ignored here — this page has no chat log,
        // just the interrupt banner and the live frames.
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send response");
    } finally {
      setSendingDecision(false);
      setRespondMessage("");
    }
  }

  function sendEvent(event: Record<string, unknown>) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(event));
    }
  }

  // Scales the click from the displayed (possibly shrunk-to-fit) image
  // size back to the real page's pixel coordinates — browser-worker's
  // screenshots are always full native size, but the <img> here is
  // whatever size the layout fit it to.
  function handleImageClick(e: React.MouseEvent<HTMLImageElement>) {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const rect = img.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (img.naturalWidth / rect.width);
    const y = (e.clientY - rect.top) * (img.naturalHeight / rect.height);
    sendEvent({ type: "click", x, y });
  }

  function handleSendText() {
    if (!typeText) return;
    sendEvent({ type: "type", text: typeText });
    setTypeText("");
  }

  function handleKey(key: string) {
    sendEvent({ type: "key", key });
  }

  if (missingParams) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground font-mono text-center px-8">
        Missing application_id/attempt_id/session_id — open this page via the Pipeline panel&apos;s
        &quot;Watch live browser&quot; link, not directly.
      </div>
    );
  }

  if (!params) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground font-mono">
        loading…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center justify-between px-5">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold">Live Browser</span>
          <span
            className={cn(
              "text-[10px] font-mono px-1.5 py-0.5 rounded",
              connState === "open" && "bg-primary/10 text-primary",
              connState === "connecting" && "bg-warn/10 text-warn",
              (connState === "closed" || connState === "error") && "bg-crit/10 text-crit",
            )}
          >
            {connState}
          </span>
        </div>
        <Link
          href={`/console/pipeline?application_id=${encodeURIComponent(params.applicationId)}`}
          className="text-xs text-primary hover:underline"
        >
          ← Back to Pipeline
        </Link>
      </header>

      <div className="flex-1 overflow-auto bg-secondary/30 flex items-center justify-center p-4">
        {frameUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={imgRef}
            src={frameUrl}
            alt="Live view of the agent's browser"
            onClick={handleImageClick}
            className="max-w-full max-h-full border border-border shadow-sm cursor-pointer"
          />
        ) : (
          <div className="text-sm text-muted-foreground font-mono">
            {connState === "connecting" || connState === "open"
              ? "waiting for the first frame…"
              : "connection closed — go back and reopen this from the Pipeline panel"}
          </div>
        )}
      </div>

      {pendingInterrupt && pendingInterrupt.length === 1 && (
        <div className="shrink-0 border-t border-warn bg-warn/10 p-3 text-xs space-y-2">
          <div className="font-semibold">
            {pendingInterrupt[0].tool === "submit_application"
              ? "Waiting on you: review before submit"
              : pendingInterrupt[0].tool === "ask_user"
                ? "The agent needs an answer from you"
                : "Waiting on you: handle this in the browser above"}
          </div>
          <div className="text-muted-foreground whitespace-pre-wrap">{pendingInterrupt[0].description}</div>
          {pendingInterrupt[0].tool === "submit_application" ? (
            <div className="flex gap-2">
              <Button size="sm" disabled={sendingDecision} onClick={() => handleDecision({ type: "approve" })}>
                Approve submit
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={sendingDecision}
                onClick={() => handleDecision({ type: "reject" })}
              >
                Reject
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Textarea
                placeholder={
                  pendingInterrupt[0].tool === "ask_user" ? "Type your answer…" : "Leave blank to just continue…"
                }
                value={respondMessage}
                onChange={(e) => setRespondMessage(e.target.value)}
                rows={1}
                className="flex-1"
              />
              <Button
                size="sm"
                disabled={sendingDecision}
                onClick={() => handleDecision({ type: "respond", message: respondMessage || "Continue." })}
              >
                {pendingInterrupt[0].tool === "ask_user" ? "Send answer" : "Continue"}
              </Button>
            </div>
          )}
        </div>
      )}

      {pendingInterrupt && pendingInterrupt.length > 1 && (
        <div className="shrink-0 border-t border-warn bg-warn/10 p-3 text-xs">
          The agent needs {pendingInterrupt.length} things from you at once — respond from the{" "}
          <Link
            href={`/console/pipeline?application_id=${encodeURIComponent(params.applicationId)}`}
            className="text-primary hover:underline"
          >
            Pipeline panel
          </Link>{" "}
          instead.
        </div>
      )}

      <div className="shrink-0 border-t border-border bg-card p-3 flex items-center gap-2">
        <Input
          value={typeText}
          onChange={(e) => setTypeText(e.target.value)}
          placeholder="Click a field on the page to focus it, type here, then Send"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSendText();
          }}
          className="flex-1"
        />
        <Button size="sm" onClick={handleSendText}>
          Send
        </Button>
        <Button size="sm" variant="outline" onClick={() => handleKey("Enter")}>
          Enter
        </Button>
        <Button size="sm" variant="outline" onClick={() => handleKey("Tab")}>
          Tab
        </Button>
        <Button size="sm" variant="outline" onClick={() => handleKey("Escape")}>
          Esc
        </Button>
        <Button size="sm" variant="outline" onClick={() => handleKey("Backspace")}>
          ⌫
        </Button>
      </div>

      <div className="shrink-0 border-t border-border bg-secondary/30 px-3 py-2 text-[10px] text-muted-foreground font-mono">
        Click the image to click there in the real browser. Solve the captcha/login here, then go back to
        Pipeline and tell the agent it can continue.
      </div>
    </div>
  );
}
