"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Target, Settings, LogOut, MailWarning } from "lucide-react";
import { toast } from "sonner";
import { NAV_ITEMS } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ThemeToggle } from "@/components/theme-toggle";
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

const SECTIONS = ["Work", "System", "Admin"] as const;

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

// "/" is the public marketing landing page (SaaS pivot) — renders with
// no sidebar chrome for everyone, signed in or not, and unlike
// /login|/signup never redirects anyone away from it. AUTH_ENTRY_ROUTES
// are the ones an already-authenticated user has no reason to be on.
const NO_CHROME_ROUTES = ["/", "/login", "/signup", "/auth/google/callback", "/privacy", "/terms"];
const AUTH_ENTRY_ROUTES = ["/login", "/signup"];
// Where an authenticated user gets sent instead of an auth-entry page
// or a forbidden admin route — nav.ts's own comment already calls this
// "the primary entry point that drives the other four."
const AUTHENTICATED_HOME = "/assistant";

// SaaS pivot — a signed-in non-admin who navigates straight to an
// admin-only URL (rather than clicking a hidden nav item) gets
// redirected instead of a raw 403 error toast. Backend routes remain
// the real boundary (current_admin_user) regardless.
const ADMIN_ROUTE_PREFIXES = NAV_ITEMS.filter((item) => item.adminOnly).map((item) => item.href);

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading: authLoading, logout } = useAuth();
  const { personas, loading, selectedPersonaId, setSelectedPersonaId } = usePersona();
  const [manageOpen, setManageOpen] = React.useState(false);
  const [unreadCount, setUnreadCount] = React.useState(0);
  const [resendingVerification, setResendingVerification] = React.useState(false);

  async function handleResendVerification() {
    setResendingVerification(true);
    try {
      await api.resendVerification();
      toast.success("Verification email sent — check your inbox.");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setResendingVerification(false);
    }
  }

  const isNoChromeRoute = NO_CHROME_ROUTES.includes(pathname);
  const isAuthEntryRoute = AUTH_ENTRY_ROUTES.includes(pathname);
  const isAdminRoute = ADMIN_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  const refreshUnreadCount = React.useCallback(async () => {
    try {
      const { count } = await api.unreadNotificationCount();
      setUnreadCount(count);
    } catch {
      // best-effort — a failed count fetch shouldn't disrupt the shell
    }
  }, []);

  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      if (!cancelled) await refreshUnreadCount();
    })();
    const interval = setInterval(refreshUnreadCount, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user, refreshUnreadCount, pathname]);

  React.useEffect(() => {
    if (authLoading) return;
    if (!user && !isNoChromeRoute) router.replace("/login");
    else if (user && isAuthEntryRoute) router.replace(AUTHENTICATED_HOME);
    else if (user && isAdminRoute && user.role !== "admin") router.replace(AUTHENTICATED_HOME);
  }, [authLoading, user, isNoChromeRoute, isAuthEntryRoute, isAdminRoute, pathname, router]);

  // "/", /login and /signup render standalone — no sidebar chrome, since
  // there's nothing authenticated to show yet (or, for "/", nothing that
  // needs to be — it's the public marketing page). No middleware.ts exists
  // in this app, so this redirect (plus the mirrored one above) is the
  // one real auth gate.
  if (isNoChromeRoute) return <>{children}</>;

  if (authLoading || !user) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground font-mono">
        loading…
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <aside className="w-[196px] shrink-0 border-r border-border bg-card flex flex-col">
        <Link href="/" className="h-12 flex items-center gap-2 px-4 border-b border-border hover:bg-secondary/40">
          <Target className="size-4 text-primary" strokeWidth={1.5} />
          <span className="font-mono text-sm font-semibold tracking-tight">
            applicient
          </span>
        </Link>

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
          {SECTIONS.map((section) => {
            const items = NAV_ITEMS.filter(
              (item) => item.section === section && (!item.adminOnly || user?.role === "admin"),
            );
            if (items.length === 0) return null;
            return (
            <div key={section}>
              <div className="px-4 pt-3.5 pb-1 font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                {section}
              </div>
              {items.map(
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
                      <span className="flex-1">{item.label}</span>
                      {item.href === "/notifications" && unreadCount > 0 && (
                        <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-mono leading-none text-primary-foreground">
                          {unreadCount > 99 ? "99+" : unreadCount}
                        </span>
                      )}
                    </Link>
                  );
                },
              )}
            </div>
            );
          })}
        </nav>

        <div className="mt-auto border-t border-border px-4 py-2.5 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[11px] font-mono text-muted-foreground" title={user.email}>
            {user.email}
          </span>
          <div className="flex items-center gap-2.5 shrink-0">
            <ThemeToggle className="size-3.5" />
            <button
              onClick={() => {
                logout();
                router.replace("/login");
              }}
              className="text-muted-foreground hover:text-foreground"
              title="Log out"
            >
              <LogOut className="size-3.5" />
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {user && !user.email_verified && (
          <div className="flex items-center gap-2 border-b border-warn bg-warn/10 px-4 py-1.5 text-xs text-warn">
            <MailWarning className="size-3.5 shrink-0" />
            <span className="flex-1">Verify your email to keep full access to your account.</span>
            <button
              onClick={handleResendVerification}
              disabled={resendingVerification}
              className="shrink-0 underline hover:no-underline disabled:opacity-50"
            >
              {resendingVerification ? "Sending…" : "Resend email"}
            </button>
          </div>
        )}
        {children}
      </main>

      <ManagePersonasDialog open={manageOpen} onOpenChange={setManageOpen} />
    </div>
  );
}
