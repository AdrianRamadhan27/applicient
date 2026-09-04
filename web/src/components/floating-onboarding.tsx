"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import confetti from "canvas-confetti";
import { api, ONBOARDING_CHANGED_EVENT, type OnboardingProgress } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { Check, ChevronRight, Circle, X } from "lucide-react";

// Phase 16 — the onboarding checklist built earlier this session
// (originally a card inside the Dashboard's Overview tab) relocated to
// a globally-mounted floating widget, following FloatingAssistant's
// own convention exactly (mounted once in app-shell.tsx, a `fixed`
// circular trigger + an expandable panel) so it's visible from
// anywhere, not just the Dashboard — raised directly by Adrian.
// Positioned directly ABOVE the Assistant's own button (bottom-5,
// size-14/56px) rather than beside it, per the same ask.

// Deliberately a NEW key, not the old dashboard-card widget's
// "applicient.onboarding-dismissed" — that one predates this floating
// version; reusing it would silently inherit a dismissal made against
// a completely different (bigger, more intrusive) piece of UI, which
// is exactly why this widget seemed to have vanished after the earlier
// card was tried and dismissed during testing.
//
// Both keys are scoped by user id (Adrian, direct: dismissing/
// celebrating on one account made the widget vanish for every OTHER
// account on the same browser too) — a bare, unscoped key is shared
// browser-wide localStorage, so testing with a second user inherited
// the first user's dismissal. Real per-viewer state has to mean
// per-user, not per-browser, since several users can share one.
const ONBOARDING_DISMISSED_KEY = (userId: string) => `applicient.onboarding-floating-dismissed.${userId}`;
const ONBOARDING_CELEBRATED_KEY = (userId: string) => `applicient.onboarding-celebrated.${userId}`;
// Good-enough "real time" without instrumenting every action site
// across the app to explicitly notify this widget — a 30s poll plus a
// refetch on every route change (a cheap, already-available signal
// that something the user just did probably changed).
const POLL_INTERVAL_MS = 30_000;

function readLocalFlag(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeLocalFlag(key: string) {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // best-effort — a per-viewer convenience, not data that needs to persist reliably
  }
}

function OnboardingDonut({ completed, total, size = 34 }: { completed: number; total: number; size?: number }) {
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = total > 0 ? completed / total : 0;
  const dash = circumference * fraction;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--primary-foreground)" strokeWidth={stroke} opacity={0.3} />
        {dash > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--primary-foreground)"
            strokeWidth={stroke}
            strokeDasharray={`${dash} ${circumference - dash}`}
            strokeLinecap={fraction < 1 ? "round" : "butt"}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center font-mono text-[9px] font-semibold text-primary-foreground">
        {completed}/{total}
      </div>
    </div>
  );
}

