"use client";

import * as React from "react";
import { toast } from "sonner";
import { api, type Credential } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Eye, EyeOff } from "lucide-react";

// M5 F8.1/F8.2's Gmail connect section used to live here — moved to
// Email Review, next to the feature it actually feeds instead of
// alongside unrelated site-login credentials (raised directly by
// Adrian). See email-review/page.tsx's own GmailSection.

export default function CredentialsPage() {
  const [credentials, setCredentials] = React.useState<Credential[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [newLabel, setNewLabel] = React.useState("");
  const [newIdentifier, setNewIdentifier] = React.useState("");
  const [newSecret, setNewSecret] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [showSecret, setShowSecret] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      setCredentials(await api.listCredentials());
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function handleCreate() {
    if (!newLabel.trim() || !newIdentifier.trim() || !newSecret) {
      toast.error("Label, identifier, and secret are all required");
      return;
    }
    setCreating(true);
    try {
      const cred = await api.createCredential({
        label: newLabel.trim(),
        identifier: newIdentifier.trim(),
        secret: newSecret,
      });
      setCredentials((cs) => [...cs, cred]);
      setNewLabel("");
      setNewIdentifier("");
      setNewSecret("");
      setShowSecret(false);
      setDialogOpen(false);
      toast.success(`"${cred.label}" saved — encrypted at rest, never shown again`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(cred: Credential) {
    if (!window.confirm(`Delete the stored credential "${cred.label}"?`)) return;
    setBusy(cred.id);
    try {
      await api.deleteCredential(cred.id);
      setCredentials((cs) => cs.filter((c) => c.id !== cred.id));
      toast.success(`"${cred.label}" deleted`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Credentials</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          used by the application-agent to log in — never seen by the LLM
        </span>
        <div className="ml-auto">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              Add credential
            </Button>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add stored credential</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-4 py-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cred-label">Label</Label>
                  <Input
                    id="cred-label"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder="e.g. linkedin"
                  />
                  <span className="text-xs text-muted-foreground">
                    Lowercase, short — this is the exact name the agent looks up (e.g.
                    &quot;linkedin&quot; for a LinkedIn login).
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cred-identifier">Username / email</Label>
                  <Input
                    id="cred-identifier"
                    value={newIdentifier}
                    onChange={(e) => setNewIdentifier(e.target.value)}
                    placeholder="you@example.com"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cred-secret">Password</Label>
                  <div className="relative">
                    <Input
                      id="cred-secret"
                      type={showSecret ? "text" : "password"}
                      autoComplete="off"
                      value={newSecret}
                      onChange={(e) => setNewSecret(e.target.value)}
                      placeholder="••••••••"
                      className="pr-8"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSecret((v) => !v)}
                      className="absolute inset-y-0 right-0 flex items-center px-2 text-muted-foreground hover:text-foreground"
                      aria-label={showSecret ? "Hide password" : "Show password"}
                      tabIndex={-1}
                    >
                      {showSecret ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </button>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    Encrypted at rest. Never shown again after saving, and never sent to any
                    LLM — only used server-side to fill a login field directly.
                  </span>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleCreate} disabled={creating}>
                  {creating ? "Saving…" : "Save"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-5">
        {loading ? (
          <div className="text-sm text-muted-foreground font-mono">loading…</div>
        ) : credentials.length === 0 ? (
          <div className="text-sm text-muted-foreground border border-dashed border-input p-6 text-center">
            No stored credentials yet. Add one (e.g. &quot;linkedin&quot;) so the
            application-agent can log in on its own instead of asking you for a password
            mid-run.
          </div>
        ) : (
          <div className="border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[160px]">Label</TableHead>
                  <TableHead>Identifier</TableHead>
                  <TableHead className="w-[160px]">Secret</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {credentials.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium font-mono">{c.label}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{c.identifier}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {c.secret_hint}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy === c.id}
                        onClick={() => handleDelete(c)}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
