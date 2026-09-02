"use client";

import * as React from "react";
import { toast } from "sonner";
import { api, type Plan } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

function idr(v: number) {
  return v === 0 ? "Free" : `Rp ${v.toLocaleString("id-ID")}/mo`;
}

export default function AdminPlansPage() {
  const [plans, setPlans] = React.useState<Plan[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState({ name: "", price_idr: "", monthly_usage_cap_usd: "" });
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

  function startEdit(p: Plan) {
    setEditingId(p.id);
    setDraft({ name: p.name, price_idr: String(p.price_idr), monthly_usage_cap_usd: String(p.monthly_usage_cap_usd) });
  }

  async function saveEdit(id: string) {
    setSaving(true);
    try {
      const updated = await api.updatePlan(id, {
        name: draft.name.trim(),
        price_idr: Number(draft.price_idr),
        monthly_usage_cap_usd: Number(draft.monthly_usage_cap_usd),
      });
      setPlans((prev) => prev.map((p) => (p.id === id ? updated : p)));
      setEditingId(null);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(p: Plan) {
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
              <div key={p.id} className="border border-border px-3 py-2.5 flex items-center gap-2">
                {editingId === p.id ? (
                  <>
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
                  </>
                ) : (
                  <>
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
                    </div>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => startEdit(p)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => toggleActive(p)}>
                      {p.is_active ? "Deactivate" : "Activate"}
                    </Button>
                  </>
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
          <Button size="sm" onClick={handleCreate} disabled={creating} className="self-start">
            Add plan
          </Button>
        </div>
      </div>
    </div>
  );
}
