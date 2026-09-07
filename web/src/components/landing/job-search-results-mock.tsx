"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

// Replaces the old chat-style job-search mock — Adrian, direct: "make it
// be like a search element being typed then jobs 1 by 1 show up with
// scores and recommendations" (the chat framing moved to the hero's own
// HeroChatMock instead). A real-looking search bar types out a query
// character by character, then each result streams in with a score and a
// one-line reason — no chat bubbles here. Self-contained, hardcoded, and
// hand-timed rather than built on useAutoSequence's uniform interval,
// since typing needs finer-grained, variable-speed timing than a plain
// step counter gives.

const QUERY = "backend engineer in jakarta";
const CHAR_MS = 55;
const AFTER_TYPE_PAUSE_MS = 400;
const SEARCHING_MS = 900;
const JOB_STAGGER_MS = 750;
const HOLD_MS = 3500;

const JOBS: { title: string; company: string; score: number; rank: "ok" | "warn" | "muted"; reason: string }[] = [
  {
    title: "Backend Engineer",
    company: "Acme Corp",
    score: 92,
    rank: "ok",
    reason: "Strong match — your backend experience lines up directly with the role.",
  },
  {
    title: "Platform Engineer",
    company: "Northwind",
    score: 85,
    rank: "ok",
    reason: "Good match — your infrastructure background covers most requirements.",
  },
  {
    title: "Software Engineer II",
    company: "Globex",
    score: 61,
    rank: "warn",
    reason: "Partial match — missing the Kubernetes experience this role asks for.",
  },
  {
    title: "Data Engineer",
    company: "Initech",
    score: 38,
    rank: "muted",
    reason: "Weak match — this role skews toward data pipelines, not your focus.",
  },
];

const RANK_CLASSES: Record<string, string> = { ok: "text-ok", warn: "text-warn", muted: "text-muted-foreground" };
const RANK_DOT_CLASSES: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", muted: "bg-muted-foreground" };

type Phase = "typing" | "searching" | "revealing" | "done";

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function useTypedSearch() {
  const [typed, setTyped] = React.useState(() => (prefersReducedMotion() ? QUERY.length : 0));
  const [phase, setPhase] = React.useState<Phase>(() => (prefersReducedMotion() ? "done" : "typing"));
  const [visibleJobs, setVisibleJobs] = React.useState(() => (prefersReducedMotion() ? JOBS.length : 0));

  React.useEffect(() => {
    if (prefersReducedMotion()) return;

    let cancelled = false;
    const timeouts: number[] = [];
    const schedule = (fn: () => void, delay: number) => {
      const id = window.setTimeout(() => {
        if (!cancelled) fn();
      }, delay);
      timeouts.push(id);
    };

    function run() {
      setTyped(0);
      setPhase("typing");
      setVisibleJobs(0);

      for (let i = 1; i <= QUERY.length; i++) {
        schedule(() => setTyped(i), i * CHAR_MS);
      }
      const afterTyping = QUERY.length * CHAR_MS + AFTER_TYPE_PAUSE_MS;
      schedule(() => setPhase("searching"), afterTyping);
      schedule(() => setPhase("revealing"), afterTyping + SEARCHING_MS);
      JOBS.forEach((_, i) => {
        schedule(() => setVisibleJobs(i + 1), afterTyping + SEARCHING_MS + (i + 1) * JOB_STAGGER_MS);
      });
      const doneAt = afterTyping + SEARCHING_MS + JOBS.length * JOB_STAGGER_MS;
      schedule(() => setPhase("done"), doneAt);
      schedule(run, doneAt + HOLD_MS);
    }
    run();

    return () => {
      cancelled = true;
      timeouts.forEach((id) => window.clearTimeout(id));
    };
  }, []);

  return { typed, phase, visibleJobs };
}

export function JobSearchResultsMock() {
  const { typed, phase, visibleJobs } = useTypedSearch();

  return (
    <div className="flex h-[460px] flex-col gap-4 p-6 text-left">
      <div className="flex items-center gap-2.5 border border-border px-3.5 py-3">
        <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <span className="flex-1 truncate font-mono text-sm">
          {QUERY.slice(0, typed)}
          {phase === "typing" && <span className="anim-fade-cycle ml-px inline-block h-4 w-px bg-foreground align-middle" />}
        </span>
      </div>

      {phase === "searching" && (
        <span className="anim-fade-cycle font-mono text-xs text-muted-foreground">
          Searching Greenhouse, Lever, Ashby, Workable…
        </span>
      )}

      {(phase === "revealing" || phase === "done") && (
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {JOBS.slice(0, visibleJobs).map((job) => (
            <div key={job.title} className="flex animate-in fade-in-0 flex-col gap-1 border border-border px-3.5 py-3">
              <div className="flex items-center gap-2">
                <span className={cn("size-2 shrink-0", RANK_DOT_CLASSES[job.rank])} />
                <span className="flex-1 truncate text-sm font-medium">{job.title}</span>
                <span className="shrink-0 truncate font-mono text-xs text-muted-foreground">{job.company}</span>
                <span className={cn("shrink-0 font-mono text-sm font-semibold tabular-nums", RANK_CLASSES[job.rank])}>
                  {job.score}
                </span>
              </div>
              <p className="pl-4 text-xs text-muted-foreground">{job.reason}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
