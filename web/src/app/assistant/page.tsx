"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  api,
  type Conversation,
  type ConversationCard,
  type ConversationStreamEvent,
  type InterruptRequest,
} from "@/lib/api";
import { usePersona } from "@/components/persona-provider";
import { ChatLog, type LogItem } from "@/components/chat-log";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Plus, X } from "lucide-react";

// M7 — the conversational orchestrator's own chat page. M7.1 added a
// real conversation list/switcher (raised directly: a conversation
// stuck on a pending decision needs a real "start over" escape hatch,
// not just the one auto-resolved thread this page used to have) —
// "New chat" always creates a genuinely fresh one; the sidebar lists
// every active one for the current persona, most-recently-active
// first; archiving hides a stuck one without deleting its history.
function toLogItem(evt: ConversationStreamEvent): LogItem | null {
  if (evt.type === "stage") {
    if (evt.stage === "agent" && evt.status === "message") {
      return { kind: "agent", text: evt.message };
    }
    return { kind: "system", text: evt.message };
  }
  if (evt.type === "interrupt") {
    return { kind: "system", text: "⏸ waiting on your answer" };
  }
  if (evt.type === "done") return null;
  if (evt.type === "card") {
    return { kind: "card", card: evt as unknown as ConversationCard };
  }
  return { kind: "error", text: evt.message };
}

// run_application_agent's own card can legitimately fire twice (once
// with just attempt_id, again once a browser session opens) — this
// replaces the previous application card for the same application_id
// in place instead of appending a second, near-duplicate-looking one.
// Jobs/document cards are one-shot, so they never match here.
function appendLogItem(prev: LogItem[], item: LogItem): LogItem[] {
  if (item.kind === "card" && item.card.card_type === "application") {
    const last = prev[prev.length - 1];
    if (
      last &&
      last.kind === "card" &&
      last.card.card_type === "application" &&
      last.card.application_id === item.card.application_id
    ) {
      return [...prev.slice(0, -1), item];
    }
  }
  return [...prev, item];
}

