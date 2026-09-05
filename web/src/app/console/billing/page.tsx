"use client";

import * as React from "react";
import { toast } from "sonner";
import { DodoPayments, type CheckoutEvent } from "dodopayments-checkout";
import { api, type CreditPack, type CreditTransaction, type Plan, type Subscription } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CreditChip } from "@/components/credit-chip";
import { localEstimateLabel, primaryPriceLabel, type LocalizedCurrency } from "@/lib/currency";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TierLabel } from "@/lib/plan-tiers";
import { cn } from "@/lib/utils";

// A short, generic benefit line per tier — not pulled from any API,
// this app's plans aren't feature-gated (every plan can use every
// feature, credits are the only thing that differs), so this is just
// framing copy for the pricing cards, same spirit as the landing
// page's own FEATURES list.
const PLAN_BLURB: Record<string, string> = {
  "Open to Work": "Try the whole loop — discovery, tailoring, applying, interview practice — on the house.",
  Unemployed: "A steady monthly allowance for someone actively job-hunting.",
  "Super Unemployed": "The most room to search, tailor, and practice without watching the meter.",
};

// "live" only once NEXT_PUBLIC_DODO_PAYMENTS_MODE is explicitly set to
// it — defaults safely to test mode rather than accidentally going
// live from a missing env var.
const DODO_MODE: "test" | "live" = process.env.NEXT_PUBLIC_DODO_PAYMENTS_MODE === "live" ? "live" : "test";

