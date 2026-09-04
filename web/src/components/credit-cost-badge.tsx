"use client";

import * as React from "react";
import { api, CREDITS_CHANGED_EVENT, type FeatureCreditCost } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Coins } from "lucide-react";

// Phase 16 follow-up (Adrian, direct): "there is no credit indicator"
// on any credit-gated feature — a real, standing gap, not just a
// perception issue. This is the one small component every gated
// action's own button/panel drops in next to itself, so the cost is
// visible BEFORE the user commits, not just discoverable after the
// fact from the transaction log. A single module-level cache (not a
// context/provider — this never changes mid-session, admin edits
// aside) means dropping five of these on one page costs one real
// fetch, not five.
let costsCache: FeatureCreditCost[] | null = null;
let costsInflight: Promise<FeatureCreditCost[]> | null = null;

function useFeatureCosts(): FeatureCreditCost[] | null {
  const [costs, setCosts] = React.useState<FeatureCreditCost[] | null>(costsCache);
  React.useEffect(() => {
    if (costsCache) return;
    if (!costsInflight) {
      costsInflight = api.listFeatureCosts().then(
        (c) => {
          costsCache = c;
          return c;
        },
        () => {
          costsInflight = null;
          return [];
        },
      );
    }
    let cancelled = false;
    costsInflight.then((c) => {
      if (!cancelled) setCosts(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return costs;
}

// Per-user, unlike the plain price list above — "true" means this
// user's NEXT use of that feature is genuinely free
// (credit_ledger.py's own first-use-free rule). Adrian, direct: "when
// its the free first time thing, it should say so in the credits cost
// tag beside the feature." Cached the same way, but also refetched on
// CREDITS_CHANGED_EVENT (unlike the flat cost list, THIS can flip from
// true to false mid-session the moment the user actually uses the
// feature once — a stale "Free (first use)" badge after it's already
// been used would be actively misleading, not just outdated).
let firstUseCache: Record<string, boolean> | null = null;
let firstUseInflight: Promise<Record<string, boolean>> | null = null;

function useFirstUseStatus(): Record<string, boolean> | null {
  const [status, setStatus] = React.useState<Record<string, boolean> | null>(firstUseCache);

  const load = React.useCallback(() => {
    firstUseInflight = api.getFirstUseStatus().then(
      (s) => {
        firstUseCache = s;
        setStatus(s);
        return s;
      },
      () => {
        firstUseInflight = null;
        return {};
      },
    );
    return firstUseInflight;
  }, []);

  React.useEffect(() => {
    if (!firstUseCache && !firstUseInflight) {
      void load();
    } else if (firstUseInflight) {
      let cancelled = false;
      firstUseInflight.then((s) => {
        if (!cancelled) setStatus(s);
      });
      return () => {
        cancelled = true;
      };
    }
  }, [load]);

  React.useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener(CREDITS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CREDITS_CHANGED_EVENT, onChanged);
  }, [load]);

  return status;
}

/** A corner "price tag" for whatever button it's dropped next to —
 * Adrian, direct: "credits price tag should be like on the top right
 * corner of the button." Absolutely positioned (`-top-2 -right-2`),
 * so every call site wraps its Button in a `relative` container and
 * renders this as a sibling right after it, rather than the old
 * stacked-below layout. First use free (Adrian, direct, same
 * follow-up): shows the real price struck through, then 0 — never
 * hides the actual cost, just shows it's waived this once. */
export function CreditCostBadge({ featureKey, className }: { featureKey: string; className?: string }) {
  const costs = useFeatureCosts();
  const firstUseStatus = useFirstUseStatus();
  const entry = costs?.find((c) => c.key === featureKey);
  // No row (or a deactivated one) = genuinely free — credit_ledger.py's
  // own "no priced row = never blocks, never charges" rule, mirrored
  // here rather than showing a misleading "0 credits" badge.
  if (!entry || entry.credit_cost <= 0) return null;

  const isFreeFirstUse = firstUseStatus?.[featureKey] === true;
  return (
    <span
      className={cn(
        "pointer-events-none absolute -top-2 -right-2 z-10 inline-flex items-center gap-0.5 whitespace-nowrap",
        "bg-primary px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white",
        className,
      )}
      title={
        isFreeFirstUse
          ? `${entry.display_name} is free the first time you use it (normally ${entry.credit_cost} credits)`
          : `${entry.display_name} costs ${entry.credit_cost} credits`
      }
    >
      <Coins className="size-2.5 shrink-0 text-amber-400" strokeWidth={2} />
      {isFreeFirstUse ? (
        <>
          {/* A real diagonal strike, not text-decoration: line-through
             (always horizontal) — a thin rotated bar layered over the
             number via an absolutely-positioned span, sale-tag style. */}
          <span className="relative inline-block text-white/60">
            {entry.credit_cost}
            <span className="pointer-events-none absolute left-[-2px] top-1/2 h-px w-[calc(100%+4px)] -translate-y-1/2 -rotate-[25deg] bg-white/70" />
          </span>{" "}
          0
        </>
      ) : (
        entry.credit_cost
      )}
    </span>
  );
}
