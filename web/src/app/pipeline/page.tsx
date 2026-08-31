"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  api,
  type Application,
  type ApplicationDetail,
  type ApplicationStreamEvent,
  type InterruptDecision,
  type InterruptRequest,
  type PipelineStage,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ChatLog, type LogItem } from "@/components/chat-log";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, ChevronUp, Settings } from "lucide-react";

// Detail panel width — draggable, persisted per-browser (first use of
// localStorage in this file; persona-provider.tsx's selectedPersonaId
// is the established precedent elsewhere in this app).
const PANEL_WIDTH_KEY = "applicient.pipelinePanelWidth";
const DEFAULT_PANEL_WIDTH = 384; // matches the old fixed w-96
const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 800;

// Kanban board — drag a card between columns, or use the detail
// panel's dropdown; both go through the same server-validated
// `PATCH /applications/{id}` transition (M5 follow-up: transitions
// are fully permissive between any of a user's own defined stages —
// see pipeline_service.py). Columns come from the user's own
// customizable PipelineStage list now, not a fixed set — every
// defined stage is a real column, no more "some states aren't
// columns" carve-out. F7.5's analytics view (response rate, funnel
// conversion, time-to-response) is a separate, still-disclosed gap —
// see M4_IMPLEMENTATION.md §10.
const UNASSIGNED_COLUMN_KEY = "__unassigned__";