export default function BillingPage() {
  const [subscription, setSubscription] = React.useState<Subscription | null>(null);
  const [plans, setPlans] = React.useState<Plan[]>([]);
  const [packs, setPacks] = React.useState<CreditPack[]>([]);
  const [transactions, setTransactions] = React.useState<CreditTransaction[]>([]);
  // Adrian, direct: "show in the currency of wherever the user is" —
  // a real geo-IP + real live FX rate (currency_service.py); both null
  // means "couldn't resolve one, just show the real Rp price," never a
  // guess. Passed straight through to checkout too, so what's shown
  // here matches what the Dodo overlay actually charges.
  const [localCurrency, setLocalCurrency] = React.useState<LocalizedCurrency>({
    currency: null,
    rate: null,
    usd_rate: null,
  });
  const [showHistory, setShowHistory] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [checkingOutPlanId, setCheckingOutPlanId] = React.useState<string | null>(null);
  const [checkingOutPackId, setCheckingOutPackId] = React.useState<string | null>(null);
  const [syncing, setSyncing] = React.useState(false);
  // Upgrade/downgrade/cancel (Adrian, direct) — separate loading flags
  // from checkingOutPlanId above, since these never open the Dodo
  // overlay at all (no checkout, just a scheduled server-side change).
  const [changingPlanId, setChangingPlanId] = React.useState<string | null>(null);
  const [undoingChange, setUndoingChange] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [undoingCancel, setUndoingCancel] = React.useState(false);
  // Adrian, direct: "Add confirmation dialog to cancelling subscription.
  // with info that you will keep benefits until what date" — a plain
  // click used to fire handleCancel immediately with no way back except
  // the separate "Undo cancellation" button that appears afterward.
  const [cancelConfirmOpen, setCancelConfirmOpen] = React.useState(false);
  // Which kind of checkout is currently open — the shared onEvent
  // callback below needs this to know whether a success event means
  // "sync the subscription" or "confirm a credit-pack purchase";
  // checkingOutPlanId/checkingOutPackId already track WHICH plan/pack,
  // this just tracks the KIND without re-deriving it from event data
  // whose exact shape (subscription_id vs payment_id) isn't guaranteed
  // the same way across a recurring vs one-time checkout session.
  const checkoutKindRef = React.useRef<"plan" | "pack" | null>(null);

  const load = React.useCallback(async () => {
    try {
      const [sub, planList, packList, txns, localized] = await Promise.all([
        api.getMySubscription(),
        api.listBillingPlans(),
        api.listCreditPacks(),
        api.listCreditTransactions(),
        api.getLocalizedCurrency().catch(() => ({ currency: null, rate: null, usd_rate: null })),
      ]);
      setSubscription(sub);
      setPlans(planList);
      setPacks(packList);
      setTransactions(txns);
      setLocalCurrency(localized);
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

  const handlePackConfirm = React.useCallback(async (dodoPaymentId?: string) => {
    if (!dodoPaymentId) {
      toast("Payment not confirmed yet — try again in a moment.");
      return;
    }
    setSyncing(true);
    try {
      await api.confirmPackPurchase(dodoPaymentId);
      toast.success("Credits added");
      await load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSyncing(false);
    }
  }, [load]);

  // Initialized once — the overlay stays embedded in this page the
  // whole time (no redirect), so success/failure is read directly off
  // its own event stream rather than a returned query param.
  React.useEffect(() => {
    DodoPayments.Initialize({
      mode: DODO_MODE,
      displayType: "overlay",
      onEvent: (event: CheckoutEvent) => {
        const data = event.data as { subscription_id?: string; payment_id?: string; message?: string } | undefined;
        if (event.event_type === "checkout.error") {
          toast.error(data?.message ?? "Checkout failed — nothing was charged");
          setCheckingOutPlanId(null);
          setCheckingOutPackId(null);
        } else if (event.event_type === "checkout.redirect" || event.event_type === "checkout.status") {
          toast.message("Checking your payment status…");
          if (checkoutKindRef.current === "pack") void handlePackConfirm(data?.payment_id);
          else void handleSync(data?.subscription_id);
          setCheckingOutPlanId(null);
          setCheckingOutPackId(null);
        } else if (event.event_type === "checkout.closed") {
          setCheckingOutPlanId(null);
          setCheckingOutPackId(null);
        }
      },
    });
  }, [handleSync, handlePackConfirm]);

  React.useEffect(() => {
    (async () => {
      await load();
      // Safety net only — Dodo appends subscription_id/payment_id/status
      // query params to return_url on the rare chance the overlay does
      // a full-page navigation instead of staying embedded (the
      // checkout.redirect event above is the primary path). Both
      // checkout flows share the same return_url, so both params are
      // checked here.
      const params = new URLSearchParams(window.location.search);
      const subscriptionId = params.get("subscription_id");
      const paymentId = params.get("payment_id");
      if (subscriptionId) {
        toast.message("Checking your payment status…");
        await handleSync(subscriptionId);
      } else if (paymentId) {
        toast.message("Checking your payment status…");
        await handlePackConfirm(paymentId);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function handleUpgrade(plan: Plan) {
    checkoutKindRef.current = "plan";
    setCheckingOutPlanId(plan.id);
    try {
      const { checkout_url } = await api.startCheckout(plan.id, localCurrency.currency);
      DodoPayments.Checkout.open({ checkoutUrl: checkout_url });
    } catch (e) {
      toast.error(String(e));
      setCheckingOutPlanId(null);
    }
  }

  // Confirmed directly with Adrian: upgrade/downgrade between two paid
  // plans is scheduled for the next billing cycle, never immediate —
  // no Dodo overlay here, this is a plain server-side call
  // (billing_service.change_subscription_plan).
  async function handleChangePlan(plan: Plan) {
    setChangingPlanId(plan.id);
    try {
      const sub = await api.changePlan(plan.id);
      setSubscription(sub);
      toast.success(`Switching to ${plan.name} at the end of this billing period`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setChangingPlanId(null);
    }
  }

  async function handleUndoChangePlan() {
    setUndoingChange(true);
    try {
      const sub = await api.undoChangePlan();
      setSubscription(sub);
      toast.success("Scheduled plan change cancelled — staying on your current plan");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setUndoingChange(false);
    }
  }

  // "Downgrade to Free" — also scheduled for the end of the current
  // period (never immediate), and reverts to Free automatically once
  // it actually ends (billing_service.sync_subscription_from_dodo's
  // own status handling) rather than a separate "switch to Free" call.
  async function handleCancel() {
    setCancelling(true);
    try {
      const sub = await api.cancelSubscription();
      setSubscription(sub);
      toast.success("Your subscription will end at the close of this billing period");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCancelling(false);
      setCancelConfirmOpen(false);
    }
  }

  async function handleUndoCancel() {
    setUndoingCancel(true);
    try {
      const sub = await api.undoCancelSubscription();
      setSubscription(sub);
      toast.success("Cancellation undone — your subscription will continue");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setUndoingCancel(false);
    }
  }

  async function handleBuyPack(pack: CreditPack) {
    checkoutKindRef.current = "pack";
    setCheckingOutPackId(pack.id);
    try {
      const { checkout_url } = await api.startPackCheckout(pack.id, localCurrency.currency);
      DodoPayments.Checkout.open({ checkoutUrl: checkout_url });
    } catch (e) {
      toast.error(String(e));
      setCheckingOutPackId(null);
    }
  }

  const usagePct = subscription && subscription.monthly_credits > 0
    ? Math.min(100, (subscription.credits_monthly / subscription.monthly_credits) * 100)
    : 0;

  const periodEndLabel = subscription?.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "the end of this period";

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Billing</span>
      </header>

      <div className="flex-1 overflow-auto p-5">
        {loading ? (
          <div className="text-sm text-muted-foreground font-mono">loading…</div>
        ) : (
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            {subscription && (() => {
              // Free -> Paid's own in-flight checkout also sets
              // pending_plan_name, and /billing/checkout is now
              // rejected once already on a paid plan (routers/
              // billing.py) — so an "active" status with a pending
              // plan can ONLY mean a scheduled next-cycle change
              // (billing_service.change_subscription_plan), never an
              // unpaid checkout still waiting on the overlay.
              const isScheduledChange = subscription.status === "active" && !!subscription.pending_plan_name;
              const isAwaitingPayment = subscription.status !== "active" && !!subscription.pending_plan_name;
              return (
                <div className="border border-border bg-card p-4 flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <span>Current plan:</span>
                      <TierLabel planName={subscription.plan_name} />
                    </span>
                    <Badge variant="secondary" className="text-[9px] font-mono">
                      {subscription.status}
                    </Badge>
                    {isAwaitingPayment && (
                      <Badge variant="secondary" className="text-[9px] font-mono bg-warn-bg text-warn">
                        upgrading to {subscription.pending_plan_name} — awaiting payment
                      </Badge>
                    )}
                    {isScheduledChange && (
                      <Badge variant="secondary" className="text-[9px] font-mono bg-warn-bg text-warn">
                        switching to {subscription.pending_plan_name} on {periodEndLabel}
                      </Badge>
                    )}
                    {subscription.cancel_at_period_end && (
                      <Badge variant="secondary" className="text-[9px] font-mono bg-crit-bg text-crit">
                        cancelling on {periodEndLabel}
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    <div className="flex justify-between text-xs text-muted-foreground font-mono">
                      <span>Credits this period</span>
                      <span>
                        {subscription.credits_monthly.toLocaleString()} / {subscription.monthly_credits.toLocaleString()}
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-secondary overflow-hidden">
                      <div
                        className={cn("h-full", usagePct <= 0 ? "bg-crit" : usagePct <= 20 ? "bg-warn" : "bg-primary")}
                        style={{ width: `${Math.max(4, usagePct)}%` }}
                      />
                    </div>
                    {subscription.credits_purchased > 0 && (
                      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        +
                        <CreditChip size="xs">{subscription.credits_purchased.toLocaleString()}</CreditChip>
                        purchased credits (never expire)
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {isAwaitingPayment && (
                      <Button size="sm" variant="outline" disabled={syncing} onClick={() => handleSync()}>
                        {syncing ? "Checking…" : "Sync payment status"}
                      </Button>
                    )}
                    {isScheduledChange && (
                      <Button size="sm" variant="outline" disabled={undoingChange} onClick={handleUndoChangePlan}>
                        {undoingChange ? "Undoing…" : "Undo scheduled change"}
                      </Button>
                    )}
                    {subscription.cancel_at_period_end ? (
                      <Button size="sm" variant="outline" disabled={undoingCancel} onClick={handleUndoCancel}>
                        {undoingCancel ? "Undoing…" : "Undo cancellation"}
                      </Button>
                    ) : (
                      subscription.price_idr > 0 &&
                      !isScheduledChange &&
                      !isAwaitingPayment && (
                        <Button size="sm" variant="outline" disabled={cancelling} onClick={() => setCancelConfirmOpen(true)}>
                          {cancelling ? "Cancelling…" : "Cancel subscription"}
                        </Button>
                      )
                    )}
                  </div>
                </div>
              );
            })()}

            <div className="flex flex-col gap-3">
              <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">Plans</span>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                {plans.map((p) => {
                  const isCurrent = subscription?.plan_id === p.id;
                  const currentlyOnPaidPlan = (subscription?.price_idr ?? 0) > 0;
                  // The pending plan itself must stay clickable — a
                  // closed/abandoned/declined overlay previously left no
                  // way back in, since every Upgrade button (including
                  // this one) went disabled the moment ANY plan went
                  // pending. Only OTHER plans stay blocked while one is
                  // in flight, to avoid starting two conflicting checkouts.
                  const isAwaitingPaymentForThis =
                    subscription?.status !== "active" &&
                    !!subscription?.pending_plan_id &&
                    subscription.pending_plan_id === p.id;
                  const blockedByOtherPending =
                    subscription?.status !== "active" && !!subscription?.pending_plan_name && !isAwaitingPaymentForThis;
                  // Adrian, direct: upgrade/downgrade between two paid
                  // plans is scheduled (billing_service.
                  // change_subscription_plan), never a fresh checkout —
                  // routers/billing.py's /checkout now rejects that
                  // combination server-side too, this just avoids
                  // opening the Dodo overlay for a call that would fail.
                  const isScheduledToThis =
                    subscription?.status === "active" &&
                    !!subscription?.pending_plan_id &&
                    subscription.pending_plan_id === p.id;
                  const isSwitch = currentlyOnPaidPlan && p.price_idr > 0 && !isCurrent;
                  const isDowngradeToFree = currentlyOnPaidPlan && p.price_idr === 0;
                  return (
                    <div
                      key={p.id}
                      className={cn(
                        "flex flex-col gap-4 border bg-card p-6",
                        isCurrent ? "border-primary" : "border-border",
                      )}
                    >
                      <div>
                        <TierLabel planName={p.name} className="text-sm font-medium" iconClassName="size-4" />
                        <div className="mt-2 text-2xl font-semibold tracking-tight">
                          {primaryPriceLabel(p.price_idr, localCurrency)}
                          {p.price_idr > 0 && <span className="text-sm font-normal text-muted-foreground">/mo</span>}
                        </div>
                        {localEstimateLabel(p.price_idr, localCurrency) && (
                          <span className="text-xs text-muted-foreground">
                            ≈ {localEstimateLabel(p.price_idr, localCurrency)}/mo
                          </span>
                        )}
                        <span className="mt-1.5 flex items-center gap-1.5">
                          <CreditChip>{p.monthly_credits.toLocaleString()} credits</CreditChip>
                          <span className="text-xs text-muted-foreground">{p.price_idr === 0 ? "to start" : "/mo"}</span>
                        </span>
                        {PLAN_BLURB[p.name] && (
                          <p className="mt-3 text-xs text-muted-foreground">{PLAN_BLURB[p.name]}</p>
                        )}
                      </div>
                      {isCurrent ? (
                        <Badge variant="secondary" className="mt-auto w-fit text-[9px] font-mono">
                          current plan
                        </Badge>
                      ) : isScheduledToThis ? (
                        <Badge variant="secondary" className="mt-auto w-fit text-[9px] font-mono bg-warn-bg text-warn">
                          scheduled — see above to undo
                        </Badge>
                      ) : isDowngradeToFree ? (
                        <Button className="mt-auto" variant="outline" disabled={cancelling} onClick={() => setCancelConfirmOpen(true)}>
                          {cancelling ? "Cancelling…" : "Downgrade to Free"}
                        </Button>
                      ) : isSwitch ? (
                        <Button
                          className="mt-auto"
                          variant="default"
                          disabled={changingPlanId === p.id}
                          onClick={() => handleChangePlan(p)}
                        >
                          {changingPlanId === p.id ? "Scheduling…" : "Switch to this plan"}
                        </Button>
                      ) : (
                        <Button
                          className="mt-auto"
                          variant={isAwaitingPaymentForThis ? "outline" : "default"}
                          disabled={checkingOutPlanId === p.id || blockedByOtherPending}
                          onClick={() => handleUpgrade(p)}
                        >
                          {checkingOutPlanId === p.id
                            ? "Opening checkout…"
                            : isAwaitingPaymentForThis
                              ? "Retry payment"
                              : "Upgrade"}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <div>
                <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">Buy more credits</span>
                <p className="text-xs text-muted-foreground mt-0.5">
                  A standalone, one-time purchase on top of your plan — never expires, spent only after your monthly
                  credits run out.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {packs.map((pack) => {
                  return (
                    <div key={pack.id} className="flex flex-col gap-2 border border-border bg-card p-4">
                      <span className="text-sm font-medium">{pack.name}</span>
                      <CreditChip className="w-fit text-xs">{pack.credits.toLocaleString()} credits</CreditChip>
                      <span className="text-sm font-medium">{primaryPriceLabel(pack.price_idr, localCurrency)}</span>
                      {localEstimateLabel(pack.price_idr, localCurrency) && (
                        <span className="text-xs text-muted-foreground font-mono">
                          ≈ {localEstimateLabel(pack.price_idr, localCurrency)}
                        </span>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-1"
                        disabled={checkingOutPackId === pack.id}
                        onClick={() => handleBuyPack(pack)}
                      >
                        {checkingOutPackId === pack.id ? "Opening checkout…" : "Buy"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              {/* Adrian, direct: "Show and hide credit history in
                  billings page is hard to notice" — the old version
                  was a bare hidden-by-default toggle link with nothing
                  showing at all until clicked. Now the last 3
                  transactions are always visible under a real section
                  header; "Show more" only appears (and only needs to
                  do anything) once there's actually more than that to
                  see. */}
              <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                Credit history
              </span>
              <div className="flex flex-col border border-border bg-background max-h-96 overflow-y-auto">
                {transactions.length === 0 ? (
                  <div className="p-4 text-xs text-muted-foreground font-mono">No credit activity yet.</div>
                ) : (
                  (showHistory ? transactions : transactions.slice(0, 3)).map((t) => (
                    <div
                      key={t.id}
                      className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs last:border-b-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{t.description}</div>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          {new Date(t.created_at).toLocaleString()}
                        </div>
                      </div>
                      <span className={cn("font-mono shrink-0", t.amount >= 0 ? "text-ok" : "text-muted-foreground")}>
                        {t.amount >= 0 ? "+" : ""}
                        {t.amount.toLocaleString()}
                      </span>
                      <span className="w-16 shrink-0 text-right font-mono text-muted-foreground">
                        {t.balance_after.toLocaleString()}
                      </span>
                    </div>
                  ))
                )}
              </div>
              {transactions.length > 3 && (
                <Button size="sm" variant="outline" className="self-start" onClick={() => setShowHistory((v) => !v)}>
                  {showHistory ? "Show less" : `Show more (${transactions.length - 3} more)`}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <Dialog open={cancelConfirmOpen} onOpenChange={setCancelConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel your subscription?</DialogTitle>
            <DialogDescription>
              You&apos;ll keep every plan benefit — including remaining credits — until{" "}
              <span className="font-medium text-foreground">{periodEndLabel}</span>, then drop to the Free plan.
              You can undo this any time before then.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelConfirmOpen(false)} disabled={cancelling}>
              Keep subscription
            </Button>
            <Button variant="destructive" onClick={handleCancel} disabled={cancelling}>
              {cancelling ? "Cancelling…" : "Cancel subscription"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
