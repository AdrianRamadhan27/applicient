import * as React from "react";

// Shared timer driving every landing-page mock's scripted, looping sequence
// (the hero dashboard's counters, the job-search chat demo's script beats).
// Same "pause on hover/interaction, resume after" idiom page.tsx's own
// HighlightCarousel already established, and the same prefers-reduced-motion
// guard its auto-advance effect already uses — factored out here since two
// mocks need the exact same behavior rather than two copies of it.
export function useAutoSequence(stepCount: number, intervalMs: number, options?: { loop?: boolean }) {
  // Adrian, direct: "the chat in the hero shouldnt loop. Unless
  // refreshed" — so HeroChatMock passes loop:false; every other mock
  // (job-search results, CV verifier, pipeline tracking, auto-apply)
  // keeps the default looping behavior.
  const loop = options?.loop ?? true;

  // Under prefers-reduced-motion, settle immediately on the LAST step
  // (the fully-played-out state) rather than sitting frozen on the first
  // beat — a visitor with motion reduced should still see the finished
  // conversation/dashboard, just not the animation getting there.
  const [step, setStep] = React.useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? stepCount - 1
      : 0,
  );
  const [paused, setPaused] = React.useState(false);

  React.useEffect(() => {
    if (paused) return;
    if (stepCount <= 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      setStep((s) => {
        const next = s + 1;
        if (next < stepCount) return next;
        if (loop) return 0;
        // Reached the end of a non-looping sequence — stop advancing
        // entirely (not just holding on the last step every tick).
        window.clearInterval(id);
        return s;
      });
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [paused, stepCount, intervalMs, loop]);

  const pause = React.useCallback(() => setPaused(true), []);
  const resume = React.useCallback(() => setPaused(false), []);
  // Jumps straight to a step (e.g. clicking a specific sidebar tab) and
  // pauses — same "don't fight a visitor who's actively interacting"
  // idiom as pause/resume, just triggered by a click instead of hover.
  // Callers typically resume() on mouse-leave to pick the cycle back up.
  const goTo = React.useCallback((n: number) => {
    setStep(n);
    setPaused(true);
  }, []);

  return { step, paused, pause, resume, goTo };
}