function conversationLabel(convo: Conversation): string {
  if (convo.title) return convo.title;
  return new Date(convo.created_at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AssistantPage() {
  const { selectedPersonaId, selectedPersona, loading: personaLoading } = usePersona();
  const [conversations, setConversations] = React.useState<Conversation[]>([]);
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const [log, setLog] = React.useState<LogItem[]>([]);
  const [pendingInterrupt, setPendingInterrupt] = React.useState<InterruptRequest[] | null>(null);
  const [respondMessage, setRespondMessage] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [loadingHistory, setLoadingHistory] = React.useState(true);
  const [draft, setDraft] = React.useState("");

  const loadConversationHistory = React.useCallback(async (id: string) => {
    const { events, pendingInterrupt: pending, runStatus } = await api.getConversationEvents(id);
    setLog(
      events.reduce<LogItem[]>((acc, evt) => {
        const item = toLogItem(evt);
        return item ? appendLogItem(acc, item) : acc;
      }, []),
    );
    setPendingInterrupt(pending?.requests ?? null);
    if (runStatus === "running") {
      toast.message("A previous message from this conversation is still processing — give it a moment and reload.");
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!selectedPersonaId) return;
      setLoadingHistory(true);
      setConversationId(null);
      setLog([]);
      setPendingInterrupt(null);
      try {
        const list = (await api.listConversations(selectedPersonaId)).filter((c) => c.status === "active");
        const current = list[0] ?? (await api.createConversation(selectedPersonaId));
        if (cancelled) return;
        setConversations(list[0] ? list : [current]);
        setConversationId(current.id);
        await loadConversationHistory(current.id);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : "Failed to load the assistant conversation");
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPersonaId, loadConversationHistory]);

  async function handleSelectConversation(id: string) {
    if (id === conversationId || running) return;
    setConversationId(id);
    setLog([]);
    setPendingInterrupt(null);
    setLoadingHistory(true);
    try {
      await loadConversationHistory(id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load this conversation");
    } finally {
      setLoadingHistory(false);
    }
  }

  async function handleNewChat() {
    if (!selectedPersonaId || running) return;
    try {
      const convo = await api.createConversation(selectedPersonaId);
      setConversations((prev) => [convo, ...prev]);
      setConversationId(convo.id);
      setLog([]);
      setPendingInterrupt(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start a new chat");
    }
  }

  async function handleArchive(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await api.archiveConversation(id);
      const remaining = conversations.filter((c) => c.id !== id);
      setConversations(remaining);
      if (id === conversationId) {
        if (remaining[0]) {
          await handleSelectConversation(remaining[0].id);
        } else {
          await handleNewChat();
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to archive this conversation");
    }
  }

  async function consume(gen: AsyncGenerator<ConversationStreamEvent>) {
    for await (const evt of gen) {
      const item = toLogItem(evt);
      if (item) setLog((prev) => appendLogItem(prev, item));
      if (evt.type === "interrupt") {
        setPendingInterrupt(evt.requests);
        setRunning(false);
        return;
      } else if (evt.type === "done") {
        setPendingInterrupt(null);
        setRunning(false);
        return;
      } else if (evt.type === "error") {
        toast.error(evt.message);
        setRunning(false);
        return;
      }
    }
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || !conversationId || running || pendingInterrupt) return;
    setDraft("");
    setLog((prev) => [...prev, { kind: "user", text }]);
    setRunning(true);
    await consume(api.streamOrchestratorMessage(conversationId, text));
  }

  async function handleRespond() {
    if (!conversationId || !pendingInterrupt) return;
    const message = respondMessage.trim() || "Continue.";
    setRespondMessage("");
    setPendingInterrupt(null);
    setRunning(true);
    await consume(api.streamOrchestratorResume(conversationId, [{ type: "respond", message }]));
  }

  if (personaLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground font-mono">
        loading…
      </div>
    );
  }

  if (!selectedPersona) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground font-mono text-center px-8">
        No persona selected — create one from the sidebar first.
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="w-56 shrink-0 border-r border-border bg-card flex flex-col">
        <div className="p-2 border-b border-border">
          <Button size="sm" variant="outline" className="w-full gap-1.5" onClick={handleNewChat}>
            <Plus className="size-3.5" />
            New chat
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
          {conversations.map((convo) => (
            <button
              key={convo.id}
              onClick={() => handleSelectConversation(convo.id)}
              className={cn(
                "group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                convo.id === conversationId ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
              )}
            >
              <span className="flex-1 min-w-0 truncate">{conversationLabel(convo)}</span>
              {convo.pending_interrupt && <span className="shrink-0 text-warn" title="waiting on your answer">⏸</span>}
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => handleArchive(convo.id, e)}
                className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-crit transition-opacity"
                title="Archive this conversation"
              >
                <X className="size-3" />
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex h-full flex-1 flex-col max-w-3xl mx-auto w-full">
        <header className="h-12 shrink-0 border-b border-border bg-card flex items-center px-5">
          <span className="text-sm font-semibold">Assistant</span>
          <span className="ml-2 text-xs text-muted-foreground font-mono">for {selectedPersona.name}</span>
        </header>

        {loadingHistory ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground font-mono">
            loading…
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            <ChatLog items={log} typing={running} className="max-h-none min-h-full" />
          </div>
        )}

        {pendingInterrupt && pendingInterrupt.length > 0 && (
          <div className="shrink-0 border-t border-warn bg-warn/10 p-3 mx-4 mb-2 rounded-md text-xs space-y-2">
            <div className="font-semibold">The assistant needs an answer from you</div>
            <div className="text-muted-foreground whitespace-pre-wrap">{pendingInterrupt[0].description}</div>
            <div className="flex gap-2">
              <Textarea
                placeholder="Type your answer…"
                value={respondMessage}
                onChange={(e) => setRespondMessage(e.target.value)}
                rows={2}
                className="flex-1"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleRespond();
                  }
                }}
              />
              <Button size="sm" onClick={handleRespond}>
                Send answer
              </Button>
            </div>
          </div>
        )}

        <div className="shrink-0 border-t border-border bg-card p-3 flex items-center gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              pendingInterrupt
                ? "Answer the question above first…"
                : "Tell the assistant what kind of job you want, or just say hi…"
            }
            rows={1}
            disabled={running || !!pendingInterrupt || !conversationId}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            className="flex-1 resize-none"
          />
          <Button onClick={handleSend} disabled={running || !!pendingInterrupt || !draft.trim() || !conversationId}>
            {running ? "Working…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}
