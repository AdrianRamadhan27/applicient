"use client";

import * as React from "react";
import Link from "next/link";
import { useConversation } from "@/lib/conversation-provider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Coins } from "lucide-react";

// Phase 16 follow-up (Adrian, direct): "for each feature it tries to
// call that requires credits it should ask confirmation... needs to
// have a status dialog or popup when [the human doesn't] have enough
// credits... in the assistant as well." The platform-enforced side of
// this lives in orchestrator_service.py/orchestrator_agent.py (a real
// interrupt now blocks tool execution, not just a system-prompt ask);
// this component is the one shared render for whatever that interrupt
// turns out to be, used by both the full /console/assistant page and
// the floating overlay so the branching logic (ask_user vs a credit
// approve/reject vs genuinely insufficient) exists exactly once.
//
// Must match orchestrator_service.py's INSUFFICIENT_CREDITS_SENTINEL
// exactly — action_requests only carries {tool, args, description}
// (langgraph's own ActionRequest shape has no room for a real
// structured `insufficient: bool` flag), so a recognizable string
// prefix is how that signal actually crosses the wire.
const INSUFFICIENT_CREDITS_SENTINEL = "INSUFFICIENT_CREDITS|";

export function InterruptPanel({ compact = false }: { compact?: boolean }) {
  const { pendingInterrupt, respond, approve, reject } = useConversation();
  const [respondMessage, setRespondMessage] = React.useState("");

  if (!pendingInterrupt || pendingInterrupt.length === 0) return null;

  const request = pendingInterrupt[0];

  async function handleRespond() {
    const message = respondMessage;
    setRespondMessage("");
    await respond(message);
  }

  // ask_user is the only interrupt that's a real open-ended question
  // — everything else this platform interrupts on (see
  // _CREDIT_GATED_TOOLS) is a fixed yes/no credit spend, never free text.
  if (request.tool === "ask_user") {
    return (
      <div
        className={cn(
          "shrink-0 space-y-2 rounded-md border-t border-warn bg-warn/10 text-xs",
          compact ? "mx-3 mb-2 p-2.5" : "mx-4 mb-2 rounded-md border p-3",
        )}
      >
        <div className="font-semibold">The assistant needs an answer from you</div>
        <div className="whitespace-pre-wrap text-muted-foreground">{request.description}</div>
        <div className="flex gap-1.5">
          <Textarea
            placeholder="Type your answer…"
            value={respondMessage}
            onChange={(e) => setRespondMessage(e.target.value)}
            rows={2}
            className={cn("flex-1", compact && "text-xs")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleRespond();
              }
            }}
          />
          <Button size="sm" onClick={handleRespond}>
            Send
          </Button>
        </div>
      </div>
    );
  }

  if (request.description.startsWith(INSUFFICIENT_CREDITS_SENTINEL)) {
    const [, label, cost, balance] = request.description.split("|");
    return (
      <div
        className={cn(
          "shrink-0 space-y-2 rounded-md border-t border-crit bg-crit/10 text-xs",
          compact ? "mx-3 mb-2 p-2.5" : "mx-4 mb-2 rounded-md border p-3",
        )}
      >
        <div className="flex items-center gap-1.5 font-semibold">
          <Coins className="size-3.5 shrink-0" />
          Not enough credits
        </div>
        <div className="text-muted-foreground">
          {label} costs {cost} credits, but you only have {balance}. Upgrade your plan or buy more credits to
          continue.
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => void reject()}>
            Cancel
          </Button>
          <Button size="sm" asChild>
            <Link href="/console/billing">Go to Billing</Link>
          </Button>
        </div>
      </div>
    );
  }

  // A real, affordable credit spend — a genuine yes/no, never free text.
  return (
    <div
      className={cn(
        "shrink-0 space-y-2 rounded-md border-t border-warn bg-warn/10 text-xs",
        compact ? "mx-3 mb-2 p-2.5" : "mx-4 mb-2 rounded-md border p-3",
      )}
    >
      <div className="flex items-center gap-1.5 font-semibold">
        <Coins className="size-3.5 shrink-0" />
        This will use credits
      </div>
      <div className="whitespace-pre-wrap text-muted-foreground">{request.description}</div>
      <div className="flex gap-1.5">
        <Button size="sm" variant="outline" onClick={() => void reject()}>
          Reject
        </Button>
        <Button size="sm" onClick={() => void approve()}>
          Approve
        </Button>
      </div>
    </div>
  );
}
