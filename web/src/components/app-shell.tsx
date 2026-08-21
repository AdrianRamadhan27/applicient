"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Target, Settings } from "lucide-react";
import { toast } from "sonner";
import { NAV_ITEMS } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { usePersona } from "@/components/persona-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const SECTIONS = ["Work", "System"] as const;

/** Persona create/rename/delete used to live only inside Radar's Setup
 * dialog (a leftover from when it was first built, since SavedSearch
 * was the first thing that needed a persona binding) — moved here so
 * it's reachable from anywhere, next to the switcher that now actually
 * matters (each persona owns its own Profile/evidence bank, not just
 * a name). */
function ManagePersonasDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { personas, refreshPersonas, selectedPersonaId, setSelectedPersonaId } = usePersona();
  const [newName, setNewName] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const persona = await api.createPersona({ name: newName.trim() });
      setNewName("");
      await refreshPersonas();
      setSelectedPersonaId(persona.id);
      toast.success("Persona created — has its own blank profile, upload a CV in Profile Studio");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCreating(false);
    }
  }

  async function handleRename(id: string) {
    if (!renameValue.trim()) return;
    try {
      await api.updatePersona(id, { name: renameValue.trim() });
      setRenamingId(null);
      await refreshPersonas();
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deletePersona(id);
      await refreshPersonas();
      toast.success("Persona and its profile/evidence bank deleted");
    } catch (e) {
      toast.error(String(e));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Personas</DialogTitle>
          <DialogDescription>
            Each persona owns its own profile and evidence bank — deleting one deletes its CV data too, not just
            the name.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 py-2">
          {personas.map((p) => (
            <div key={p.id} className="flex items-center gap-2 border border-border px-3 py-1.5 text-sm">
              {renamingId === p.id ? (
                <>
                  <Input
                    className="h-7 flex-1"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    autoFocus
                  />
                  <Button size="sm" onClick={() => handleRename(p.id)}>
                    Save
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setRenamingId(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <span
                    className={cn("flex-1 cursor-pointer", p.id === selectedPersonaId && "font-medium")}
                    onClick={() => setSelectedPersonaId(p.id)}
                  >
                    {p.name}
                    {p.id === selectedPersonaId && (
                      <span className="ml-1.5 font-mono text-[9px] text-muted-foreground">selected</span>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setRenamingId(p.id);
                      setRenameValue(p.name);
                    }}
                  >
                    Rename
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => handleDelete(p.id)}>
                    Delete
                  </Button>
                </>
              )}
            </div>
          ))}
          <div className="flex gap-2">
            <Input
              placeholder="e.g. Backend Engineer track"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Button size="sm" onClick={handleCreate} disabled={creating || !newName.trim()}>
              Add
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { personas, loading, selectedPersonaId, setSelectedPersonaId } = usePersona();
  const [manageOpen, setManageOpen] = React.useState(false);

  return (
    <div className="flex h-screen">
      <aside className="w-[196px] shrink-0 border-r border-border bg-card flex flex-col">
        <div className="h-12 flex items-center gap-2 px-4 border-b border-border">
          <Target className="size-4 text-primary" strokeWidth={1.5} />
          <span className="font-mono text-sm font-semibold tracking-tight">
            applicient
          </span>
        </div>

        <div className="px-3 py-2.5 border-b border-border flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">Persona</span>
            <button
              onClick={() => setManageOpen(true)}
              className="text-muted-foreground hover:text-foreground"
              title="Manage personas"
            >
              <Settings className="size-3.5" />
            </button>
          </div>
          {loading ? (
            <span className="text-xs text-muted-foreground font-mono">loading…</span>
          ) : personas.length === 0 ? (
            <button
              onClick={() => setManageOpen(true)}
              className="text-xs text-left text-muted-foreground hover:text-foreground underline"
            >
              + New persona
            </button>
          ) : (
            <Select value={selectedPersonaId} onValueChange={setSelectedPersonaId}>
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {personas.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <nav className="flex flex-col py-2">
          {SECTIONS.map((section) => (
            <div key={section}>
              <div className="px-4 pt-3.5 pb-1 font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                {section}
              </div>
              {NAV_ITEMS.filter((item) => item.section === section).map(
                (item) => {
                  const active = pathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "flex items-center px-4 py-1.5 text-sm border-l-2 border-transparent",
                        active
                          ? "bg-accent text-accent-foreground font-medium border-l-primary"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {item.label}
                    </Link>
                  );
                },
              )}
            </div>
          ))}
        </nav>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {children}
      </main>

      <ManagePersonasDialog open={manageOpen} onOpenChange={setManageOpen} />
    </div>
  );
}
