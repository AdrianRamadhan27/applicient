"use client";

import * as React from "react";
import { Hand } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAutoSequence } from "./use-auto-sequence";

// A scripted, looping walkthrough of the real auto-apply flow — the agent
// fills each field one at a time, then stops right before Submit. Clicking
// Submit doesn't actually submit anything (there's nothing behind this
// landing page to submit to) — it just briefly reinforces the same "held
// for your review" promise the real app makes.

const STEP_INTERVAL_MS = 1400;

const FIELDS = [
  { label: "Full name", value: "Alex Rivera" },
  { label: "Email", value: "alex.rivera@example.com" },
  { label: "Resume", value: "resume_tailored.pdf" },
  { label: "Cover letter", value: "cover_letter.pdf" },
  { label: "Why this role?", value: "Rebuilt the payments retry pipeline…" },
];

// One step per field filling in, then a final "stopped at submit" step.
const STEP_COUNT = FIELDS.length + 1;
const STOPPED_STEP = FIELDS.length;

export function AutoApplyMock() {
  const { step, pause, resume } = useAutoSequence(STEP_COUNT, STEP_INTERVAL_MS);
  const [pressed, setPressed] = React.useState(false);

  function handleSubmitClick() {
    setPressed(true);
    window.setTimeout(() => setPressed(false), 1200);
  }

  return (
    <div className="flex h-[460px] flex-col gap-4 p-6 text-left" onMouseEnter={pause} onMouseLeave={resume}>
      <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
        Applying — Backend Engineer @ Acme Corp
      </span>
      <div className="flex flex-1 flex-col gap-3">
        {FIELDS.map((field, i) => (
          <div key={field.label} className="flex flex-col gap-1 border border-border px-3 py-2.5">
            <span className="font-mono text-[11px] text-muted-foreground">{field.label}</span>
            {i <= step ? (
              <span className="animate-in fade-in-0 truncate text-sm">{field.value}</span>
            ) : (
              <span className="h-4 w-2/3 bg-secondary/60" />
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <button
          onClick={handleSubmitClick}
          disabled={step < STOPPED_STEP}
          className={cn(
            "border px-4 py-2 font-mono text-xs",
            step >= STOPPED_STEP ? "border-primary text-primary hover:bg-primary/10" : "border-border text-muted-foreground",
            pressed && "bg-primary/10",
          )}
        >
          Submit application
        </button>
        {step >= STOPPED_STEP && (
          <div className="flex animate-in fade-in-0 items-center gap-2 border border-warn bg-warn-bg px-3 py-1.5">
            <Hand className="anim-float size-4 shrink-0 text-warn" strokeWidth={1.5} />
            <span className="font-mono text-xs text-warn">
              {pressed ? "Held for your review" : "waiting for your review"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
