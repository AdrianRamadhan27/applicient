"use client";

import * as React from "react";
import { toast } from "sonner";
import { DodoPayments, type CheckoutEvent } from "dodopayments-checkout";
import { api, type Plan, type Subscription } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TierLabel } from "@/lib/plan-tiers";
import { detectCurrency, formatLocalizedPrice } from "@/lib/currency";
import { cn } from "@/lib/utils";

function idr(v: number) {
  return v === 0 ? "Free" : `Rp ${v.toLocaleString("id-ID")}/mo`;
}

// "live" only once NEXT_PUBLIC_DODO_PAYMENTS_MODE is explicitly set to
// it — defaults safely to test mode rather than accidentally going
// live from a missing env var.
const DODO_MODE: "test" | "live" = process.env.NEXT_PUBLIC_DODO_PAYMENTS_MODE === "live" ? "live" : "test";

export default function BillingPage() {
  const [subscription, setSubscription] = React.useState<Subscription | null>(null);
  const [plans, setPlans] = React.useState<Plan[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [checkingOutId, setCheckingOutId] = React.useState<string | null>(null);
  const [syncing, setSyncing] = React.useState(false);
  const [localCurrency, setLocalCurrency] = React.useState<string | null>(null);

  React.useEffect(() => {
    (() => setLocalCurrency(detectCurrency()))();
  }, []);

  const load = React.useCallback(async () => {
    try {
      const [sub, planList] = await Promise.all([api.getMySubscription(), api.listBillingPlans()]);
      setSubscription(sub);
      setPlans(planList);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Accepts the Dodo subscription_id straight from the overlay's own
  // event payload (or the return_url query-param fallback) — the
  // backend's own GET against Dodo is still what's actually trusted
  // (billing_service.py's own docstring), this just tells it which
  // subscription to look up the very first time, before our own
  // Subscription row has one recorded yet.
  const handleSync = React.useCallback(async (dodoSubscriptionId?: string) => {
    setSyncing(true);
    try {
      const sub = await api.syncSubscription(dodoSubscriptionId);
      setSubscription(sub);
      if (!sub.pending_plan_name) toast.success(`On the ${sub.plan_name} plan`);
      else toast("Payment not confirmed yet — try syncing again in a moment.");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSyncing(false);
    }
  }, []);

  // Initialized once — the overlay stays embedded in this page the
  // whole time (no redirect), so success/failure is read directly off
  // its own event stream rather than a returned query param.
  React.useEffect(() => {
    DodoPayments.Initialize({
      mode: DODO_MODE,
      displayType: "overlay",
      onEvent: (event: CheckoutEvent) => {
        const data = event.data as { subscription_id?: string; message?: string } | undefined;
        if (event.event_type === "checkout.error") {
          toast.error(data?.message ?? "Checkout failed — nothing was charged");
          setCheckingOutId(null);
        } else if (event.event_type === "checkout.redirect" || event.event_type === "checkout.status") {
          toast.message("Checking your payment status…");
          void handleSync(data?.subscription_id);
          setCheckingOutId(null);
        } else if (event.event_type === "checkout.closed") {
          setCheckingOutId(null);
        }
      },
    });
  }, [handleSync]);

  React.useEffect(() => {
    (async () => {
      await load();
      // Safety net only — Dodo appends subscription_id/status query
      // params to return_url on the rare chance the overlay does a
      // full-page navigation instead of staying embedded (the
      // checkout.redirect event above is the primary path).
      const params = new URLSearchParams(window.location.search);
      const subscriptionId = params.get("subscription_id");
      if (subscriptionId) {
        toast.message("Checking your payment status…");
        await handleSync(subscriptionId);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function handleUpgrade(plan: Plan) {
    setCheckingOutId(plan.id);
    try {
      const { checkout_url } = await api.startCheckout(plan.id);
      DodoPayments.Checkout.open({ checkoutUrl: checkout_url });
    } catch (e) {
      toast.error(String(e));
      setCheckingOutId(null);
    }
  }

  const usagePct = subscription ? Math.min(100, (subscription.current_period_spend_usd / subscription.monthly_usage_cap_usd) * 100) : 0;

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Billing</span>
      </header>

      <div className="flex-1 overflow-auto p-5 flex flex-col gap-5 max-w-2xl">
        {loading ? (
          <div className="text-sm text-muted-foreground font-mono">loading…</div>
        ) : (
          <>
            {subscription && (
              <div className="border border-border bg-card p-4 flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <span>Current plan:</span>
                    <TierLabel planName={subscription.plan_name} />
                  </span>
                  <Badge variant="secondary" className="text-[9px] font-mono">
                    {subscription.status}
                  </Badge>
                  {subscription.pending_plan_name && (
                    <Badge variant="secondary" className="text-[9px] font-mono bg-warn-bg text-warn">
                      upgrading to {subscription.pending_plan_name} — awaiting payment
                    </Badge>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <div className="flex justify-between text-xs text-muted-foreground font-mono">
                    <span>Usage this period</span>
                    <span>
                      ${subscription.current_period_spend_usd.toFixed(2)} / ${subscription.monthly_usage_cap_usd.toFixed(2)}
                    </span>
                  </div>
                  <div className="h-1.5 w-full bg-secondary overflow-hidden">
                    <div
                      className={cn("h-full", usagePct >= 100 ? "bg-crit" : usagePct >= 80 ? "bg-warn" : "bg-primary")}
                      style={{ width: `${usagePct}%` }}
                    />
                  </div>
                </div>
                {subscription.pending_plan_name && (
                  <Button size="sm" variant="outline" className="self-start" disabled={syncing} onClick={() => handleSync()}>
                    {syncing ? "Checking…" : "Sync payment status"}
                  </Button>
                )}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">Plans</span>
              {plans.map((p) => {
                const isCurrent = subscription?.plan_id === p.id;
                // The pending plan itself must stay clickable — a
                // closed/abandoned/declined overlay previously left no
                // way back in, since every Upgrade button (including
                // this one) went disabled the moment ANY plan went
                // pending. Only OTHER plans stay blocked while one is
                // in flight, to avoid starting two conflicting checkouts.
                const isPending = !!subscription?.pending_plan_id && subscription.pending_plan_id === p.id;
                const blockedByOtherPending = !!subscription?.pending_plan_name && !isPending;
                const localized = localCurrency ? formatLocalizedPrice(p.price_idr, localCurrency) : null;
                return (
                  <div key={p.id} className="border border-border px-4 py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <TierLabel planName={p.name} className="text-sm font-medium" />
                      <span className="block text-xs text-muted-foreground font-mono">
                        {idr(p.price_idr)} · cap ${p.monthly_usage_cap_usd.toFixed(2)}/mo
                      </span>
                      {localized && <span className="block text-xs text-muted-foreground">≈ {localized}/mo</span>}
                    </div>
                    {isCurrent ? (
                      <Badge variant="secondary" className="text-[9px] font-mono">
                        current plan
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant={isPending ? "outline" : "default"}
                        disabled={checkingOutId === p.id || blockedByOtherPending}
                        onClick={() => handleUpgrade(p)}
                      >
                        {checkingOutId === p.id ? "Opening checkout…" : isPending ? "Retry payment" : "Upgrade"}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
