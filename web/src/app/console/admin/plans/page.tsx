"use client";

import * as React from "react";
import { toast } from "sonner";
import { api, type AdminPlan } from "@/lib/api";
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
  monthly_usage_cap_usd: string;
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
    monthly_usage_cap_usd: "",
    dodo_product_id_test: "",
    dodo_product_id_live: "",
  });
  const [saving, setSaving] = React.useState(false);

  const [newName, setNewName] = React.useState("");
  const [newPrice, setNewPrice] = React.useState("");
  const [newCap, setNewCap] = React.useState("");
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
      monthly_usage_cap_usd: String(p.monthly_usage_cap_usd),
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
        monthly_usage_cap_usd: Number(draft.monthly_usage_cap_usd),
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
    if (!newName.trim() || !newPrice || !newCap) {
      toast.error("Name, price, and usage cap are all required");
      return;
    }
    setCreating(true);
    try {
      const plan = await api.createPlan({
        name: newName.trim(),
        price_idr: Number(newPrice),
        monthly_usage_cap_usd: Number(newCap),
      });
      setPlans((prev) => [...prev, plan]);
      setNewName("");
      setNewPrice("");
      setNewCap("");
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
          flat subscription tiers — each caps usage against the LlmCall cost ledger
        </span>
      </header>

      <div className="flex-1 overflow-auto p-5 flex flex-col gap-4 max-w-2xl">
        {loading ? (
          <div className="text-sm text-muted-foreground font-mono">loading…</div>
        ) : (
          <div className="flex flex-col gap-2">
            {plans.map((p) => (
              <div key={p.id} className="border border-border px-3 py-2.5 flex flex-col gap-2">
                {editingId === p.id ? (
                  <>
                    <div className="flex items-center gap-2">
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
                        value={draft.monthly_usage_cap_usd}
                        onChange={(e) => setDraft((d) => ({ ...d, monthly_usage_cap_usd: e.target.value }))}
                        placeholder="cap USD"
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
                        {idr(p.price_idr)} · cap ${p.monthly_usage_cap_usd.toFixed(2)}/mo
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
          <div className="flex gap-2">
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
              placeholder="cap USD/mo"
              value={newCap}
              onChange={(e) => setNewCap(e.target.value)}
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
    </div>
  );
}