export function FloatingOnboarding() {
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [progress, setProgress] = React.useState<OnboardingProgress | null>(null);
  const [open, setOpen] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);
  const celebratedRef = React.useRef(false);

  // Re-derive both flags once we actually know which user this is —
  // can't read them at useState-init time the way the old bare-key
  // version did, since a per-user key needs the user id first.
  React.useEffect(() => {
    (() => {
      if (!userId) return;
      setDismissed(readLocalFlag(ONBOARDING_DISMISSED_KEY(userId)));
      celebratedRef.current = readLocalFlag(ONBOARDING_CELEBRATED_KEY(userId));
    })();
  }, [userId]);

  const refresh = React.useCallback(async () => {
    if (!userId) return;
    try {
      const next = await api.getOnboardingProgress();
      setProgress(next);
      if (next.completed === next.total && !celebratedRef.current) {
        celebratedRef.current = true;
        writeLocalFlag(ONBOARDING_CELEBRATED_KEY(userId));
        void confetti({ particleCount: 140, spread: 80, origin: { x: 0.85, y: 0.85 } });
      }
    } catch {
      // best-effort — a getting-started checklist isn't worth an error toast
    }
  }, [userId]);

  React.useEffect(() => {
    (async () => {
      await refresh();
    })();
    const interval = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    // Adrian, direct: "same way credits dont update real time, the
    // onboarding progression doesnt update real time" — api.ts's own
    // ONBOARDING_CHANGED_EVENT fires right after any request that
    // could plausibly have just completed a step (creating a persona,
    // saving preferences, parsing/adding evidence, tailoring a CV,
    // creating a saved search/application/calendar event/interview
    // session), so this refetches immediately instead of waiting on
    // the poll above — same pattern app-shell.tsx's credit chip uses.
    const onChanged = () => void refresh();
    window.addEventListener(ONBOARDING_CHANGED_EVENT, onChanged);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(ONBOARDING_CHANGED_EVENT, onChanged);
    };
  }, [refresh]);

  // Cheap "something probably changed" signal — refetch whenever the
  // route changes, on top of the plain interval above.
  React.useEffect(() => {
    (async () => {
      await refresh();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  function handleDismiss(e: React.MouseEvent) {
    e.stopPropagation();
    setDismissed(true);
    if (userId) writeLocalFlag(ONBOARDING_DISMISSED_KEY(userId));
  }

  function goTo(href: string) {
    setOpen(false);
    router.push(href);
  }

  if (!userId || dismissed || !progress) return null;

  const allDone = progress.completed === progress.total;

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-[88px] right-5 z-40 flex size-14 items-center justify-center rounded-full border border-border bg-primary text-primary-foreground shadow-md hover:bg-primary/80"
        title={allDone ? "Onboarding complete" : "Getting started"}
      >
        <OnboardingDonut completed={progress.completed} total={progress.total} />
      </button>

      {open && (
        <div className="fixed bottom-[152px] right-5 z-40 flex max-h-[70vh] w-80 max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden border border-border bg-card shadow-lg">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2.5">
            <span className="text-sm font-semibold">
              {allDone ? "You've completed onboarding!" : "Get started with Applicient"}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <button onClick={handleDismiss} className="text-muted-foreground hover:text-foreground" title="Dismiss">
                <X className="size-3.5" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {allDone ? (
              <div className="flex flex-col items-center gap-3 py-4 text-center">
                <span className="text-4xl">🎉</span>
                <p className="text-xs text-muted-foreground">
                  You&apos;ve used every feature in the loop — discovery, tailoring, applying, and interview practice.
                </p>
                <Link
                  href="/console/billing"
                  onClick={() => setOpen(false)}
                  className="mt-1 inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/80"
                >
                  Consider upgrading
                </Link>
              </div>
            ) : (
              <ul className="flex flex-col gap-1">
                {progress.steps.map((step) => {
                  const content = (
                    <>
                      {step.done ? (
                        <Check className="size-3.5 shrink-0 text-ok" />
                      ) : (
                        <Circle className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className={cn("truncate", step.done && "text-muted-foreground line-through")}>
                        {step.label}
                      </span>
                      {!step.done && <ChevronRight className="ml-auto size-3 shrink-0 text-muted-foreground" />}
                    </>
                  );
                  const className = cn(
                    "flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors",
                    step.done ? "text-muted-foreground" : "hover:bg-accent/60",
                  );
                  if (step.key === "persona" || step.key === "cv") {
                    // Both dialogs are page-local (Dashboard's own
                    // OverviewPanel state) and unreachable from this
                    // globally-mounted widget — land on /console
                    // instead, which already shows a prominent
                    // create-persona prompt when there's none, and
                    // supports ?tab=profile for the CV step.
                    return (
                      <li key={step.key}>
                        <button
                          type="button"
                          className={cn(className, "w-full")}
                          onClick={() => goTo(step.key === "cv" ? "/console?tab=profile" : "/console")}
                        >
                          {content}
                        </button>
                      </li>
                    );
                  }
                  if (!step.href || step.done) {
                    return (
                      <li key={step.key} className={className}>
                        {content}
                      </li>
                    );
                  }
                  return (
                    <li key={step.key}>
                      <Link href={step.href} className={className} onClick={() => setOpen(false)}>
                        {content}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}
