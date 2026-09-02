import type { Recommendation } from "@/lib/api";

// Originally local to inbox/page.tsx — extracted so the Dashboard
// Overview's "top discovered jobs" card can render the exact same
// recommendation label/color as the Job Inbox list itself, instead of
// a second copy of this mapping drifting out of sync with it.
export const RECOMMENDATION_LABEL: Record<Recommendation | "unscored", string> = {
  strong_apply: "strong apply",
  apply: "apply",
  stretch: "stretch",
  skip: "skip",
  unscored: "unscored",
};

export function recommendationColor(rec: Recommendation | "unscored") {
  switch (rec) {
    case "strong_apply":
    case "apply":
      return "bg-ok-bg text-ok";
    case "stretch":
      return "bg-warn-bg text-warn";
    case "skip":
      return "bg-crit-bg text-crit";
    default:
      return "bg-muted text-muted-foreground";
  }
}
