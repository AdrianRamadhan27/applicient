"use client";

import * as React from "react";
import { toast } from "sonner";
import { api, type AdminCreditPack, type AdminPlan, type FeatureCreditCost } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

function idr(v: number) {
  return v === 0 ? "Free" : `Rp ${v.toLocaleString("id-ID")}/mo`;
}

type Draft = {
  name: string;
  price_idr: string;
  monthly_credits: string;
  dodo_product_id_test: string;
  dodo_product_id_live: string;
};

export default function AdminPlansPage() {
  const [plans, setPlans] = React.useState<AdminPlan[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Draft>({
    name: "",
    price_idr: "",
    monthly_credits: "",
    dodo_product_id_test: "",
    dodo_product_id_live: "",
  });
  const [saving, setSaving] = React.useState(false);

  const [newName, setNewName] = React.useState("");
  const [newPrice, setNewPrice] = React.useState("");
  const [newCredits, setNewCredits] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      setPlans(await api.listPlans());
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);

  function startEdit(p: AdminPlan) {
    setEditingId(p.id);
    setDraft({
      name: p.name,
      price_idr: String(p.price_idr),
      monthly_credits: String(p.monthly_credits),
      dodo_product_id_test: p.dodo_product_id_test ?? "",
      dodo_product_id_live: p.dodo_product_id_live ?? "",
    });
  }

  async function saveEdit(id: string) {
    setSaving(true);
    try {
      const updated = await api.updatePlan(id, {
        name: draft.name.trim(),
        price_idr: Number(draft.price_idr),
        monthly_credits: Number(draft.monthly_credits),
        // Dodo's test/live catalogs are fully separate — these are two
        // independent columns server-side (billing_service.py), not
        // one shared id, so editing one never touches the other
        // regardless of which mode DODO_PAYMENTS_ENVIRONMENT is
        // currently running as (raised directly by Adrian).
        dodo_product_id_test: draft.dodo_product_id_test.trim() || null,
        dodo_product_id_live: draft.dodo_product_id_live.trim() || null,
      });
      setPlans((prev) => prev.map((p) => (p.id === id ? updated : p)));
      setEditingId(null);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(p: AdminPlan) {
    try {
      const updated = await api.updatePlan(p.id, { is_active: !p.is_active });
      setPlans((prev) => prev.map((x) => (x.id === p.id ? updated : x)));
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function handleCreate() {
    if (!newName.trim() || !newPrice || !newCredits) {
      toast.error("Name, price, and monthly credits are all required");
      return;
    }
    setCreating(true);
    try {
      const plan = await api.createPlan({
        name: newName.trim(),
        price_idr: Number(newPrice),
        monthly_credits: Number(newCredits),
      });
      setPlans((prev) => [...prev, plan]);
      setNewName("");
      setNewPrice("");
      setNewCredits("");
      toast.success("Plan created");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Plans</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          flat subscription tiers — credits are the only cap that does anything; there is no separate $ cap
        </span>
      </header>

      {/* Adrian, direct: "in admin page in plans. the subsription and
          credit pack should be side by side" — a two-column grid for
          just those two (feature costs stays its own full-width
          section below — a flat per-feature price list reads better
          wide than squeezed into a half column). Widened from the old
          max-w-2xl to max-w-6xl to give the grid real room. */}
      <div className="flex-1 overflow-auto p-5 flex flex-col gap-8 max-w-6xl">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <div className="flex flex-col gap-4">
        <div>
          <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">Plans</span>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Recurring monthly subscriptions — each grants a fixed credit allowance every billing cycle, never a
            real $ cap.
          </p>
        </div>
        {loading ? (
          <div className="text-sm text-muted-foreground font-mono">loading…</div>
        ) : (
          <div className="flex flex-col gap-2">
            {plans.map((p) => (
              <div key={p.id} className="border border-border px-3 py-2.5 flex flex-col gap-2">
                {editingId === p.id ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        className="h-7 text-xs"
                        value={draft.name}
                        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                      />
                      <Input
                        className="h-7 text-xs w-28"
                        type="number"
                        value={draft.price_idr}
                        onChange={(e) => setDraft((d) => ({ ...d, price_idr: e.target.value }))}
                        placeholder="IDR/mo"
                      />
                      <Input
                        className="h-7 text-xs w-28"
                        type="number"
                        value={draft.monthly_credits}
                        onChange={(e) => setDraft((d) => ({ ...d, monthly_credits: e.target.value }))}
                        placeholder="credits/mo"
                      />
                      <Button size="sm" className="h-7 px-2 text-[11px]" disabled={saving} onClick={() => saveEdit(p.id)}>
                        Save
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                    </div>
                    {/* Dodo's test and live product catalogs are
                        completely separate objects — these two fields
                        are independent columns, not one value that
                        follows whatever DODO_PAYMENTS_ENVIRONMENT
                        happens to be right now. Paste the real product
                        id straight from Dodo's dashboard (Test mode /
                        Live mode toggle, top left) into whichever of
                        these it belongs to; leave blank to have one
                        auto-created on next use instead. */}
                    <div className="flex items-center gap-2 pl-0">
                      <Label className="w-20 shrink-0 text-[11px] text-muted-foreground font-mono">test id</Label>
                      <Input
                        className="h-7 flex-1 font-mono text-xs"
                        placeholder="pdt_… (test mode)"
                        value={draft.dodo_product_id_test}
                        onChange={(e) => setDraft((d) => ({ ...d, dodo_product_id_test: e.target.value }))}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Label className="w-20 shrink-0 text-[11px] text-muted-foreground font-mono">live id</Label>
                      <Input
                        className="h-7 flex-1 font-mono text-xs"
                        placeholder="pdt_… (live mode)"
                        value={draft.dodo_product_id_live}
                        onChange={(e) => setDraft((d) => ({ ...d, dodo_product_id_live: e.target.value }))}
                      />
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{p.name}</span>
                        {!p.is_active && (
                          <Badge variant="secondary" className="text-[9px] font-mono bg-muted text-muted-foreground">
                            inactive — hidden from signup
                          </Badge>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground font-mono">
                        {idr(p.price_idr)} · {p.monthly_credits.toLocaleString()} credits/mo
                      </span>
                      {p.price_idr > 0 && (
                        <div className="mt-1 flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
                          <span>
                            dodo test: {p.dodo_product_id_test ? <span className="text-ok">{p.dodo_product_id_test}</span> : "—"}
                          </span>
                          <span>
                            dodo live: {p.dodo_product_id_live ? <span className="text-ok">{p.dodo_product_id_live}</span> : "—"}
                          </span>
                        </div>
                      )}
                    </div>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => startEdit(p)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => toggleActive(p)}>
                      {p.is_active ? "Deactivate" : "Activate"}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="border border-dashed border-input p-3 flex flex-col gap-2">
          <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">Add plan</span>
          <div className="flex flex-wrap gap-2">
            <Input className="text-sm" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <Input
              className="text-sm w-32"
              type="number"
              placeholder="IDR/mo"
              value={newPrice}
              onChange={(e) => setNewPrice(e.target.value)}
            />
            <Input
              className="text-sm w-32"
              type="number"
              placeholder="credits/mo"
              value={newCredits}
              onChange={(e) => setNewCredits(e.target.value)}
            />
          </div>
          <span className="text-[11px] text-muted-foreground">
            Dodo product ids can be added after creating, via Edit — leaving them blank auto-creates one on first use.
          </span>
          <Button size="sm" onClick={handleCreate} disabled={creating} className="self-start">
            Add plan
          </Button>
        </div>
        </div>

        <CreditPacksSection />
        </div>

        <FeatureCostsSection />
      </div>
    </div>
  );
}

function FeatureCostsSection() {
  const [costs, setCosts] = React.useState<FeatureCreditCost[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draftCost, setDraftCost] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    (async () => {
      try {
        setCosts(await api.listAdminFeatureCosts());
      } catch (e) {
        toast.error(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function save(id: string) {
    setSaving(true);
    try {
      const updated = await api.updateFeatureCost(id, { credit_cost: Number(draftCost) });
      setCosts((prev) => prev.map((c) => (c.id === id ? updated : c)));
      setEditingId(null);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(c: FeatureCreditCost) {
    try {
      const updated = await api.updateFeatureCost(c.id, { is_active: !c.is_active });
      setCosts((prev) => prev.map((x) => (x.id === c.id ? updated : x)));
    } catch (e) {
      toast.error(String(e));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">Feature credit costs</span>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          A fixed price per AI feature, not derived from real per-call cost — deactivating one makes it free (CV parsing
          has no row at all, deliberately free-on-the-house).
        </p>
      </div>
      {loading ? (
        <div className="text-sm text-muted-foreground font-mono">loading…</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {costs.map((c) => (
            <div key={c.id} className="border border-border px-3 py-2 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <span className="text-xs font-medium">{c.display_name}</span>
                <span className="ml-2 font-mono text-[10px] text-muted-foreground">{c.key}</span>
                {!c.is_active && (
                  <Badge variant="secondary" className="ml-2 text-[9px] font-mono bg-muted text-muted-foreground">
                    free (deactivated)
                  </Badge>
                )}
              </div>
              {editingId === c.id ? (
                <>
                  <Input
                    className="h-7 text-xs w-24"
                    type="number"
                    value={draftCost}
                    onChange={(e) => setDraftCost(e.target.value)}
                  />
                  <Button size="sm" className="h-7 px-2 text-[11px]" disabled={saving} onClick={() => save(c.id)}>
                    Save
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => setEditingId(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <span className="font-mono text-xs">{c.credit_cost} credits</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => {
                      setEditingId(c.id);
                      setDraftCost(String(c.credit_cost));
                    }}
                  >
                    Edit
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => toggleActive(c)}>
                    {c.is_active ? "Deactivate" : "Activate"}
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CreditPacksSection() {
  const [packs, setPacks] = React.useState<AdminCreditPack[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState({
    name: "",
    price_idr: "",
    credits: "",
    dodo_product_id_test: "",
    dodo_product_id_live: "",
  });
  const [saving, setSaving] = React.useState(false);

  const [newName, setNewName] = React.useState("");
  const [newPrice, setNewPrice] = React.useState("");
  const [newCredits, setNewCredits] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      setPacks(await api.listAdminCreditPacks());
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);

  function startEdit(p: AdminCreditPack) {
    setEditingId(p.id);
    setDraft({
      name: p.name,
      price_idr: String(p.price_idr),
      credits: String(p.credits),
      dodo_product_id_test: p.dodo_product_id_test ?? "",
      dodo_product_id_live: p.dodo_product_id_live ?? "",
    });
  }

  async function saveEdit(id: string) {
    setSaving(true);
    try {
      const updated = await api.updateCreditPack(id, {
        name: draft.name.trim(),
        price_idr: Number(draft.price_idr),
        credits: Number(draft.credits),
        // Same split-by-environment reasoning as the Plans section
        // above (raised directly by Adrian, follow-up: credit packs
        // need the same test/live product id editing plans already
        // have) — Dodo's test and live catalogs are fully separate.
        dodo_product_id_test: draft.dodo_product_id_test.trim() || null,
        dodo_product_id_live: draft.dodo_product_id_live.trim() || null,
      });
      setPacks((prev) => prev.map((p) => (p.id === id ? updated : p)));
      setEditingId(null);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(p: AdminCreditPack) {
    try {
      const updated = await api.updateCreditPack(p.id, { is_active: !p.is_active });
      setPacks((prev) => prev.map((x) => (x.id === p.id ? updated : x)));
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function handleCreate() {
    if (!newName.trim() || !newPrice || !newCredits) {
      toast.error("Name, price, and credits are all required");
      return;
    }
    setCreating(true);
    try {
      const pack = await api.createCreditPack({
        name: newName.trim(),
        price_idr: Number(newPrice),
        credits: Number(newCredits),
      });
      setPacks((prev) => [...prev, pack]);
      setNewName("");
      setNewPrice("");
      setNewCredits("");
      toast.success("Credit pack created");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">Credit packs</span>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Standalone, one-time purchases — never expire, on top of whatever the plan grants monthly.
        </p>
      </div>
      {loading ? (
        <div className="text-sm text-muted-foreground font-mono">loading…</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {packs.map((p) => (
            <div key={p.id} className="border border-border px-3 py-2 flex flex-col gap-1.5">
              {editingId === p.id ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      className="h-7 text-xs"
                      value={draft.name}
                      onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    />
                    <Input
                      className="h-7 text-xs w-28"
                      type="number"
                      value={draft.price_idr}
                      onChange={(e) => setDraft((d) => ({ ...d, price_idr: e.target.value }))}
                      placeholder="IDR"
                    />
                    <Input
                      className="h-7 text-xs w-28"
                      type="number"
                      value={draft.credits}
                      onChange={(e) => setDraft((d) => ({ ...d, credits: e.target.value }))}
                      placeholder="credits"
                    />
                    <Button size="sm" className="h-7 px-2 text-[11px]" disabled={saving} onClick={() => saveEdit(p.id)}>
                      Save
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </div>
                  {/* Same Dodo test/live split as the Plans section above — paste the real product id
                      straight from Dodo's dashboard (Test mode / Live mode toggle); leave blank to have
                      one auto-created on next use instead. */}
                  <div className="flex items-center gap-2">
                    <Label className="w-20 shrink-0 text-[11px] text-muted-foreground font-mono">test id</Label>
                    <Input
                      className="h-7 flex-1 font-mono text-xs"
                      placeholder="pdt_… (test mode)"
                      value={draft.dodo_product_id_test}
                      onChange={(e) => setDraft((d) => ({ ...d, dodo_product_id_test: e.target.value }))}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="w-20 shrink-0 text-[11px] text-muted-foreground font-mono">live id</Label>
                    <Input
                      className="h-7 flex-1 font-mono text-xs"
                      placeholder="pdt_… (live mode)"
                      value={draft.dodo_product_id_live}
                      onChange={(e) => setDraft((d) => ({ ...d, dodo_product_id_live: e.target.value }))}
                    />
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{p.name}</span>
                    {!p.is_active && (
                      <Badge variant="secondary" className="ml-2 text-[9px] font-mono bg-muted text-muted-foreground">
                        inactive
                      </Badge>
                    )}
                    <div className="text-xs text-muted-foreground font-mono">
                      Rp {p.price_idr.toLocaleString("id-ID")} · {p.credits.toLocaleString()} credits
                    </div>
                    <div className="mt-1 flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
                      <span>
                        dodo test: {p.dodo_product_id_test ? <span className="text-ok">{p.dodo_product_id_test}</span> : "—"}
                      </span>
                      <span>
                        dodo live: {p.dodo_product_id_live ? <span className="text-ok">{p.dodo_product_id_live}</span> : "—"}
                      </span>
                    </div>
                  </div>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => startEdit(p)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => toggleActive(p)}>
                    {p.is_active ? "Deactivate" : "Activate"}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="border border-dashed border-input p-3 flex flex-col gap-2">
        <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">Add credit pack</span>
        <div className="flex flex-wrap gap-2">
          <Input className="text-sm" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Input
            className="text-sm w-28"
            type="number"
            placeholder="IDR"
            value={newPrice}
            onChange={(e) => setNewPrice(e.target.value)}
          />
          <Input
            className="text-sm w-28"
            type="number"
            placeholder="credits"
            value={newCredits}
            onChange={(e) => setNewCredits(e.target.value)}
          />
        </div>
        <span className="text-[11px] text-muted-foreground">
          Dodo product ids can be added after creating, via Edit — leaving them blank auto-creates one on first use.
        </span>
        <Button size="sm" onClick={handleCreate} disabled={creating} className="self-start">
          Add pack
        </Button>
      </div>
    </div>
  );
}
