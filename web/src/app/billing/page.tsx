"use client";

import * as React from "react";
import { toast } from "sonner";
import { api, type Plan, type Subscription } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function idr(v: number) {
  return v === 0 ? "Free" : `Rp ${v.toLocaleString("id-ID")}/mo`;
}

export default function BillingPage() {
  const [subscription, setSubscription] = React.useState<Subscription | null>(null);
  const [plans, setPlans] = React.useState<Plan[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [checkingOutId, setCheckingOutId] = React.useState<string | null>(null);
  const [syncing, setSyncing] = React.useState(false);

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

  const handleSync = React.useCallback(async () => {
    setSyncing(true);
    try {
      const sub = await api.syncSubscription();
      setSubscription(sub);
      if (!sub.pending_plan_name) toast.success(`On the ${sub.plan_name} plan`);
      else toast("Payment not confirmed yet — try syncing again in a moment, or check the checkout page.");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSyncing(false);
    }
  }, []);

  React.useEffect(() => {
    (async () => {
      await load();
      // Same window.location convention pipeline/page.tsx and
      // pipeline/live/page.tsx already use for a one-off query param,
      // rather than next/navigation's useSearchParams — avoids needing
      // a Suspense boundary for a value only read once on mount.
      const params = new URLSearchParams(window.location.search);
      const xendit = params.get("xendit");
      if (xendit === "success") {
        toast("Checking your payment status…");
        await handleSync();
      } else if (xendit === "cancelled") {
        toast("Checkout cancelled — you're still on your current plan.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function handleUpgrade(plan: Plan) {
    setCheckingOutId(plan.id);
    try {
      const { checkout_url } = await api.startCheckout(plan.id);
      window.location.assign(checkout_url);
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
                  <span className="text-sm font-medium">Current plan: {subscription.plan_name}</span>
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
                  <Button size="sm" variant="outline" className="self-start" disabled={syncing} onClick={handleSync}>
                    {syncing ? "Checking…" : "Sync payment status"}
                  </Button>
                )}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">Plans</span>
              {plans.map((p) => {
                const isCurrent = subscription?.plan_id === p.id;
                return (
                  <div key={p.id} className="border border-border px-4 py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">{p.name}</span>
                      <span className="block text-xs text-muted-foreground font-mono">
                        {idr(p.price_idr)} · cap ${p.monthly_usage_cap_usd.toFixed(2)}/mo
                      </span>
                    </div>
                    {isCurrent ? (
                      <Badge variant="secondary" className="text-[9px] font-mono">
                        current plan
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        disabled={checkingOutId === p.id || !!subscription?.pending_plan_name}
                        onClick={() => handleUpgrade(p)}
                      >
                        {checkingOutId === p.id ? "Redirecting…" : "Upgrade"}
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
