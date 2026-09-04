"use client";

import * as React from "react";
import { usePersona } from "@/components/persona-provider";
import { useConversation, conversationLabel } from "@/lib/conversation-provider";
import { ChatLog } from "@/components/chat-log";
import { InterruptPanel } from "@/components/interrupt-panel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Plus, Square, X } from "lucide-react";

// M7 — the conversational orchestrator's own chat page. M7.1 added a
// real conversation list/switcher (raised directly: a conversation
// stuck on a pending decision needs a real "start over" escape hatch,
// not just the one auto-resolved thread this page used to have) —
// "New chat" always creates a genuinely fresh one; the sidebar lists
// every active one for the current persona, most-recently-active
// first; archiving hides a stuck one without deleting its history.
//
// Phase 15 (v2 plan) — the live conversation itself (log, running
// state, the SSE stream) now lives in ConversationProvider, mounted
// once above all routing, so it survives navigating away and back
// (previously looked frozen — see that provider's own comment) and is
// the same state the floating chat overlay renders. This page is just
// one of two surfaces for it, plus the conversation list/switcher
// sidebar and the message-composer input, both of which stay page-local.
export default function AssistantPage() {
  const { selectedPersona, loading: personaLoading } = usePersona();
  const {
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
    cancelRun,
  } = useConversation();
  const [draft, setDraft] = React.useState("");

  async function handleSend() {
    const text = draft;
    setDraft("");
    await sendMessage(text);
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
          <Button size="sm" variant="outline" className="w-full gap-1.5" onClick={newChat}>
            <Plus className="size-3.5" />
            New chat
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
          {conversations.map((convo) => (
            <button
              key={convo.id}
              onClick={() => selectConversation(convo.id)}
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
                onClick={(e) => {
                  e.stopPropagation();
                  archiveConversation(convo.id);
                }}
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

        <InterruptPanel />

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
          {running ? (
            <Button variant="destructive" onClick={cancelRun} disabled={cancelling}>
              <Square className="size-3.5 fill-current" />
              {cancelling ? "Stopping…" : "Stop"}
            </Button>
          ) : (
            <Button onClick={handleSend} disabled={!!pendingInterrupt || !draft.trim() || !conversationId}>
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
