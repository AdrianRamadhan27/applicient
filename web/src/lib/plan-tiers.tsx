import type * as React from "react";
import { Crown, Medal, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Shared between app-shell.tsx (next to the signed-in user's own
// name/email) and admin/users/page.tsx (per-row, every tenant's own
// plan) — keyed by the real Plan.name (see the rename/reprice
// migration in api/migrations), not a hardcoded enum, so renaming a
// plan in the admin Plan CRUD screen just stops matching rather than
// breaking. The free tier (Open to Work) intentionally has no entry —
// nothing to decorate. Real "silver"/"gold" hex, not a semantic
// design-system token — matches the deliberate one-off-brand-color
// precedent already set for platform logos in radar/page.tsx, for the
// same reason: this needs to actually read as silver/gold at a
// glance, not just as another muted/warn-toned UI element.
export const TIER_DECORATION: Record<string, { icon: LucideIcon; color: string; label: string }> = {
  Unemployed: { icon: Medal, color: "#C0C0C0", label: "Unemployed tier" },
  "Super Unemployed": { icon: Crown, color: "#D4AF37", label: "Super Unemployed tier" },
};

export function tierColor(planName: string | null | undefined): string | undefined {
  return planName ? TIER_DECORATION[planName]?.color : undefined;
}

export function TierIcon({
  planName,
  className = "size-3.5",
  showTitle,
}: {
  planName: string | null | undefined;
  className?: string;
  showTitle?: string;
}) {
  const deco = planName ? TIER_DECORATION[planName] : undefined;
  if (!deco) return null;
  const Icon = deco.icon;
  return (
    <Icon
      className={cn("shrink-0", className)}
      style={{ color: deco.color }}
      aria-label={deco.label}
      {...(showTitle !== undefined ? ({ title: showTitle } as { title: string }) : {})}
    />
  );
}

// Icon + name, both in the tier's own color — the usual pairing
// everywhere a plan's name is actually displayed as text (as opposed
// to app-shell.tsx's sidebar, where the visible text is the user's
// email, not the plan name, so that one colors the email directly
// instead of using this). Falls back to plain, uncolored text (still
// wrapped the same way, so callers don't need a separate branch) when
// the plan has no decoration.
export function TierLabel({
  planName,
  children,
  className,
  iconClassName = "size-3.5",
}: {
  planName: string | null | undefined;
  // Overrides the displayed text (e.g. a "—" fallback for a null
  // plan_name) while `planName` still drives which decoration/color
  // applies — defaults to `planName` itself when omitted.
  children?: React.ReactNode;
  className?: string;
  iconClassName?: string;
}) {
  const deco = planName ? TIER_DECORATION[planName] : undefined;
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      style={deco ? { color: deco.color } : undefined}
    >
      {deco && <deco.icon className={cn("shrink-0", iconClassName)} aria-label={deco.label} />}
      {children ?? planName}
    </span>
  );
}
