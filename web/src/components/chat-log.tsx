import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, User } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConversationCard } from "@/lib/api";
import {
  JobsCard,
  DocumentCard,
  ApplicationCard,
  CalendarEventCard,
  DocumentsCard,
  InterviewSessionCard,
} from "@/components/chat-cards";

// Promoted out of pipeline/page.tsx (M7) so the Assistant chat page
// can reuse the exact same bubble rendering — the agent's own text
// reads like a real chat message, everything else (stage start/done,
// interrupts, run completion) renders as a small centered pill, same
// convention chat apps use for "user joined"/"call ended" style events.
// "user" is new here — Pipeline never needed to render the human's own
// words back, since its only input is a fixed interrupt-response box;
// the Assistant page's whole point is a real back-and-forth.
//
// "card" (M7.1) is the other new kind — a tool result the model itself
// sees is always plain text, but a card lets a tool ALSO hand the
// frontend something structured (a scored job list, a tailored
// document, a running application) to render as a real embed instead
// of collapsing everything into prose. See chat-cards.tsx.
export type LogItem =
  | { kind: "agent" | "user" | "system" | "error"; text: string }
  | { kind: "card"; card: ConversationCard };

// The model's own replies are markdown (confirmed live: tables, bold,
// lists) — rendered here rather than shown as raw asterisks/pipes.
// Small custom overrides instead of @tailwindcss/typography (not
// installed) sized to match this bubble's existing text-xs styling.
const MARKDOWN_COMPONENTS = {
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-1.5 last:mb-0">{children}</p>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="mb-1.5 list-disc pl-4 space-y-0.5">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="mb-1.5 list-decimal pl-4 space-y-0.5">{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li>{children}</li>,
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-semibold">{children}</strong>,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="rounded bg-background px-1 py-0.5 font-mono text-[11px]">{children}</code>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => <h1 className="mb-1 text-sm font-semibold">{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className="mb-1 text-sm font-semibold">{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className="mb-1 text-xs font-semibold">{children}</h3>,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="mb-1.5 overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-border px-1.5 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => <td className="border border-border px-1.5 py-1">{children}</td>,
};

function AgentMarkdown({ text }: { text: string }) {
  return (
    <div className="text-xs [&>*:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function CardBubble({ card }: { card: ConversationCard }) {
  if (card.card_type === "jobs") return <JobsCard card={card} />;
  if (card.card_type === "document") return <DocumentCard card={card} />;
  if (card.card_type === "calendar_event") return <CalendarEventCard card={card} />;
  if (card.card_type === "documents") return <DocumentsCard card={card} />;
  if (card.card_type === "interview_session") return <InterviewSessionCard card={card} />;
  return <ApplicationCard card={card} />;
}

export function ChatLog({
  items,
  typing,
  className,
}: {
  items: LogItem[];
  typing?: boolean;
  className?: string;
}) {
  const bottomRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [items, typing]);

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border bg-background p-3 max-h-64 overflow-y-auto",
        className,
      )}
    >
      {items.map((item, i) =>
        item.kind === "agent" ? (
          <div key={i} className="flex items-start gap-2">
            <div className="flex items-center justify-center size-6 shrink-0 rounded-full bg-primary/10 text-primary">
              <Bot className="size-3.5" />
            </div>
            <div className="rounded-lg rounded-tl-none bg-secondary px-3 py-2 max-w-[85%]">
              <AgentMarkdown text={item.text} />
            </div>
          </div>
        ) : item.kind === "user" ? (
          <div key={i} className="flex items-start justify-end gap-2">
            <div className="rounded-lg rounded-tr-none bg-primary text-primary-foreground px-3 py-2 text-xs whitespace-pre-wrap max-w-[85%]">
              {item.text}
            </div>
            <div className="flex items-center justify-center size-6 shrink-0 rounded-full bg-primary/10 text-primary">
              <User className="size-3.5" />
            </div>
          </div>
        ) : item.kind === "card" ? (
          <div key={i} className="flex items-start gap-2">
            <div className="flex items-center justify-center size-6 shrink-0 rounded-full bg-primary/10 text-primary">
              <Bot className="size-3.5" />
            </div>
            <CardBubble card={item.card} />
          </div>
        ) : (
          <div
            key={i}
            className={cn(
              "text-center text-[10px] font-mono",
              item.kind === "error" ? "text-crit" : "text-muted-foreground",
            )}
          >
            {item.text}
          </div>
        ),
      )}
      {typing && (
        <div className="flex items-start gap-2">
          <div className="flex items-center justify-center size-6 shrink-0 rounded-full bg-primary/10 text-primary">
            <Bot className="size-3.5" />
          </div>
          <div className="flex items-center gap-1 rounded-lg rounded-tl-none bg-secondary px-3 py-2.5">
            <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.3s]" />
            <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.15s]" />
            <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce" />
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
