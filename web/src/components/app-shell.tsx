"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Target, Settings, LogOut, MailWarning, PanelLeft, ChevronUp, Coins, Menu, X } from "lucide-react";
import { TierIcon, tierColor } from "@/lib/plan-tiers";
import { toast } from "sonner";
import { NAV_ITEMS } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { api, CREDITS_CHANGED_EVENT } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { usePersona } from "@/components/persona-provider";
import { FloatingAssistant } from "@/components/floating-assistant";
import { FloatingOnboarding } from "@/components/floating-onboarding";
import { CreditChip } from "@/components/credit-chip";
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
      toast.success("Persona created — has its own blank profile, upload a CV in the Dashboard");
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
  const { user, loading: authLoading, connectionError, retryAuth, logout } = useAuth();
  const { personas, loading, selectedPersonaId, setSelectedPersonaId } = usePersona();
  const [manageOpen, setManageOpen] = React.useState(false);
  // The desktop rail (below) always participates in layout, sized by
  // `collapsed`. Below the `lg` breakpoint it's replaced by this
  // separate off-canvas drawer instead — a permanently-visible 196px
  // (or even 52px icon-only) rail has no room to give up on a phone
  // width, so it's `fixed`+off-screen by default there and slides in
  // over the page instead of squeezing it (raised directly by Adrian:
  // "make sure every page is responsive... when open in mobile the
  // layout is adjusted" — this is the one piece of chrome every single
  // page shares, so it's the first fix).
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [unreadCount, setUnreadCount] = React.useState(0);
  const [resendingVerification, setResendingVerification] = React.useState(false);
  const [planName, setPlanName] = React.useState<string | null>(null);
  const [creditsTotal, setCreditsTotal] = React.useState<number | null>(null);
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

  // Hovering a COLLAPSED rail temporarily shows it full-width (labels
  // and all) without touching the persisted `collapsed` preference —
  // it snaps back to icon-only the moment the pointer leaves. The
  // toggle button above is the only thing that actually changes
  // `collapsed` itself, which is what makes an expand "stick" instead
  // of reverting on mouseleave (raised directly by Adrian). Never
  // relevant while already expanded, so it's harmless there regardless
  // of value.
  const [hoverExpanded, setHoverExpanded] = React.useState(false);
  const effectiveCollapsed = collapsed && !hoverExpanded;

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
  // footer, plus Phase 16's own credit balance shown right above it —
  // best-effort, same as unreadCount above; a user with no Subscription
  // row at all (shouldn't happen) just shows no decoration rather than
  // an error. Refetched on route change, on api.ts's own
  // CREDITS_CHANGED_EVENT (Adrian, direct: "why does credit in sidebar
  // not update realtime" — that event fires right after every
  // credit-charging generator/request in api.ts finishes, e.g. tailoring
  // a CV without ever navigating away used to look like "my credits
  // never went down" since nothing had a reason to refetch yet), and on
  // a 30s poll as a fallback for anything that changes the balance
  // without going through this app's own frontend at all (an admin
  // grant, a period rollover) — same "good-enough freshness, not a
  // full push mechanism" tradeoff floating-onboarding.tsx's own donut
  // already makes.
  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const refreshCredits = async () => {
      try {
        const sub = await api.getMySubscription();
        if (!cancelled) {
          setPlanName(sub.plan_name);
          setCreditsTotal(sub.credits_total);
        }
      } catch {
        // no decoration — not worth surfacing an error for this
      }
    };
    void refreshCredits();
    const interval = window.setInterval(() => void refreshCredits(), 30_000);
    const onCreditsChanged = () => void refreshCredits();
    window.addEventListener(CREDITS_CHANGED_EVENT, onCreditsChanged);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener(CREDITS_CHANGED_EVENT, onCreditsChanged);
    };
  }, [user, pathname]);


  React.useEffect(() => {
    if (authLoading) return;
    // connectionError means the mount-time /auth/me check couldn't get
    // a real answer from the server — not "you're logged out". Sending
    // someone to /login here was the actual bug: a token wiped (or, as
    // fixed now, merely a stale `user`) purely because the API hiccuped
    // for a moment, mid a refresh, was indistinguishable from a real
    // logout. Stay put and let the retry UI below handle it instead.
    if (!user && !isNoChromeRoute && !connectionError) router.replace("/login");
    else if (user && isAuthEntryRoute) router.replace(AUTHENTICATED_HOME);
    else if (user && isAdminRoute && user.role !== "admin") router.replace(AUTHENTICATED_HOME);
  }, [authLoading, user, connectionError, isNoChromeRoute, isAuthEntryRoute, isAdminRoute, pathname, router]);

  // A route change is the clearest signal navigation actually happened
  // — closing here (rather than only from each nav Link's own
  // onClick) also catches back/forward and any programmatic
  // router.push, so the drawer never stays open covering the page it
  // just navigated to.
  React.useEffect(() => {
    (() => setMobileOpen(false))();
  }, [pathname]);

  // "/", /login and /signup render standalone — no sidebar chrome, since
  // there's nothing authenticated to show yet (or, for "/", nothing that
  // needs to be — it's the public marketing page). No middleware.ts exists
  // in this app, so this redirect (plus the mirrored one above) is the
  // one real auth gate.
  if (isNoChromeRoute) return <>{children}</>;

  if (!authLoading && !user && connectionError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground font-mono">
        <div>Couldn&apos;t reach the server — your session is still saved.</div>
        <Button size="sm" variant="outline" onClick={retryAuth}>
          Retry
        </Button>
      </div>
    );
  }

  if (authLoading || !user) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground font-mono">
        loading…
      </div>
    );
  }

  // Shared between the desktop rail and the mobile drawer below — same
  // content either way. `iconOnly` (labels hidden) is a desktop-only
  // concept — driven by `effectiveCollapsed` there (the persisted
  // `collapsed` preference, overridden false while hover-expanded), so
  // the drawer always calls this with `iconOnly={false}`; `mobile`
  // swaps the collapse-toggle row for a plain Close button and makes
  // nav clicks close the drawer.
  function renderSidebarBody(iconOnly: boolean, mobile = false) {
    const closeIfMobile = mobile ? () => setMobileOpen(false) : undefined;
    // TS can't carry the `!user` narrowing from the early return above
    // across this nested closure (it can't prove `user` — a `const`
    // from useAuth() — wasn't reassigned by the time this runs, even
    // though it only ever runs synchronously within the same render) —
    // re-asserted non-null once here instead of at each use below.
    const authedUser = user!;
    return (
      <>
        {/* Signed-in only by construction (this whole sidebar is never
            reached before the `!user` early-return above), so this
            always goes to the app's real home now — previously "/"
            sent an already-authenticated user out to the marketing
            landing page (raised by Adrian). */}
        <div
          className={cn(
            "h-12 flex items-center border-b border-border",
            iconOnly ? "justify-center px-0" : "px-4",
          )}
        >
          <Link
            href="/console"
            onClick={closeIfMobile}
            className={cn(
              "flex items-center gap-2 hover:opacity-80",
              // `flex-1` alone left nothing for the outer div's own
              // justify-center to center — this single child had
              // already stretched to fill the whole row, so the icon
              // sat flush left instead (raised directly by Adrian).
              // Collapsed: shrink-to-fit so centering has something to
              // act on; expanded: back to filling the row as before.
              iconOnly ? "justify-center" : "flex-1",
            )}
          >
            <Target className="size-4 shrink-0 text-primary" strokeWidth={1.5} />
            {!iconOnly && <span className="font-mono text-sm font-semibold tracking-tight">applicient</span>}
          </Link>
          {mobile && (
            <button
              onClick={() => setMobileOpen(false)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close menu"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        <div className="h-6 flex items-center border-b border-border">
          {mobile ? (
            <div className="flex-1 h-full flex items-center justify-center">
              <ThemeToggle className="size-3.5" />
            </div>
          ) : (
            <>
              <button
                onClick={toggleCollapsed}
                className="flex-1 h-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/40"
                // The real persisted preference, not `iconOnly` — while
                // hover-expanded (iconOnly is false here, collapsed is
                // still true), this must say "Expand" and mean it:
                // clicking commits the hover preview as the new
                // persisted state, it doesn't collapse what's already
                // showing expanded.
                title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              >
                <PanelLeft className="size-3.5" />
              </button>
              <div className="flex-1 h-full flex items-center justify-center border-l border-border hover:bg-secondary/40">
                <ThemeToggle className="size-3.5" />
              </div>
            </>
          )}
        </div>

        {!iconOnly && (
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
              {!iconOnly && (
                <div className="px-4 pt-3.5 pb-1 font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                  {section}
                </div>
              )}
              {items.map(
                (item) => {
                  // Dashboard's own href is the bare "/console" root —
                  // startsWith would make it match every OTHER
                  // console page too (they all start with "/console"),
                  // so it alone needs an exact match; every other item
                  // is a real subpath, where startsWith is still right
                  // (e.g. /console/pipeline/live should still light up
                  // "Application Pipeline").
                  const active = item.href === "/console" ? pathname === "/console" : pathname.startsWith(item.href);
                  const Icon = item.icon;
                  const showBadge = item.href === "/notifications" && unreadCount > 0;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={closeIfMobile}
                      title={iconOnly ? `${item.label}${showBadge ? ` (${unreadCount})` : ""}` : undefined}
                      className={cn(
                        "flex items-center gap-2 py-1.5 text-sm border-l-2 border-transparent",
                        iconOnly ? "justify-center px-0" : "px-4",
                        active
                          ? "bg-accent text-accent-foreground font-medium border-l-primary"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className="size-3.5 shrink-0" strokeWidth={1.5} />
                      {!iconOnly && <span className="flex-1">{item.label}</span>}
                      {!iconOnly && showBadge && (
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

        <div className={cn("mt-auto border-t border-border", iconOnly ? "px-0 py-1" : "px-2 py-1.5")}>
          {/* Phase 16 — the credit balance, always visible, one click
              from Billing (raised directly by Adrian). A gold coin
              rather than anything $-shaped, consistent with credits
              being the only unit ever shown anywhere in this app —
              same CreditChip every per-feature cost badge renders
              through, so the balance and every price tag match. */}
          {iconOnly ? (
            <Link
              href="/console/billing"
              className="flex items-center justify-center py-1.5 hover:bg-secondary/40"
              title={creditsTotal !== null ? `${creditsTotal.toLocaleString()} credits` : "Billing"}
            >
              <Coins className="size-4 shrink-0 text-amber-400" strokeWidth={2} />
            </Link>
          ) : (
            <Link href="/console/billing" className="flex justify-center hover:opacity-80">
              <CreditChip>{creditsTotal !== null ? `${creditsTotal.toLocaleString()} credits` : "—"}</CreditChip>
            </Link>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  "w-full flex items-center gap-2 py-2 hover:bg-secondary/40",
                  iconOnly ? "justify-center px-0" : "px-2",
                )}
                title={iconOnly ? authedUser.email : undefined}
              >
                <TierIcon planName={planName} showTitle={iconOnly ? authedUser.email : undefined} />
                {!iconOnly && (
                  <>
                    <span
                      className="min-w-0 flex-1 truncate text-left text-[11px] font-mono"
                      style={{ color: tierColor(planName) }}
                    >
                      {authedUser.email}
                    </span>
                    <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
                  </>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-56">
              <DropdownMenuLabel>{authedUser.email}</DropdownMenuLabel>
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
      </>
    );
  }

  return (
    <div className="flex h-screen">
      {/* Mobile-only top bar — the desktop rail below is `hidden` under
          `lg`, so without this there'd be no way to reach navigation
          at all on a phone. */}
      <div className="fixed inset-x-0 top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-card px-3 lg:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Open menu"
        >
          <Menu className="size-4" />
        </button>
        <Target className="size-4 text-primary" strokeWidth={1.5} />
        <span className="font-mono text-sm font-semibold tracking-tight">applicient</span>
      </div>

      {/* Backdrop — tapping it closes the drawer, same as its own
          Close button. Sits above FloatingAssistant's own fixed
          button/panel (z-40/z-50) so the drawer always reads as the
          topmost thing while it's open. */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-[45] bg-black/40 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Desktop rail — same behavior as before, just now explicitly
          hidden below `lg` (the drawer takes over there instead of
          this permanently squeezing `main`'s width). Width (and
          everything renderSidebarBody hides/shows) is driven by
          `effectiveCollapsed`, not the raw preference — hovering a
          collapsed rail previews the expanded width via the same
          transition the toggle button itself uses, and reverts the
          instant the pointer leaves unless the toggle was actually
          clicked meanwhile (raised directly by Adrian). */}
      <aside
        onMouseEnter={() => {
          if (collapsed) setHoverExpanded(true);
        }}
        onMouseLeave={() => setHoverExpanded(false)}
        className={cn(
          "hidden lg:flex shrink-0 border-r border-border bg-card flex-col transition-[width] duration-150",
          effectiveCollapsed ? "w-[52px]" : "w-[196px]",
        )}
      >
        {renderSidebarBody(effectiveCollapsed)}
      </aside>

      {/* Mobile drawer — off-canvas by default (`fixed`, so it never
          participates in the flex row / never takes width away from
          `main`), slides in over the page instead. */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-[55] flex w-[240px] flex-col border-r border-border bg-card transition-transform duration-200 lg:hidden",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {renderSidebarBody(false, true)}
      </aside>

      <main className="flex-1 min-w-0 flex flex-col overflow-hidden pt-12 lg:pt-0">
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
      <FloatingOnboarding />
    </div>
  );
}
