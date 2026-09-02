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

// "openai_compatible" is a functional adapter key, not a brand name —
// it's how the backend knows to build a generic ChatOpenAI/
// OpenAIEmbeddings client against a user-supplied base_url (see
// tier_resolution.py). The display name for a connection made this
// way comes from its label (e.g. "Gemini"), not from this value.
const PROVIDERS = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "mistral", label: "Mistral" },
  { value: "google_ai_studio", label: "Google AI Studio (Gemini)" },
  { value: "ollama_vllm", label: "Ollama / vLLM (self-hosted)" },
  { value: "openai_compatible", label: "Custom (OpenAI-compatible)" },
] as const;

// Providers whose LangChain chat-model wiring isn't built yet
// (tier_resolution.py: catalog/pricing works today, but binding a
// tier to one of these and running it raises TierResolutionError
// until its langchain-* integration is added — not installed
// speculatively, same reasoning stated there). Surfaced here so the
// GUI doesn't imply a capability the backend doesn't have yet.
const UNWIRED_FOR_CHAT: string[] = ["anthropic", "google_ai_studio"];

// Both need a real endpoint the connection form can't guess —
// openai_compatible always did; ollama_vllm's default port differs
// between Ollama (11434) and vLLM (commonly 8000, but not guaranteed),
// so it's a real required input here too, not assumed.
function needsBaseUrl(provider: string) {
  return provider === "openai_compatible" || provider === "ollama_vllm";
}
const TIERS = ["fast", "balanced", "deep", "embedding"] as const;
type Tier = (typeof TIERS)[number];
const DEFAULT_PRESET_NAME = "openrouter-budget";

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
  const [profiles, setProfiles] = React.useState<ModelProfile[]>([]);
  // null = the editor below is building a brand-new preset, not yet
  // saved. Any existing profile's id means "editing that one in
  // place" — Save writes back to it, Activate/Delete act on it.
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [presetName, setPresetName] = React.useState(DEFAULT_PRESET_NAME);
  const [bindings, setBindings] = React.useState<Record<string, string>>({});
  const [savingBindings, setSavingBindings] = React.useState(false);
  const [profileBusy, setProfileBusy] = React.useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [newProvider, setNewProvider] = React.useState<string>("openrouter");
  const [newKey, setNewKey] = React.useState("");
  const [newLabel, setNewLabel] = React.useState("");
  const [newBaseUrl, setNewBaseUrl] = React.useState("");
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

  function loadProfileIntoEditor(profile: ModelProfile | null) {
    setEditingId(profile?.id ?? null);
    setPresetName(profile?.name ?? DEFAULT_PRESET_NAME);
    setBindings(profile?.tier_bindings ?? {});
  }

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.listModelProfiles();
        if (cancelled) return;
        setProfiles(list);
        loadProfileIntoEditor(list.find((p) => p.is_active) ?? list[0] ?? null);
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleNewPreset() {
    loadProfileIntoEditor(null);
  }

  async function handleActivateProfile(profile: ModelProfile) {
    setProfileBusy(profile.id);
    try {
      const updated = await api.activateModelProfile(profile.id);
      setProfiles((current) => current.map((p) => ({ ...p, is_active: p.id === updated.id })));
      if (editingId === updated.id) setPresetName(updated.name);
      toast.success(`"${updated.name}" is now active`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setProfileBusy(null);
    }
  }

  async function handleDeleteProfile(profile: ModelProfile) {
    if (!window.confirm(`Delete preset "${profile.name}"?`)) return;
    setProfileBusy(profile.id);
    try {
      await api.deleteModelProfile(profile.id);
      const remaining = profiles.filter((p) => p.id !== profile.id);
      setProfiles(remaining);
      if (editingId === profile.id) {
        // The backend auto-activates another remaining profile when
        // the deleted one was active (see model_profiles.py) — refetch
        // so the editor reflects whichever one that actually was
        // instead of guessing client-side.
        const list = await api.listModelProfiles();
        setProfiles(list);
        loadProfileIntoEditor(list.find((p) => p.is_active) ?? list[0] ?? null);
      }
      toast.success(`"${profile.name}" deleted`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setProfileBusy(null);
    }
  }

  // Loaded for every tested connection, not just the one highlighted
  // in the table below — tier bindings can mix providers (F12.9: any
  // tier may point at any connection's catalog), so the picker needs
  // every "ok" connection's models available at once, not just one.
  React.useEffect(() => {
    for (const conn of connections) {
      if (conn.status !== "ok" || catalogs[conn.id]) continue;
      api
        .getCatalog(conn.id)
        .then((entries) => setCatalogs((c) => ({ ...c, [conn.id]: entries })))
        .catch((e) => toast.error(String(e)));
    }
  }, [connections, catalogs]);

  const activeCatalog = React.useMemo(
    () => (selected ? (catalogs[selected] ?? []) : []),
    [selected, catalogs],
  );

  type TierOption = { entry: ModelCatalogEntry; connectionId: string; connectionLabel: string };

  const tierOptions = React.useMemo(() => {
    const options: Record<Tier, TierOption[]> = { fast: [], balanced: [], deep: [], embedding: [] };
    for (const conn of connections) {
      const connectionLabel = conn.label || conn.provider;
      for (const entry of catalogs[conn.id] ?? []) {
        const option = { entry, connectionId: conn.id, connectionLabel };
        if (entry.capabilities.includes("embedding")) {
          options.embedding.push(option);
        } else {
          options.fast.push(option);
          options.balanced.push(option);
          if (entry.capabilities.includes("structured_output")) options.deep.push(option);
        }
      }
    }
    return options;
  }, [connections, catalogs]);

  const effectiveBindings = React.useMemo(() => {
    const next = { ...bindings };
    for (const tier of TIERS) {
      const options = tierOptions[tier];
      if (options.length && !options.some(({ entry }) => entry.id === next[tier])) {
        next[tier] =
          options.find((o) => tier === "fast" && o.entry.input_price_per_mtok === 0)?.entry.id ??
          options[0].entry.id;
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

  async function handleDelete(connection: ProviderConnection) {
    const name = connection.label || connection.provider;
    if (!window.confirm(`Delete ${name}? Its cached model catalog will also be removed.`)) {
      return;
    }

    setBusy(connection.id);
    try {
      await api.deleteConnection(connection.id);
      setConnections((current) => current.filter((item) => item.id !== connection.id));
      setCatalogs((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      if (selected === connection.id) {
        setSelected(connections.find((item) => item.id !== connection.id)?.id ?? null);
      }
      toast.success(`${name} deleted`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleCreate() {
    if (needsBaseUrl(newProvider) && !newBaseUrl.trim()) {
      toast.error("Base URL is required for this provider");
      return;
    }
    setCreating(true);
    try {
      const conn = await api.createConnection({
        provider: newProvider,
        api_key: newKey,
        base_url: newBaseUrl.trim() || undefined,
        label: newLabel || undefined,
      });
      setConnections((cs) => [...cs, conn]);
      setSelected(conn.id);
      setNewKey("");
      setNewLabel("");
      setNewBaseUrl("");
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
      const body = { name: presetName.trim() || DEFAULT_PRESET_NAME, tier_bindings: effectiveBindings };
      const saved = editingId ? await api.updateModelProfile(editingId, body) : await api.createModelProfile(body);
      setProfiles((current) => {
        const withoutSaved = current.filter((p) => p.id !== saved.id);
        // A brand-new profile only comes back is_active=true if it was
        // this user's very first one ever (model_profiles.py) — either
        // way, trust the server's answer over guessing here.
        const next = saved.is_active
          ? withoutSaved.map((p) => ({ ...p, is_active: false })).concat(saved)
          : withoutSaved.concat(saved);
        return next;
      });
      loadProfileIntoEditor(saved);
      toast.success(editingId ? "Preset updated" : "Preset created");
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
                        <SelectItem key={p.value} value={p.value}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {newProvider === "openai_compatible" && (
                    <span className="text-xs text-muted-foreground">
                      Any endpoint that speaks the OpenAI chat-completions API — Gemini&apos;s
                      OpenAI-compat endpoint, Groq, Together, a local server, etc.
                    </span>
                  )}
                  {newProvider === "ollama_vllm" && (
                    <span className="text-xs text-muted-foreground">
                      A self-hosted Ollama or vLLM server — free by design, no real API key needed
                      (any placeholder works).
                    </span>
                  )}
                  {UNWIRED_FOR_CHAT.includes(newProvider) && (
                    <span className="text-xs text-warn">
                      Catalog and pricing work today, but running a tier bound to this provider
                      isn&apos;t wired up yet — see tier_resolution.py.
                    </span>
                  )}
                </div>
                {needsBaseUrl(newProvider) && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="base-url">Base URL</Label>
                    <Input
                      id="base-url"
                      value={newBaseUrl}
                      onChange={(e) => setNewBaseUrl(e.target.value)}
                      placeholder={
                        newProvider === "ollama_vllm"
                          ? "http://localhost:11434/v1"
                          : "https://generativelanguage.googleapis.com/v1beta/openai"
                      }
                    />
                  </div>
                )}
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
                    placeholder={
                      newProvider === "openai_compatible" ? "e.g. Gemini" : "e.g. Personal OpenRouter"
                    }
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  onClick={handleCreate}
                  disabled={!newKey || creating || (needsBaseUrl(newProvider) && !newBaseUrl.trim())}
                >
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
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busy === c.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(c);
                            }}
                          >
                            Delete
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
              Keep multiple presets and switch which one is active — e.g. a free/budget preset
              and a paid/quality preset for the same tiers.
            </span>
          </div>

          {profiles.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  onClick={() => loadProfileIntoEditor(p)}
                  disabled={profileBusy === p.id}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                    editingId === p.id
                      ? "border-primary bg-primary/10"
                      : "border-border bg-card hover:border-primary/50",
                  )}
                >
                  {p.is_active && <span className="size-1.5 shrink-0 rounded-full bg-ok" />}
                  {p.name}
                </button>
              ))}
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleNewPreset}>
                + New preset
              </Button>
            </div>
          )}

          {editingId && (
            <div className="flex items-center gap-2">
              {(() => {
                const current = profiles.find((p) => p.id === editingId);
                if (!current) return null;
                return (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={current.is_active || profileBusy === current.id}
                      onClick={() => handleActivateProfile(current)}
                    >
                      {current.is_active ? "Active" : "Activate"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs text-crit hover:text-crit"
                      disabled={profileBusy === current.id}
                      onClick={() => handleDeleteProfile(current)}
                    >
                      Delete preset
                    </Button>
                  </>
                );
              })()}
            </div>
          )}

          {!Object.values(tierOptions).some((options) => options.length) ? (
            <div className="border border-dashed border-input p-5 text-center text-sm text-muted-foreground">
              Test a provider and refresh its catalog to configure the tiers.
            </div>
          ) : (
            <div className="border border-border bg-card">
              {TIERS.map((tier) => {
                const options = tierOptions[tier];
                const selectedOption = options.find((o) => o.entry.id === effectiveBindings[tier]);
                // Grouped by connection so a tier bound across two
                // providers (e.g. embedding -> OpenRouter, deep ->
                // a separate Gemini connection) still reads clearly —
                // this is the whole point of sourcing tierOptions from
                // every connection instead of just the selected one.
                const byConnection = new Map<string, { label: string; options: TierOption[] }>();
                for (const option of options) {
                  if (!byConnection.has(option.connectionId)) {
                    byConnection.set(option.connectionId, { label: option.connectionLabel, options: [] });
                  }
                  byConnection.get(option.connectionId)!.options.push(option);
                }
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
                      {Array.from(byConnection.entries()).map(([connectionId, group]) => (
                        <optgroup key={connectionId} label={group.label}>
                          {group.options.map(({ entry }) => (
                            <option key={entry.id} value={entry.id}>
                              {tier === "embedding" ? `${group.label} · ` : ""}
                              {entry.model_id}
                              {entry.pricing_known
                                ? ` · $${entry.input_price_per_mtok ?? "?"}/$${entry.output_price_per_mtok ?? "?"} Mtok`
                                : " · price unknown"}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <span className="w-44 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                      {selectedOption ? (
                        <>
                          <span className="block truncate">{selectedOption.connectionLabel}</span>
                          <span>
                            {selectedOption.entry.context_window
                              ? `${Math.round(selectedOption.entry.context_window / 1000)}k context`
                              : "—"}
                          </span>
                        </>
                      ) : (
                        "—"
                      )}
                    </span>
                  </div>
                );
              })}
              <div className="flex flex-col gap-2 border-t border-border bg-secondary px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Label htmlFor="model-preset-name" className="shrink-0 text-xs text-muted-foreground">
                    {editingId ? "preset name" : "new preset name"}
                  </Label>
                  <Input
                    id="model-preset-name"
                    value={presetName}
                    onChange={(event) => setPresetName(event.target.value)}
                    maxLength={120}
                    placeholder={DEFAULT_PRESET_NAME}
                    className="h-8 max-w-sm text-xs"
                  />
                </div>
                <Button size="sm" onClick={handleSaveBindings} disabled={savingBindings}>
                  {savingBindings ? "Saving…" : editingId ? "Save changes" : "Create preset"}
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
