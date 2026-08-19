"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  api,
  type ModelCatalogEntry,
  type ModelProfile,
  type ProviderConnection,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const PROVIDERS = ["openrouter", "anthropic"] as const;
const TIERS = ["fast", "balanced", "deep", "embedding"] as const;
type Tier = (typeof TIERS)[number];

function statusColor(status: ProviderConnection["status"]) {
  switch (status) {
    case "ok":
      return "bg-ok-bg text-ok";
    case "untested":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-crit-bg text-crit";
  }
}

function money(v: number | null) {
  if (v === null) return "—";
  if (v === 0) return "free";
  return `$${v.toFixed(2)}`;
}

export default function ModelsPage() {
  const [connections, setConnections] = React.useState<ProviderConnection[]>([]);
  const [catalogs, setCatalogs] = React.useState<Record<string, ModelCatalogEntry[]>>({});
  const [selected, setSelected] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [modelProfile, setModelProfile] = React.useState<ModelProfile | null>(null);
  const [bindings, setBindings] = React.useState<Record<string, string>>({});
  const [savingBindings, setSavingBindings] = React.useState(false);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [newProvider, setNewProvider] = React.useState<string>("openrouter");
  const [newKey, setNewKey] = React.useState("");
  const [newLabel, setNewLabel] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const loadConnections = React.useCallback(async () => {
    const conns = await api.listConnections();
    setConnections(conns);
    if (conns.length && !selected) setSelected(conns[0].id);
    return conns;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Standard fetch-on-mount pattern (React docs: "Fetching data"): an
  // async IIFE inside the effect, guarded against setting state after
  // unmount. The lint rule flags setState reachable from an effect
  // body in general, including this shape — deliberate exception, not
  // an oversight; the alternative (a state library) is real overkill
  // for one initial fetch.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadConnections();
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadConnections]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const profile = await api.getActiveModelProfile();
        if (!cancelled) {
          setModelProfile(profile);
          setBindings(profile?.tier_bindings ?? {});
        }
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!selected || catalogs[selected]) return;
    api
      .getCatalog(selected)
      .then((entries) => setCatalogs((c) => ({ ...c, [selected]: entries })))
      .catch((e) => toast.error(String(e)));
  }, [selected, catalogs]);

  const activeCatalog = React.useMemo(
    () => (selected ? (catalogs[selected] ?? []) : []),
    [selected, catalogs],
  );

  const tierOptions = React.useMemo(() => {
    const options: Record<Tier, ModelCatalogEntry[]> = {
      fast: [],
      balanced: [],
      deep: [],
      embedding: [],
    };
    for (const entry of activeCatalog) {
      if (entry.capabilities.includes("embedding")) {
        options.embedding.push(entry);
      } else {
        options.fast.push(entry);
        options.balanced.push(entry);
        if (entry.capabilities.includes("structured_output")) options.deep.push(entry);
      }
    }
    return options;
  }, [activeCatalog]);

  const effectiveBindings = React.useMemo(() => {
    const next = { ...bindings };
    for (const tier of TIERS) {
      const options = tierOptions[tier];
      if (options.length && !options.some((entry) => entry.id === next[tier])) {
        next[tier] =
          options.find((entry) => tier === "fast" && entry.input_price_per_mtok === 0)?.id ??
          options[0].id;
      }
    }
    return next;
  }, [bindings, tierOptions]);

  async function handleTest(id: string) {
    setBusy(id);
    try {
      const updated = await api.testConnection(id);
      setConnections((cs) => cs.map((c) => (c.id === id ? updated : c)));
      toast[updated.status === "ok" ? "success" : "error"](
        updated.status === "ok" ? "Connection OK" : (updated.last_error ?? updated.status),
      );
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleRefresh(id: string) {
    setBusy(id);
    try {
      const entries = await api.refreshCatalog(id);
      setCatalogs((c) => ({ ...c, [id]: entries }));
      toast.success(`Catalog refreshed — ${entries.length} models`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleCreate() {
    setCreating(true);
    try {
      const conn = await api.createConnection({
        provider: newProvider,
        api_key: newKey,
        label: newLabel || undefined,
      });
      setConnections((cs) => [...cs, conn]);
      setSelected(conn.id);
      setNewKey("");
      setNewLabel("");
      setDialogOpen(false);
      toast.success("Connection added — test it to verify the key");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCreating(false);
    }
  }

  async function handleSaveBindings() {
    if (!effectiveBindings.deep || !effectiveBindings.embedding) {
      toast.error("Choose both a deep model and an embedding model before saving");
      return;
    }
    setSavingBindings(true);
    try {
      const saved = await api.saveActiveModelProfile({
        name: modelProfile?.name ?? "openrouter-budget",
        tier_bindings: effectiveBindings,
      });
      setModelProfile(saved);
      setBindings(saved.tier_bindings);
      toast.success("Tier bindings saved — CV ingest is ready");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSavingBindings(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Models &amp; Providers</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          changes apply to the next run
        </span>
        <div className="ml-auto">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">Add provider</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add provider connection</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-4 py-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="provider">Provider</Label>
                  <Select value={newProvider} onValueChange={setNewProvider}>
                    <SelectTrigger id="provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="key">API key</Label>
                  <Input
                    id="key"
                    type="password"
                    autoComplete="off"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    placeholder="sk-..."
                  />
                  <span className="text-xs text-muted-foreground">
                    Encrypted at rest. Never shown again after saving.
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="label">Label (optional)</Label>
                  <Input
                    id="label"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder="e.g. Personal OpenRouter"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleCreate} disabled={!newKey || creating}>
                  {creating ? "Saving…" : "Save"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-5 flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
            Provider connections
          </span>
          {loading ? (
            <div className="text-sm text-muted-foreground font-mono">loading…</div>
          ) : connections.length === 0 ? (
            <div className="text-sm text-muted-foreground border border-dashed border-input p-6 text-center">
              No providers connected yet. Add one to get started — OpenRouter&apos;s
              free tier covers this app&apos;s shipped default (§17).
            </div>
          ) : (
            <div className="border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[140px]">Provider</TableHead>
                    <TableHead>Credential</TableHead>
                    <TableHead className="w-[140px]">Status</TableHead>
                    <TableHead className="w-[120px]">Catalog</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {connections.map((c) => (
                    <TableRow
                      key={c.id}
                      data-state={selected === c.id ? "selected" : undefined}
                      onClick={() => setSelected(c.id)}
                      className="cursor-pointer"
                    >
                      <TableCell className="font-medium">
                        {c.label || c.provider}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {c.api_key_hint}
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            "inline-flex items-center gap-1.5 px-2 py-0.5 font-mono text-[10px] uppercase",
                            statusColor(c.status),
                          )}
                        >
                          <span className="size-1.5 rounded-full bg-current" />
                          {c.status}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {catalogs[c.id]?.length ?? "—"} models
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === c.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleTest(c.id);
                            }}
                          >
                            Test
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === c.id || c.status !== "ok"}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRefresh(c.id);
                            }}
                          >
                            Refresh catalog
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
              Tier bindings
            </span>
            <span className="text-[11px] text-muted-foreground">
              Agents ask for a capability tier; this is the only place a model is selected.
            </span>
          </div>
          {!selected || !activeCatalog.length ? (
            <div className="border border-dashed border-input p-5 text-center text-sm text-muted-foreground">
              Test a provider and refresh its catalog to configure the tiers.
            </div>
          ) : (
            <div className="border border-border bg-card">
              {TIERS.map((tier) => {
                const options = tierOptions[tier];
                const selectedEntry = options.find((entry) => entry.id === effectiveBindings[tier]);
                return (
                  <div
                    key={tier}
                    className="flex flex-col gap-2 border-b border-border p-3 last:border-b-0 sm:flex-row sm:items-center"
                  >
                    <span className="w-24 shrink-0 font-mono text-xs font-medium">{tier}</span>
                    <select
                      value={effectiveBindings[tier] ?? ""}
                      onChange={(event) =>
                        setBindings((current) => ({ ...current, [tier]: event.target.value }))
                      }
                      className="h-8 min-w-0 flex-1 border border-input bg-background px-2 font-mono text-xs"
                    >
                      <option value="" disabled>
                        No compatible model in this catalog
                      </option>
                      {options.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.model_id}
                          {entry.pricing_known
                            ? ` · $${entry.input_price_per_mtok ?? "?"}/$${entry.output_price_per_mtok ?? "?"} Mtok`
                            : " · price unknown"}
                        </option>
                      ))}
                    </select>
                    <span className="w-28 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                      {selectedEntry?.context_window
                        ? `${Math.round(selectedEntry.context_window / 1000)}k context`
                        : "—"}
                    </span>
                  </div>
                );
              })}
              <div className="flex items-center justify-between gap-3 border-t border-border bg-secondary px-3 py-2">
                <span className="text-xs text-muted-foreground">
                  {modelProfile ? `active preset: ${modelProfile.name}` : "not saved yet"}
                </span>
                <Button size="sm" onClick={handleSaveBindings} disabled={savingBindings}>
                  {savingBindings ? "Saving…" : "Save bindings"}
                </Button>
              </div>
            </div>
          )}
        </section>

        {selected && (
          <section className="flex flex-col gap-2 min-h-0">
            <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
              Model catalog — {activeCatalog.length} models
            </span>
            <div className="border border-border bg-card overflow-auto max-h-[520px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="w-[90px]">Context</TableHead>
                    <TableHead>Capabilities</TableHead>
                    <TableHead className="text-right w-[160px]">
                      Price / Mtok in · out
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeCatalog.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="font-mono text-xs">{m.model_id}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground tabular">
                        {m.context_window ? `${Math.round(m.context_window / 1000)}k` : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {m.capabilities.map((cap) => (
                            <Badge key={cap} variant="secondary" className="text-[9px] font-mono">
                              {cap}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular">
                        {m.pricing_known
                          ? `${money(m.input_price_per_mtok)} · ${money(m.output_price_per_mtok)}`
                          : "unknown"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
