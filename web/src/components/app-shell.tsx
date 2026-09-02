"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Target, Settings, LogOut, MailWarning, PanelLeft, ChevronUp } from "lucide-react";
import { TierIcon, tierColor } from "@/lib/plan-tiers";
import { toast } from "sonner";
import { NAV_ITEMS } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { usePersona } from "@/components/persona-provider";
import { FloatingAssistant } from "@/components/floating-assistant";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
// or a forbidden admin route — Phase 14 (v2 plan): the new /console
// dashboard, not a specific feature page.
const AUTHENTICATED_HOME = "/console";

// SaaS pivot — a signed-in non-admin who navigates straight to an
// admin-only URL (rather than clicking a hidden nav item) gets
// redirected instead of a raw 403 error toast. Backend routes remain
// the real boundary (current_admin_user) regardless.
const ADMIN_ROUTE_PREFIXES = NAV_ITEMS.filter((item) => item.adminOnly).map((item) => item.href);

const SIDEBAR_COLLAPSED_KEY = "applicient.sidebar-collapsed";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading: authLoading, logout } = useAuth();
  const { personas, loading, selectedPersonaId, setSelectedPersonaId } = usePersona();
  const [manageOpen, setManageOpen] = React.useState(false);
  const [unreadCount, setUnreadCount] = React.useState(0);
  const [resendingVerification, setResendingVerification] = React.useState(false);
  const [planName, setPlanName] = React.useState<string | null>(null);
  // Lazily read localStorage in the initializer (not a plain
  // useState(false) + effect), same reasoning as pipeline/page.tsx's
  // own panel-width state — avoids a visible expanded->collapsed snap
  // right after mount for a user who collapsed it last session.
  const [collapsed, setCollapsed] = React.useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // best-effort — a per-viewer convenience, not data that needs to persist reliably
      }
      return next;
    });
  }

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

  // Drives the tier decoration next to the user's own name in the
  // footer — best-effort, same as unreadCount above; a user with no
  // Subscription row at all (shouldn't happen, same gap
  // billing_service.enforce_usage_cap already tolerates) just shows no
  // decoration rather than an error.
  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const sub = await api.getMySubscription();
        if (!cancelled) setPlanName(sub.plan_name);
      } catch {
        // no decoration — not worth surfacing an error for this
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);


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
      <aside
        className={cn(
          "shrink-0 border-r border-border bg-card flex flex-col transition-[width] duration-150",
          collapsed ? "w-[52px]" : "w-[196px]",
        )}
      >
        {/* Signed-in only by construction (this whole <aside> is never
            reached before the `!user` early-return above), so this
            always goes to the app's real home now — previously "/"
            sent an already-authenticated user out to the marketing
            landing page (raised by Adrian). */}
        <Link
          href="/console"
          className={cn(
            "h-12 flex items-center gap-2 border-b border-border hover:bg-secondary/40",
            collapsed ? "justify-center px-0" : "px-4",
          )}
        >
          <Target className="size-4 shrink-0 text-primary" strokeWidth={1.5} />
          {!collapsed && <span className="font-mono text-sm font-semibold tracking-tight">applicient</span>}
        </Link>

        <div className="h-6 flex items-center border-b border-border">
          <button
            onClick={toggleCollapsed}
            className="flex-1 h-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/40"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <PanelLeft className="size-3.5" />
          </button>
          <div className="flex-1 h-full flex items-center justify-center border-l border-border hover:bg-secondary/40">
            <ThemeToggle className="size-3.5" />
          </div>
        </div>

        {!collapsed && (
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
        )}

        <nav className="flex flex-col py-2 overflow-y-auto">
          {SECTIONS.map((section) => {
            const items = NAV_ITEMS.filter(
              (item) => item.section === section && (!item.adminOnly || user?.role === "admin"),
            );
            if (items.length === 0) return null;
            return (
            <div key={section}>
              {!collapsed && (
                <div className="px-4 pt-3.5 pb-1 font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                  {section}
                </div>
              )}
              {items.map(
                (item) => {
                  const active = pathname.startsWith(item.href);
                  const Icon = item.icon;
                  const showBadge = item.href === "/notifications" && unreadCount > 0;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={collapsed ? `${item.label}${showBadge ? ` (${unreadCount})` : ""}` : undefined}
                      className={cn(
                        "flex items-center gap-2 py-1.5 text-sm border-l-2 border-transparent",
                        collapsed ? "justify-center px-0" : "px-4",
                        active
                          ? "bg-accent text-accent-foreground font-medium border-l-primary"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className="size-3.5 shrink-0" strokeWidth={1.5} />
                      {!collapsed && <span className="flex-1">{item.label}</span>}
                      {!collapsed && showBadge && (
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

        <div className={cn("mt-auto border-t border-border", collapsed ? "px-0" : "px-2 py-1")}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  "w-full flex items-center gap-2 py-2 hover:bg-secondary/40",
                  collapsed ? "justify-center px-0" : "px-2",
                )}
                title={collapsed ? user.email : undefined}
              >
                <TierIcon planName={planName} showTitle={collapsed ? user.email : undefined} />
                {!collapsed && (
                  <>
                    <span
                      className="min-w-0 flex-1 truncate text-left text-[11px] font-mono"
                      style={{ color: tierColor(planName) }}
                    >
                      {user.email}
                    </span>
                    <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
                  </>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-56">
              <DropdownMenuLabel>{user.email}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  // A hard navigation, not router.replace — logging out
                  // synchronously clears `user`, which re-fires this
                  // component's own auth-guard effect below (still
                  // reading the OLD pathname, since usePathname() hasn't
                  // caught up to a router.replace that hasn't resolved
                  // yet) — that guard's own router.replace("/login") was
                  // winning the race, landing here instead of "/"
                  // (raised by Adrian). Assigning location.href starts
                  // a real page unload immediately, so nothing in this
                  // about-to-be-destroyed React tree gets a chance to
                  // fire a competing navigation.
                  logout();
                  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate hard navigation, see comment above
                  window.location.href = "/";
                }}
              >
                <LogOut className="size-3.5" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
        <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      </main>

      <ManagePersonasDialog open={manageOpen} onOpenChange={setManageOpen} />
      <FloatingAssistant />
    </div>
  );
}
