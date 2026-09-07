"use client";

import * as React from "react";
import { Mail } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAutoSequence } from "./use-auto-sequence";
import { useDragColumns } from "./use-drag-columns";

// A scripted, looping walkthrough of the real inbox -> pipeline flow — an
// email arrives, gets labeled, and the matching application card slides
// into its new column automatically. Adrian, direct: "user should be able
// to drag each job item" — so cards are also freely draggable between
// columns at any time; dragging pauses the script (same pause-on-interact
// idiom every other mock uses) and hands control to the drag state until
// the mouse leaves, at which point it resyncs to wherever the script
// currently sits and resumes.

const STEP_INTERVAL_MS = 2200;

type CardId = "acme" | "initech";
type Column = "Applied" | "Interview" | "Rejected";

const CARD_LABEL: Record<CardId, string> = {
  acme: "Backend Engineer @ Acme",
  initech: "Data Engineer @ Initech",
};

// Each beat: which email is "unread" in the inbox strip, its detected
// label (once revealed), and where each card currently sits.
const STEPS: {
  email: { card: CardId; subject: string; label: string | null } | null;
  columns: Record<CardId, Column>;
}[] = [
  { email: null, columns: { acme: "Applied", initech: "Applied" } },
  {
    email: { card: "acme", subject: "Interview invite — Acme Corp", label: null },
    columns: { acme: "Applied", initech: "Applied" },
  },
  {
    email: { card: "acme", subject: "Interview invite — Acme Corp", label: "Interview detected" },
    columns: { acme: "Applied", initech: "Applied" },
  },
  {
    email: { card: "acme", subject: "Interview invite — Acme Corp", label: "Interview detected" },
    columns: { acme: "Interview", initech: "Applied" },
  },
  {
    email: { card: "initech", subject: "Thanks for applying — Initech", label: null },
    columns: { acme: "Interview", initech: "Applied" },
  },
  {
    email: { card: "initech", subject: "Thanks for applying — Initech", label: "Rejection detected" },
    columns: { acme: "Interview", initech: "Applied" },
  },
  {
    email: { card: "initech", subject: "Thanks for applying — Initech", label: "Rejection detected" },
    columns: { acme: "Interview", initech: "Rejected" },
  },
];

const COLUMNS: Column[] = ["Applied", "Interview", "Rejected"];

export function PipelineTrackingMock() {
  const { step, pause, resume } = useAutoSequence(STEPS.length, STEP_INTERVAL_MS);
  const { columns, setColumns, dragHandlers, dropHandlers, dragOverColumn } = useDragColumns<Column>(STEPS[0].columns);
  const [selected, setSelected] = React.useState<CardId | null>(null);
  // While true, `columns` is under manual drag control rather than being
  // driven by the script's own `step` — set on drop, cleared on mouse-leave.
  const manualRef = React.useRef(false);
  const current = STEPS[step];

  React.useEffect(() => {
    if (!manualRef.current) setColumns(current.columns);
    // current.columns is a new object identity each render of the same
    // step, so depend on `step` itself, not the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, setColumns]);

  function handleMouseLeave() {
    manualRef.current = false;
    setColumns(STEPS[step].columns);
    resume();
  }

  return (
    <div className="flex h-[460px] flex-col gap-4 p-6 text-left" onMouseEnter={pause} onMouseLeave={handleMouseLeave}>
      <div className="flex min-h-[52px] items-center gap-2.5 border border-border bg-secondary/30 px-4 py-3">
        <Mail className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        {current.email ? (
          <div key={current.email.subject} className="flex flex-1 animate-in fade-in-0 items-center justify-between gap-2">
            <span className="truncate text-sm">{current.email.subject}</span>
            {current.email.label && (
              <span
                className={cn(
                  "shrink-0 animate-in fade-in-0 border px-2 py-0.5 font-mono text-xs",
                  current.email.label.startsWith("Interview") ? "border-ok bg-ok-bg text-ok" : "border-crit bg-crit-bg text-crit",
                )}
              >
                {current.email.label}
              </span>
            )}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">Inbox — no new mail</span>
        )}
      </div>

      <div className="grid flex-1 grid-cols-3 gap-3">
        {COLUMNS.map((col) => {
          const drop = dropHandlers(col);
          return (
            <div
              key={col}
              onDragOver={drop.onDragOver}
              onDragLeave={drop.onDragLeave}
              onDrop={(e) => {
                manualRef.current = true;
                pause();
                drop.onDrop(e);
              }}
              className={cn(
                "flex flex-col gap-2 border border-dashed p-1.5",
                dragOverColumn === col ? "border-primary bg-primary/5" : "border-transparent",
              )}
            >
              <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">{col}</span>
              <div className="flex min-h-12 flex-col gap-2">
                {(Object.keys(CARD_LABEL) as CardId[])
                  .filter((card) => columns[card] === col)
                  .map((card) => (
                    <div
                      key={card}
                      {...dragHandlers(card)}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected(card);
                      }}
                      className={cn(
                        "cursor-grab animate-in fade-in-0 select-none border px-3 py-3 text-left text-xs leading-snug active:cursor-grabbing",
                        selected === card ? "border-primary bg-secondary/60" : "border-border bg-secondary/30 hover:bg-secondary/50",
                      )}
                    >
                      {CARD_LABEL[card]}
                    </div>
                  ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