function timestamp(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PipelinePage() {
  const router = useRouter();
  const [applications, setApplications] = React.useState<Application[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = React.useState<string | null>(null);

  // Mirrors inbox/page.tsx's own job_id query-param pattern — lets
  // Inbox's "Add to Pipeline" action deep-link straight into this
  // application's detail panel instead of just landing on the board.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const applicationId = new URLSearchParams(window.location.search).get("application_id");
      if (applicationId && !cancelled) setSelectedId(applicationId);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function openApplication(id: string) {
    setSelectedId(id);
    router.replace(`/pipeline?application_id=${encodeURIComponent(id)}`, { scroll: false });
  }

  function closeApplication() {
    setSelectedId(null);
    router.replace("/pipeline", { scroll: false });
  }

  const [stages, setStages] = React.useState<PipelineStage[]>([]);
  const [manageStagesOpen, setManageStagesOpen] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      const list = await api.listApplications();
      setApplications(list);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load applications");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshStages = React.useCallback(async () => {
    try {
      setStages(await api.listPipelineStages());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load pipeline stages");
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await Promise.all([refresh(), refreshStages()]);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, refreshStages]);

  const stageKeys = React.useMemo(() => new Set(stages.map((s) => s.key)), [stages]);

  const byColumn = React.useMemo(() => {
    const map = new Map<string, Application[]>();
    for (const stage of stages) map.set(stage.key, []);
    // Defensive client-side fallback for a stored state that matches
    // no current stage — shouldn't happen given the delete-block and
    // provisioning on the backend, but a render path needs to handle
    // whatever the API actually returns without crashing or hiding it.
    map.set(UNASSIGNED_COLUMN_KEY, []);
    for (const app of applications) {
      const col = stageKeys.has(app.state) ? app.state : UNASSIGNED_COLUMN_KEY;
      map.get(col)?.push(app);
    }
    return map;
  }, [applications, stages, stageKeys]);

  // Every defined stage is a real column, in the user's own order,
  // plus the "Unassigned" pseudo-column only when it actually has
  // something in it — not a real, creatable/deletable stage, purely a
  // client-side rendering fallback.
  const boardColumns = React.useMemo(() => {
    const cols = stages.map((s) => ({ key: s.key, label: s.display_name }));
    if ((byColumn.get(UNASSIGNED_COLUMN_KEY)?.length ?? 0) > 0) {
      cols.push({ key: UNASSIGNED_COLUMN_KEY, label: "Unassigned" });
    }
    return cols;
  }, [stages, byColumn]);

  async function handleDrop(col: string) {
    const appId = draggingId;
    setDraggingId(null);
    setDragOverCol(null);
    if (!appId) return;
    const app = applications.find((a) => a.id === appId);
    if (!app || app.state === col) return;
    try {
      await api.updateApplication(appId, { state: col });
      await refresh();
    } catch (err) {
      // Rejected by the same validated state machine the dropdown
      // uses (e.g. skipping a required intermediate state) — the card
      // was never optimistically moved, so no revert is needed, just
      // surface why.
      toast.error(err instanceof Error ? err.message : "Transition not allowed");
    }
  }

  async function handleExport() {
    const blob = await api.exportApplications("csv");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "applications.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex h-full">
      <div className="flex flex-col flex-1 min-w-0">
        <header className="h-12 shrink-0 border-b border-border bg-card flex items-center justify-between px-5">
          <span className="text-sm font-semibold">Pipeline</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-mono">{applications.length} applications</span>
            <Button size="sm" variant="outline" onClick={() => setManageStagesOpen(true)}>
              <Settings className="size-3.5" />
              Manage Stages
            </Button>
            <Button size="sm" variant="outline" onClick={handleExport}>
              Export CSV
            </Button>
          </div>
        </header>

        {loading ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground font-mono">
            loading…
          </div>
        ) : applications.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground font-mono text-center px-8">
            No applications yet — create one from a job in the Inbox or Composer.
          </div>
        ) : (
          <div className="flex-1 overflow-x-auto">
            <div className="flex gap-3 p-4 h-full min-w-max">
              {boardColumns.map(({ key: col, label }) => (
                <div
                  key={col}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverCol(col);
                  }}
                  onDragLeave={() => setDragOverCol((cur) => (cur === col ? null : cur))}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleDrop(col);
                  }}
                  className={cn(
                    "flex flex-col w-64 shrink-0 rounded-md transition-colors",
                    dragOverCol === col && "bg-primary/5 ring-1 ring-primary/40",
                  )}
                >
                  <div className="text-xs font-mono font-semibold text-muted-foreground mb-2 px-1">
                    {label} ({byColumn.get(col)?.length ?? 0})
                  </div>
                  <div className="flex flex-col gap-2 overflow-y-auto min-h-8">
                    {(byColumn.get(col) ?? []).map((app) => (
                      <button
                        key={app.id}
                        draggable
                        onDragStart={(e) => {
                          setDraggingId(app.id);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragEnd={() => {
                          setDraggingId(null);
                          setDragOverCol(null);
                        }}
                        onClick={() => openApplication(app.id)}
                        className={cn(
                          "text-left rounded-md border border-border bg-card p-3 text-xs hover:border-primary transition-colors cursor-grab active:cursor-grabbing",
                          selectedId === app.id && "border-primary",
                          draggingId === app.id && "opacity-40",
                        )}
                      >
                        <div className="font-medium truncate">{app.job_title || "(untitled job)"}</div>
                        <div className="text-muted-foreground truncate">{app.company_name || "—"}</div>
                        <div className="mt-1 flex items-center justify-between">
                          <span className="text-[11px] text-muted-foreground">
                            {app.autonomy_level ?? "no autonomy set"}
                          </span>
                          {app.ghosted && <Badge variant="destructive">ghosted</Badge>}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {selectedId && (
        <ApplicationDetailPanel
          applicationId={selectedId}
          onClose={closeApplication}
          onChanged={refresh}
          stages={stages}
        />
      )}

      <ManagePipelineStagesDialog
        open={manageStagesOpen}
        onOpenChange={setManageStagesOpen}
        stages={stages}
        onChanged={async () => {
          await refreshStages();
          await refresh();
        }}
      />
    </div>
  );
}

function ManagePipelineStagesDialog({
  open,
  onOpenChange,
  stages,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stages: PipelineStage[];
  onChanged: () => Promise<void>;
}) {
  const [newName, setNewName] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [busyId, setBusyId] = React.useState<string | null>(null);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await api.createPipelineStage({ display_name: newName.trim() });
      setNewName("");
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add stage");
    } finally {
      setCreating(false);
    }
  }

  async function handleRename(id: string) {
    if (!renameValue.trim()) return;
    try {
      await api.renamePipelineStage(id, { display_name: renameValue.trim() });
      setRenamingId(null);
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to rename stage");
    }
  }

  async function handleDelete(stage: PipelineStage) {
    if (!window.confirm(`Delete the "${stage.display_name}" stage?`)) return;
    setBusyId(stage.id);
    try {
      await api.deletePipelineStage(stage.id);
      await onChanged();
    } catch (e) {
      // The 409 in-use message already names the count — surface it verbatim.
      toast.error(e instanceof Error ? e.message : "Failed to delete stage");
    } finally {
      setBusyId(null);
    }
  }

  async function handleMove(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= stages.length) return;
    const reordered = [...stages];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setBusyId(stages[index].id);
    try {
      await api.reorderPipelineStages(reordered.map((s) => s.id));
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to reorder stages");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pipeline stages</DialogTitle>
          <DialogDescription>
            Your own list — reorder, rename, add, or remove. A stage currently used by an application can&apos;t be
            deleted until you move that application off it first.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 py-2 max-h-[50vh] overflow-y-auto">
          {stages.map((stage, i) => (
            <div key={stage.id} className="flex items-center gap-2 border border-border px-3 py-1.5 text-sm">
              <div className="flex flex-col shrink-0">
                <button
                  type="button"
                  disabled={i === 0 || busyId === stage.id}
                  onClick={() => handleMove(i, -1)}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  <ChevronUp className="size-3.5" />
                </button>
                <button
                  type="button"
                  disabled={i === stages.length - 1 || busyId === stage.id}
                  onClick={() => handleMove(i, 1)}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  <ChevronDown className="size-3.5" />
                </button>
              </div>
              {renamingId === stage.id ? (
                <>
                  <Input
                    className="h-7 flex-1"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    autoFocus
                  />
                  <Button size="sm" onClick={() => handleRename(stage.id)}>
                    Save
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setRenamingId(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{stage.display_name}</div>
                    <div className="text-[10px] font-mono text-muted-foreground truncate">{stage.key}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setRenamingId(stage.id);
                      setRenameValue(stage.display_name);
                    }}
                  >
                    Rename
                  </Button>
                  <Button size="sm" variant="outline" disabled={busyId === stage.id} onClick={() => handleDelete(stage)}>
                    Delete
                  </Button>
                </>
              )}
            </div>
          ))}
          <div className="flex gap-2">
            <Input
              placeholder="e.g. Take-home assignment"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Button size="sm" onClick={handleCreate} disabled={creating || !newName.trim()}>
              Add
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ApplicationDetailPanel({
  applicationId,
  onClose,
  onChanged,
  stages,
}: {
  applicationId: string;
  onClose: () => void;
  onChanged: () => void;
  stages: PipelineStage[];
}) {
  const [detail, setDetail] = React.useState<ApplicationDetail | null>(null);
  const [log, setLog] = React.useState<LogItem[]>([]);
  const [pendingInterrupt, setPendingInterrupt] = React.useState<
    { attemptId: string; requests: InterruptRequest[] } | null
  >(null);
  // Keyed by index into pendingInterrupt.requests — a request can be
  // decided (submit_application's approve/reject) or drafted (a
  // respond-type request's typed answer) independently of the others,
  // since a single batch can now hold more than one hanging call.
  const [decisionDrafts, setDecisionDrafts] = React.useState<Record<number, InterruptDecision>>({});
  const [respondMessage, setRespondMessage] = React.useState("");
  const [running, setRunning] = React.useState(false);

  // F6.7's review-before-submit: the live field-by-field snapshot for
  // whichever session a pending submit_application interrupt names —
  // fetched fresh each time one arrives, since it has to reflect the
  // form's actual current state, not a stale one.
  const [reviewSnapshot, setReviewSnapshot] = React.useState<string | null>(null);
  const [loadingReview, setLoadingReview] = React.useState(false);

  // F6.5/§8.3's Live Browser link: set the moment browser_open's own
  // "browser session opened" stage event comes through (see
  // application_service.py) — that event is a persisted RunEvent like
  // any other, so it's populated the same way whether it arrives live
  // or via reconnect/replay, no separate fallback needed. Taken
  // directly from the event's own attempt_id (every event now carries
  // one) rather than guessed from pendingInterrupt/detail.attempts —
  // the latter is stale/empty for a first-ever attempt that's still
  // running, which previously sent this link to /pipeline/live with an
  // empty attempt_id.
  const [liveBrowser, setLiveBrowser] = React.useState<{ attemptId: string; sessionId: string } | null>(null);

  // Lazily read localStorage in the initializer (not a plain
  // useState(DEFAULT) + effect) so the panel never visibly snaps from
  // the default to the stored width after mount.
  const [panelWidth, setPanelWidth] = React.useState(() => {
    if (typeof window === "undefined") return DEFAULT_PANEL_WIDTH;
    try {
      const stored = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
      return stored >= MIN_PANEL_WIDTH && stored <= MAX_PANEL_WIDTH ? stored : DEFAULT_PANEL_WIDTH;
    } catch {
      return DEFAULT_PANEL_WIDTH;
    }
  });
  const resizeStateRef = React.useRef<{ startX: number; startWidth: number } | null>(null);
  const [resizing, setResizing] = React.useState(false);

  function handleResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    resizeStateRef.current = { startX: e.clientX, startWidth: panelWidth };
    setResizing(true);
  }

  React.useEffect(() => {
    if (!resizing) return;

    function onMouseMove(e: MouseEvent) {
      const start = resizeStateRef.current;
      if (!start) return;
      // The panel sits on the right edge of the screen (border-l) —
      // dragging the handle left (clientX decreasing) should widen it.
      const next = start.startWidth + (start.startX - e.clientX);
      setPanelWidth(Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, next)));
    }
    function onMouseUp() {
      setResizing(false);
      resizeStateRef.current = null;
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [resizing]);

  React.useEffect(() => {
    if (resizing) return; // persist only once a drag settles, not on every pixel of movement
    try {
      window.localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
    } catch {
      // best-effort — a private window or blocked storage just means the
      // width resets to default next session, not worth surfacing
    }
  }, [panelWidth, resizing]);

  const load = React.useCallback(async () => {
    try {
      const d = await api.getApplication(applicationId);
      setDetail(d);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load application");
    }
  }, [applicationId]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  // This panel instance isn't remounted when switching between
  // applications (no `key` prop in the parent) — without this, a
  // previous application's log/pending-interrupt would still be
  // showing while `detail` for the new one is still loading.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) {
        setLog([]);
        setPendingInterrupt(null);
        setDecisionDrafts({});
        setRunning(false);
        setLiveBrowser(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applicationId]);

  function appendLog(item: LogItem) {
    setLog((prev) => [...prev, item]);
  }

  function toLogItem(evt: ApplicationStreamEvent): LogItem {
    if (evt.type === "stage") {
      // "agent"/"message" is the model's own text response — a real
      // chat bubble. Every other stage (preparing started/done, a
      // tool-call name, etc.) is a status notice, not something to
      // present as if the agent "said" it.
      if (evt.stage === "agent" && evt.status === "message") {
        return { kind: "agent", text: evt.message };
      }
      return { kind: "system", text: evt.message };
    }
    if (evt.type === "interrupt") {
      return {
        kind: "system",
        text:
          evt.requests.length === 1
            ? `⏸ waiting on human: ${evt.requests[0].tool}`
            : `⏸ waiting on human: ${evt.requests.length} things at once (${evt.requests.map((r) => r.tool).join(", ")})`,
      };
    }
    if (evt.type === "done") return { kind: "system", text: "✓ run finished" };
    return { kind: "error", text: evt.message };
  }

  // Viewing a *past* attempt's full log (any attempt_number, not just
  // the latest) — every event it ever produced is a durable RunEvent
  // row now (application_service.py's `_emit`), so this is a plain
  // one-shot fetch, no polling needed for an attempt that's long since
  // finished.
  const [viewingAttemptId, setViewingAttemptId] = React.useState<string | null>(null);
  const [viewingAttemptLog, setViewingAttemptLog] = React.useState<LogItem[]>([]);
  const [loadingAttemptLog, setLoadingAttemptLog] = React.useState(false);

  async function toggleAttemptLog(attemptId: string) {
    if (viewingAttemptId === attemptId) {
      setViewingAttemptId(null);
      return;
    }
    setViewingAttemptId(attemptId);
    setLoadingAttemptLog(true);
    try {
      const events = await api.getApplicationAttemptEvents(applicationId, attemptId);
      setViewingAttemptLog(events.map(toLogItem));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load this attempt's log");
      setViewingAttemptLog([]);
    } finally {
      setLoadingAttemptLog(false);
    }
  }

  async function consume(gen: AsyncGenerator<ApplicationStreamEvent>) {
    for await (const evt of gen) {
      appendLog(toLogItem(evt));
      if (evt.type === "stage" && evt.stage === "browser" && evt.status === "session_opened" && evt.session_id && evt.attempt_id) {
        setLiveBrowser({ attemptId: evt.attempt_id, sessionId: evt.session_id });
      }
      if (evt.type === "interrupt") {
        setPendingInterrupt({ attemptId: evt.attempt_id, requests: evt.requests });
        setDecisionDrafts({});
        setRespondMessage("");
        setRunning(false);
        return;
      } else if (evt.type === "done") {
        setPendingInterrupt(null);
        setRunning(false);
        await load();
        onChanged();
        return;
      } else if (evt.type === "error") {
        toast.error(evt.message);
        setRunning(false);
        await load();
        return;
      }
    }
  }

  // Reconnects to an attempt this page instance didn't start live —
  // one still `in_progress`/`awaiting_*` from before a navigation, tab
  // close, or reload. Runs once per loaded application (guarded by the
  // ref, not a dependency the effect re-triggers on): replays every
  // persisted RunEvent through the same `consume()` the live SSE path
  // uses, which naturally reconstructs `pendingInterrupt` if the last
  // event was an interrupt, or keeps polling (pollApplicationAttemptEvents
  // itself loops while the run is active) until it settles. A finished
  // attempt (submitted/abandoned/failed/awaiting_email) is left alone —
  // "Run agent" starts a fresh one, same as always.
  const reconnectedForRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!detail || detail.id !== applicationId) return;
    if (reconnectedForRef.current === applicationId) return;
    reconnectedForRef.current = applicationId;
    const attempt = detail.attempts[0];
    if (!attempt) return;
    const isActive =
      attempt.status === "in_progress" ||
      attempt.status === "awaiting_review" ||
      attempt.status === "awaiting_handoff";
    if (!isActive) return;
    (async () => {
      setRunning(attempt.status === "in_progress");
      await consume(api.pollApplicationAttemptEvents(applicationId, attempt.id));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, applicationId]);

  React.useEffect(() => {
    const req = pendingInterrupt && pendingInterrupt.requests.length === 1 ? pendingInterrupt.requests[0] : null;
    const sessionId = req?.tool === "submit_application" ? (req.args.session_id as string | undefined) : undefined;
    let cancelled = false;
    (async () => {
      if (!sessionId) {
        if (!cancelled) setReviewSnapshot(null);
        return;
      }
      setLoadingReview(true);
      try {
        const { snapshot } = await api.getAttemptLiveSnapshot(applicationId, pendingInterrupt!.attemptId, sessionId);
        if (!cancelled) setReviewSnapshot(snapshot);
      } catch (err) {
        if (!cancelled) {
          setReviewSnapshot(null);
          toast.error(err instanceof Error ? err.message : "Failed to load the field preview");
        }
      } finally {
        if (!cancelled) setLoadingReview(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingInterrupt, applicationId]);

  async function handleRunAgent() {
    setLog([]);
    setRunning(true);
    setLiveBrowser(null);
    await consume(api.streamApply(applicationId));
  }

  async function handleDecisions(decisions: InterruptDecision[]) {
    if (!pendingInterrupt) return;
    setRunning(true);
    const attemptId = pendingInterrupt.attemptId;
    setPendingInterrupt(null);
    setDecisionDrafts({});
    await consume(api.streamResumeApplication(applicationId, attemptId, decisions));
  }

  function setDecisionDraft(index: number, decision: InterruptDecision) {
    setDecisionDrafts((prev) => ({ ...prev, [index]: decision }));
  }

  function handleSendAllDecisions() {
    if (!pendingInterrupt) return;
    const decisions: InterruptDecision[] = pendingInterrupt.requests.map((req, i) => {
      const drafted = decisionDrafts[i];
      if (drafted) return drafted;
      // Same leniency the single-request path always had for
      // browser_request_handoff: an empty box still means "continue."
      // A respond-type request without a typed answer otherwise
      // shouldn't be reachable here — the Send button stays disabled
      // until every non-handoff row has one (see allDecided below).
      return { type: "respond", message: req.tool === "browser_request_handoff" ? "Continue." : "" };
    });
    handleDecisions(decisions);
  }

  function handleOpenEmailDraft(draft: { to: string; subject: string; body: string }) {
    window.location.href =
      `mailto:${draft.to}?subject=${encodeURIComponent(draft.subject)}` +
      `&body=${encodeURIComponent(draft.body)}`;
  }

  async function handleDownloadDocument(docType: "cv" | "cover_letter") {
    try {
      // Same fallback chain the agent's own upload tool uses (an
      // explicit primary document, then this job_group's tailored
      // documents, then the persona's own originally-uploaded CV) — no
      // longer requires a job_group_id (a Composer session) to exist.
      const result = await api.getApplicationDocument(applicationId, docType);
      if (result === null) {
        toast.error(`No ${docType === "cv" ? "CV" : "cover letter"} available for this application`);
        return;
      }
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed");
    }
  }

  async function handleTransition(newState: string) {
    try {
      await api.updateApplication(applicationId, { state: newState });
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Transition failed");
    }
  }

  async function handleMarkApplied() {
    try {
      await api.markApplied(applicationId);
      await load();
      onChanged();
      toast.success("Marked as applied");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  if (!detail) {
    return (
      <div
        style={{ width: panelWidth }}
        className="shrink-0 border-l border-border bg-card p-4 text-sm text-muted-foreground font-mono"
      >
        loading…
      </div>
    );
  }

  // Attempts come back ordered newest-first (attempt_number desc) —
  // see routers/applications.py's get_application.
  const emailDraft = detail.attempts[0]?.email_draft ?? null;

  return (
    <div
      style={{ width: panelWidth }}
      className="relative shrink-0 border-l border-border bg-card flex flex-col h-full"
    >
      <div
        onMouseDown={handleResizeStart}
        className={cn(
          "absolute left-0 top-0 bottom-0 w-1.5 -translate-x-1/2 cursor-col-resize z-10",
          "hover:bg-primary/40",
          resizing && "bg-primary/60",
        )}
      />
      <div className="h-12 shrink-0 border-b border-border flex items-center justify-between px-4 gap-2 min-w-0">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{detail.job_title || "(untitled job)"}</div>
          <div className="text-[11px] text-muted-foreground truncate">{detail.company_name || "—"}</div>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} className="shrink-0">
          Close
        </Button>
      </div>

      <div className="p-4 flex flex-col gap-4 overflow-y-auto flex-1">
        <div>
          <div className="text-xs text-muted-foreground mb-1">State</div>
          <Select value={detail.state} onValueChange={handleTransition}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {stages.map((s) => (
                <SelectItem key={s.id} value={s.key}>
                  {s.display_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex gap-2 flex-wrap">
          <Button size="sm" onClick={handleRunAgent} disabled={running || !!pendingInterrupt}>
            {running ? "Running…" : pendingInterrupt ? "Awaiting your input above" : "Run agent"}
          </Button>
          <Button size="sm" variant="outline" onClick={handleMarkApplied}>
            Mark applied
          </Button>
          {liveBrowser && (running || !!pendingInterrupt) && (
            <Button size="sm" variant="outline" asChild>
              <a
                href={`/pipeline/live?application_id=${encodeURIComponent(applicationId)}&attempt_id=${encodeURIComponent(
                  liveBrowser.attemptId,
                )}&session_id=${encodeURIComponent(liveBrowser.sessionId)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Watch live browser ↗
              </a>
            </Button>
          )}
        </div>

        {pendingInterrupt && pendingInterrupt.requests.length === 1 && (
          <div className="rounded-md border border-warn bg-warn/10 p-3 text-xs space-y-2">
            <div className="font-semibold">
              {pendingInterrupt.requests[0].tool === "submit_application"
                ? "Waiting on you: review before submit"
                : pendingInterrupt.requests[0].tool === "ask_user"
                  ? "The agent needs an answer from you"
                  : "Waiting on you: handle this in the browser"}
            </div>
            <div className="text-muted-foreground whitespace-pre-wrap">
              {pendingInterrupt.requests[0].description}
            </div>
            {pendingInterrupt.requests[0].tool === "submit_application" ? (
              <div className="space-y-2">
                {(() => {
                  const reviewAttempt = detail.attempts.find((a) => a.id === pendingInterrupt.attemptId);
                  const hasScreenshot = (reviewAttempt?.screenshot_keys.length ?? 0) > 0;
                  return (hasScreenshot || loadingReview || reviewSnapshot) ? (
                    <div className="space-y-2">
                      <div className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                        Review before you approve
                      </div>
                      {hasScreenshot && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={api.attemptScreenshotUrl(applicationId, pendingInterrupt.attemptId, -1)}
                          alt="Screenshot of the form right before submit"
                          className="w-full rounded border border-border"
                        />
                      )}
                      <div className="rounded-md border border-border bg-background p-2 text-[10px] font-mono whitespace-pre-wrap max-h-40 overflow-y-auto">
                        {loadingReview
                          ? "loading every field's current value…"
                          : (reviewSnapshot ?? "live field preview unavailable — the description above is all there is")}
                      </div>
                    </div>
                  ) : null;
                })()}
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => handleDecisions([{ type: "approve" }])}>
                    Approve submit
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => handleDecisions([{ type: "reject" }])}>
                    Reject
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Textarea
                  placeholder={
                    pendingInterrupt.requests[0].tool === "ask_user"
                      ? "Type your answer…"
                      : "Handle the login/captcha in the browser, then tell the agent it can continue…"
                  }
                  value={respondMessage}
                  onChange={(e) => setRespondMessage(e.target.value)}
                  rows={2}
                />
                <Button
                  size="sm"
                  onClick={() =>
                    handleDecisions([{ type: "respond", message: respondMessage || "Continue." }])
                  }
                >
                  {pendingInterrupt.requests[0].tool === "ask_user" ? "Send answer" : "Continue"}
                </Button>
              </div>
            )}
          </div>
        )}

        {pendingInterrupt && pendingInterrupt.requests.length > 1 && (
          <div className="rounded-md border border-warn bg-warn/10 p-3 text-xs space-y-3">
            <div className="font-semibold">
              The agent needs {pendingInterrupt.requests.length} things from you at once
            </div>
            {pendingInterrupt.requests.map((req, i) => {
              const isSubmit = req.tool === "submit_application";
              const isHandoff = req.tool === "browser_request_handoff";
              const draft = decisionDrafts[i];
              return (
                <div key={i} className="border-t border-warn/30 pt-2 first:border-t-0 first:pt-0 space-y-1.5">
                  <div className="text-muted-foreground whitespace-pre-wrap">{req.description}</div>
                  {isSubmit ? (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant={draft?.type === "approve" ? "default" : "outline"}
                        onClick={() => setDecisionDraft(i, { type: "approve" })}
                      >
                        {draft?.type === "approve" ? "Approve ✓" : "Approve submit"}
                      </Button>
                      <Button
                        size="sm"
                        variant={draft?.type === "reject" ? "destructive" : "outline"}
                        onClick={() => setDecisionDraft(i, { type: "reject" })}
                      >
                        {draft?.type === "reject" ? "Reject ✓" : "Reject"}
                      </Button>
                    </div>
                  ) : (
                    <Textarea
                      placeholder={isHandoff ? "Handle this in the browser, or leave blank to continue…" : "Type your answer…"}
                      value={draft?.type === "respond" ? (draft.message ?? "") : ""}
                      onChange={(e) => setDecisionDraft(i, { type: "respond", message: e.target.value })}
                      rows={2}
                    />
                  )}
                </div>
              );
            })}
            <Button
              size="sm"
              onClick={handleSendAllDecisions}
              disabled={pendingInterrupt.requests.some((req, i) => {
                if (req.tool === "browser_request_handoff") return false;
                const draft = decisionDrafts[i];
                if (req.tool === "submit_application") return !draft;
                return !draft || draft.type !== "respond" || !draft.message?.trim();
              })}
            >
              Send all answers
            </Button>
          </div>
        )}

        {!pendingInterrupt && emailDraft && (
          <div className="rounded-md border border-border bg-secondary p-3 text-xs space-y-2">
            <div className="font-semibold">
              This job has no online form — apply by email
            </div>
            <div className="space-y-1 text-muted-foreground">
              <div>
                <span className="text-foreground">To: </span>
                {emailDraft.to}
              </div>
              <div>
                <span className="text-foreground">Subject: </span>
                {emailDraft.subject}
              </div>
              <div className="whitespace-pre-wrap border border-border bg-background p-2 mt-1 max-h-32 overflow-y-auto">
                {emailDraft.body}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" onClick={() => handleOpenEmailDraft(emailDraft)}>
                Open in email app
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleDownloadDocument("cv")}>
                Download CV
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleDownloadDocument("cover_letter")}>
                Download cover letter
              </Button>
            </div>
            <div className="text-[10px] text-muted-foreground">
              Attachments are manual — a mailto: link can&apos;t attach files. Download the PDFs above
              and drag them into the compose window that opens.
            </div>
          </div>
        )}

        {(log.length > 0 || running) && (
          <div>
            <div className="text-xs text-muted-foreground mb-2">Agent</div>
            <ChatLog items={log} typing={running} />
          </div>
        )}

        <div>
          <div className="text-xs text-muted-foreground mb-2">Timeline</div>
          <div className="space-y-2">
            {detail.events.map((e) => (
              <div key={e.id} className="text-xs border-l-2 border-border pl-2">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Badge variant="outline" className="text-[9px]">
                    {e.actor}
                  </Badge>
                  <span className="font-mono">{timestamp(e.occurred_at)}</span>
                </div>
                <div>{e.event_type}</div>
              </div>
            ))}
          </div>
        </div>

        {detail.attempts.length > 0 && (
          <div>
            <div className="text-xs text-muted-foreground mb-2">Attempts</div>
            <div className="space-y-2">
              {detail.attempts.map((a) => (
                <div key={a.id} className="text-xs rounded border border-border p-2">
                  <button
                    type="button"
                    onClick={() => toggleAttemptLog(a.id)}
                    className={cn(
                      "flex w-full justify-between items-center gap-2 -m-2 mb-0 rounded-t p-2 text-left cursor-pointer",
                      "hover:bg-secondary active:bg-secondary/80 transition-colors",
                      viewingAttemptId === a.id && "bg-secondary rounded-b-none",
                    )}
                  >
                    <span className="flex items-center gap-1.5 font-medium">
                      {viewingAttemptId === a.id ? (
                        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                      )}
                      #{a.attempt_number}
                      <span className="text-primary underline underline-offset-2">
                        {viewingAttemptId === a.id ? "hide log" : "view log"}
                      </span>
                    </span>
                    <Badge variant="outline">{a.status}</Badge>
                  </button>
                  {a.error && <div className="text-crit mt-1">{a.error}</div>}
                  {a.screenshot_keys.length > 0 && (
                    <div className="text-muted-foreground mt-1">
                      {a.screenshot_keys.length} screenshot(s) captured
                    </div>
                  )}
                  {viewingAttemptId === a.id && (
                    <div className="mt-2">
                      {loadingAttemptLog ? (
                        <div className="text-muted-foreground text-[10px] font-mono">loading…</div>
                      ) : viewingAttemptLog.length === 0 ? (
                        <div className="text-muted-foreground text-[10px] font-mono">
                          no persisted log for this attempt — it predates event logging
                        </div>
                      ) : (
                        <ChatLog items={viewingAttemptLog} />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
