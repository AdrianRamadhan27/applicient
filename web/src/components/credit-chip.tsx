import { Coins } from "lucide-react";
import { cn } from "@/lib/utils";

// Adrian, direct: "it should have contrasting background with white
// text for the amount and the coin should be like yellow/gold" — both
// the sidebar balance (app-shell.tsx) and every per-feature cost badge
// (credit-cost-badge.tsx) render through this one component so the
// look can never drift apart between the two.
//
// Background is `bg-primary` (the site's own blue accent token, NOT a
// hardcoded hex) per a direct follow-up — an invented blue "felt out
// of place" next to the real brand color everywhere else in the app.
// `--primary` already has its own light/dark values (globals.css),
// which is exactly what fixes the earlier near-black version's real
// problem too: it disappeared into a dark theme's own background.
// `text-white`/`text-amber-400` stay hardcoded, not theme tokens —
// the ask was specifically for white text and a gold coin, in both
// themes, not `primary-foreground` (which flips to near-black text in
// dark mode to pair with THAT mode's brighter blue).
export function CreditChip({
  children,
  size = "sm",
  className,
  title,
}: {
  children: React.ReactNode;
  size?: "sm" | "xs";
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 bg-primary font-mono font-semibold text-white",
        size === "sm" ? "px-1.5 py-0.5 text-[11px]" : "px-1 py-px text-[10px]",
        className,
      )}
      title={title}
    >
      <Coins className={cn("shrink-0 text-amber-400", size === "sm" ? "size-3" : "size-2.5")} strokeWidth={2} />
      {children}
    </span>
  );
}
