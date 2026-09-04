"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { useConversation, conversationLabel } from "@/lib/conversation-provider";
import { usePersona } from "@/components/persona-provider";
import { ChatLog } from "@/components/chat-log";
import { InterruptPanel } from "@/components/interrupt-panel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BotMessageSquare, ChevronDown, Plus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";

// Phase 15 (v2 plan) — reachable from anywhere, not just the
// dedicated /console/assistant page. Renders the exact same live
// state ConversationProvider owns (see that file's own comment) — a
// message sent here shows up on the full page too, and vice versa,
// since there's only ever one copy of the conversation state, not a
// second one this component keeps for itself.
//
// A docked right-side panel, not a modal Dialog (raised by Adrian) —
// no backdrop, nothing blocks interacting with whatever page is open
// behind it; only an explicit close (the X, or reopening the floating
// button) hides it, so it reads as a persistent side panel rather
// than an overlay you have to dismiss before doing anything else.
export function FloatingAssistant() {
  const pathname = usePathname();
  const { selectedPersona } = usePersona();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");
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
    sendMessage,
    cancelRun,
  } = useConversation();

  // The full page already IS this exact conversation — no floating
  // button there, and if the panel was left open from another page,
  // close it the moment navigation lands here instead of showing the
  // same conversation twice, side by side.
  const onAssistantPage = pathname === "/console/assistant";
  React.useEffect(() => {
    if (onAssistantPage) (() => setOpen(false))();
  }, [onAssistantPage]);

  if (!selectedPersona) return null;

  const currentConvo = conversations.find((c) => c.id === conversationId) ?? null;

  async function handleSend() {
    const text = draft;
    setDraft("");
    await sendMessage(text);
  }

  return (
    <>
      {!onAssistantPage && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="fixed bottom-5 right-5 z-40 flex size-14 items-center justify-center rounded-full border border-border bg-primary text-primary-foreground shadow-md hover:bg-primary/80"
          title="Open Assistant"
        >
          <BotMessageSquare className="size-7" />
        </button>
      )}

      <div
        className={cn(
          "fixed top-0 right-0 z-50 flex h-screen w-full max-w-sm flex-col border-l border-border bg-card shadow-lg transition-transform duration-200",
          open && !onAssistantPage ? "translate-x-0" : "translate-x-full",
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex min-w-0 items-center gap-1.5 text-sm font-semibold hover:text-primary">
                <span className="truncate">{currentConvo ? conversationLabel(currentConvo) : "Assistant"}</span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
              {conversations.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No conversations yet</div>
              ) : (
                conversations.map((convo) => (
                  <DropdownMenuItem
                    key={convo.id}
                    onSelect={() => selectConversation(convo.id)}
                    className={cn(
                      "justify-between gap-2",
                      convo.id === conversationId && "bg-accent text-accent-foreground",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{conversationLabel(convo)}</span>
                    {convo.pending_interrupt && (
                      <span className="shrink-0 text-warn" title="waiting on your answer">
                        ⏸
                      </span>
                    )}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="icon-sm" variant="ghost" onClick={newChat} title="New chat">
              <Plus className="size-3.5" />
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={() => setOpen(false)} title="Close">
              <X className="size-3.5" />
            </Button>
          </div>
        </div>

        {loadingHistory ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground font-mono">
            loading…
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto p-3">
            <ChatLog items={log} typing={running} className="max-h-none min-h-full" />
          </div>
        )}

        <InterruptPanel compact />

        <div className="flex shrink-0 items-center gap-2 border-t border-border p-2.5">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={pendingInterrupt ? "Answer above first…" : "Ask the assistant…"}
            rows={1}
            disabled={running || !!pendingInterrupt || !conversationId}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            className="flex-1 resize-none text-sm"
          />
          {running ? (
            <Button size="sm" variant="destructive" onClick={cancelRun} disabled={cancelling} title="Stop">
              <Square className="size-3 fill-current" />
            </Button>
          ) : (
            <Button size="sm" onClick={handleSend} disabled={!!pendingInterrupt || !draft.trim() || !conversationId}>
              Send
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
