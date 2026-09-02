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
import type { LogItem } from "@/components/chat-log";

// Phase 15 (v2 plan) — the Assistant's live conversation state, lifted
// out of assistant/page.tsx into a provider mounted once above all
// routing (layout.tsx), so the SSE stream this owns keeps running
// (and keeps updating this state) across page navigation instead of
// being torn down whenever /console/assistant happens to unmount —
// raised directly by Adrian: switching away mid-stream and back left
// the chat looking frozen even though the backend run was still
// genuinely progressing (confirmed by a manual reload showing further
// progress the frozen UI never displayed). Also backs the floating
// chat overlay (app-shell.tsx) — both surfaces render the exact same
// live state from here, never their own separate copy of it.

function toLogItem(evt: ConversationStreamEvent): LogItem | null {
  if (evt.type === "message") {
    return { kind: "user", text: evt.text };
  }
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
  if (evt.type === "cancelled") return { kind: "system", text: "⏹ stopped" };
  if (evt.type === "card") {
    return { kind: "card", card: evt as unknown as ConversationCard };
  }
  return { kind: "error", text: evt.message };
}

// run_application_agent's own card can legitimately fire twice (once
// with just attempt_id, again once a browser session opens) — this
// replaces the previous application card for the same application_id
// in place instead of appending a second, near-duplicate-looking one.
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

// A friendly opener for a conversation with no messages yet (raised by
// Adrian) — purely local, never sent to the backend or written as a
// RunEvent, so it only ever appears while the conversation is
// genuinely empty: the moment a real "message"/"stage" event exists
// (this conversation's own or replayed from history), that event list
// is what renders instead, not this constant.
const GREETING_LOG: LogItem[] = [
  { kind: "agent", text: "Hello, I'm Applicient AI — what can I help you with?" },
];

export function conversationLabel(convo: Conversation): string {
  if (convo.title) return convo.title;
  return new Date(convo.created_at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type ConversationContextValue = {
  conversations: Conversation[];
  conversationId: string | null;
  log: LogItem[];
  pendingInterrupt: InterruptRequest[] | null;
  running: boolean;
  cancelling: boolean;
  loadingHistory: boolean;
  selectConversation: (id: string) => Promise<void>;
  newChat: () => Promise<void>;
  archiveConversation: (id: string) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  respond: (message: string) => Promise<void>;
  cancelRun: () => Promise<void>;
};

const ConversationContext = React.createContext<ConversationContextValue | null>(null);

export function ConversationProvider({ children }: { children: React.ReactNode }) {
  const { selectedPersonaId } = usePersona();
  const [conversations, setConversations] = React.useState<Conversation[]>([]);
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const [log, setLog] = React.useState<LogItem[]>([]);
  const [pendingInterrupt, setPendingInterrupt] = React.useState<InterruptRequest[] | null>(null);
  const [running, setRunning] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [loadingHistory, setLoadingHistory] = React.useState(true);

  const loadConversationHistory = React.useCallback(async (id: string) => {
    const { events, pendingInterrupt: pending, runStatus } = await api.getConversationEvents(id);
    const replayed = events.reduce<LogItem[]>((acc, evt) => {
      const item = toLogItem(evt);
      return item ? appendLogItem(acc, item) : acc;
    }, []);
    setLog(replayed.length > 0 ? replayed : GREETING_LOG);
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

  async function selectConversation(id: string) {
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

  async function newChat() {
    if (!selectedPersonaId || running) return;
    try {
      const convo = await api.createConversation(selectedPersonaId);
      setConversations((prev) => [convo, ...prev]);
      setConversationId(convo.id);
      setLog(GREETING_LOG);
      setPendingInterrupt(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start a new chat");
    }
  }

  async function archiveConversation(id: string) {
    try {
      await api.archiveConversation(id);
      const remaining = conversations.filter((c) => c.id !== id);
      setConversations(remaining);
      if (id === conversationId) {
        if (remaining[0]) {
          await selectConversation(remaining[0].id);
        } else {
          await newChat();
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
      } else if (evt.type === "cancelled") {
        setPendingInterrupt(null);
        setRunning(false);
        setCancelling(false);
        return;
      } else if (evt.type === "error") {
        toast.error(evt.message);
        setRunning(false);
        setCancelling(false);
        return;
      }
    }
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !conversationId || running || pendingInterrupt) return;
    // No optimistic local push here — the backend now writes the
    // human's own message as the very first event of the stream (a
    // real, persisted RunEvent, not just something this component
    // remembers), and `consume` below renders it from that same event
    // a moment later. That's also why it now survives a reload or a
    // switch to another conversation and back (raised by Adrian: saved
    // chats used to only ever show the AI's half).
    setRunning(true);
    await consume(api.streamOrchestratorMessage(conversationId, trimmed));
  }

  async function respond(message: string) {
    if (!conversationId || !pendingInterrupt) return;
    const text = message.trim() || "Continue.";
    setPendingInterrupt(null);
    setRunning(true);
    await consume(api.streamOrchestratorResume(conversationId, [{ type: "respond", message: text }]));
  }

  async function cancelRun() {
    if (!conversationId || !running) return;
    setCancelling(true);
    try {
      await api.cancelOrchestratorRun(conversationId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to stop");
      setCancelling(false);
    }
  }

  return (
    <ConversationContext.Provider
      value={{
        conversations,
        conversationId,
        log,
        pendingInterrupt,
        running,
        cancelling,
        loadingHistory,
        selectConversation,
        newChat,
        archiveConversation,
        sendMessage,
        respond,
        cancelRun,
      }}
    >
      {children}
    </ConversationContext.Provider>
  );
}

export function useConversation(): ConversationContextValue {
  const ctx = React.useContext(ConversationContext);
  if (!ctx) throw new Error("useConversation must be used within a ConversationProvider");
  return ctx;
}
