"use client";

import * as React from "react";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAutoSequence } from "./use-auto-sequence";

// A scripted, looping walkthrough of the real claim-verifier flow, staged
// inside an actual mock résumé excerpt (Adrian, direct: "need like a
// sample cv or like a mock cv (html not pdf) of like John Doe" — not
// isolated bullet rows with no context). Two example bullets: one that
// survives the verifier, one that doesn't. Nothing here calls the real
// API; clicking a bullet only toggles a local highlight.

const STEP_INTERVAL_MS = 2000;
// 0 originals shown, 1 tailored diffs revealed, 2 "verifying" badges,
// 3 claim 1 resolves (SUPPORTED), 4 claim 2 resolves (UNSUPPORTED), loop.
const STEP_COUNT = 5;

const CLAIMS = [
  {
    before: "Worked on backend services for the payments team.",
    after: "Rebuilt the payments retry pipeline, cutting failed-charge recovery time by 40%.",
    verdict: "SUPPORTED" as const,
    resolveStep: 3,
  },
  {
    before: "Helped with team communication.",
    after: "Led cross-functional communication across 5 teams, driving strategic alignment.",
    verdict: "UNSUPPORTED" as const,
    resolveStep: 4,
  },
];

function VerdictBadge({ verdict }: { verdict: "SUPPORTED" | "UNSUPPORTED" }) {
  const ok = verdict === "SUPPORTED";
  return (
    <span
      className={cn(
        "flex w-fit animate-in fade-in-0 items-center gap-1 border px-2.5 py-1 font-mono text-xs",
        ok ? "border-ok bg-ok-bg text-ok" : "border-crit bg-crit-bg text-crit",
      )}
    >
      {ok ? <Check className="size-3" /> : <X className="size-3" />}
      {verdict}
    </span>
  );
}

export function CvVerifierMock() {
  const { step, pause, resume } = useAutoSequence(STEP_COUNT, STEP_INTERVAL_MS);
  const [selected, setSelected] = React.useState<number | null>(null);

  return (
    <div className="flex h-[460px] flex-col gap-3 p-6 text-left" onMouseEnter={pause} onMouseLeave={resume}>
      <div className="flex-1 overflow-y-auto border border-border bg-background p-5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="border-b border-border pb-3">
          <h3 className="text-base font-semibold">John Doe</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Backend Engineer · john.doe@example.com · Jakarta, Indonesia
          </p>
        </div>
        <div className="mt-4">
          <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Experience</span>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium">Software Engineer, Acme Corp</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">2022 — Present</span>
          </div>
          <ul className="mt-3 flex flex-col gap-4">
            {CLAIMS.map((claim, i) => (
              <li
                key={claim.before}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected(i);
                }}
                className={cn(
                  "flex list-disc flex-col items-start gap-2 border px-3 py-2.5 marker:text-muted-foreground",
                  selected === i ? "border-primary bg-secondary/40" : "border-transparent hover:border-border hover:bg-secondary/20",
                )}
              >
                <p className="text-sm text-muted-foreground line-through decoration-crit/60">{claim.before}</p>
                {step >= 1 && <p className="animate-in fade-in-0 text-sm">{claim.after}</p>}
                {step >= 2 && step < claim.resolveStep && (
                  <span className="anim-fade-cycle font-mono text-xs text-muted-foreground">Verifier checking…</span>
                )}
                {step >= claim.resolveStep && <VerdictBadge verdict={claim.verdict} />}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {step >= CLAIMS[1].resolveStep && (
        <p className="animate-in fade-in-0 text-xs text-muted-foreground">
          Unsupported claims block export until they&apos;re fixed or removed.
        </p>
      )}
    </div>
  );
}
