"use client";

import * as React from "react";
import { toast } from "sonner";
import { api, type AdminUser } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TierLabel } from "@/lib/plan-tiers";
import { cn } from "@/lib/utils";

function money(v: number) {
  if (v === 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(2)}`;
}

export default function AdminUsersPage() {
  const [users, setUsers] = React.useState<AdminUser[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setUsers(await api.listAdminUsers());
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

  async function run(action: (id: string) => Promise<AdminUser>, id: string) {
    setBusyId(id);
    try {
      const updated = await action(id);
      setUsers((prev) => prev.map((u) => (u.id === id ? updated : u)));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Users</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          every tenant on this deployment, their plan, and current-period spend
        </span>
      </header>

      <div className="flex-1 overflow-auto p-5">
        {loading ? (
          <div className="text-sm text-muted-foreground font-mono">loading…</div>
        ) : (
          <div className="border border-border">
            <div className="grid grid-cols-[1fr_100px_90px_110px_100px_180px] gap-2 px-3 py-2 border-b border-border bg-secondary/40 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              <span>Email</span>
              <span>Role</span>
              <span>Status</span>
              <span>Plan</span>
              <span>Spend (period)</span>
              <span className="text-right">Actions</span>
            </div>
            {users.map((u) => (
              <div
                key={u.id}
                className="grid grid-cols-[1fr_100px_90px_110px_100px_180px] gap-2 px-3 py-2 border-b border-border last:border-b-0 items-center text-sm"
              >
                <span className="truncate font-mono text-xs">{u.email}</span>
                <Badge variant="secondary" className="text-[9px] font-mono w-fit">
                  {u.role}
                </Badge>
                <span className={cn("text-[11px] font-mono", u.is_active ? "text-ok" : "text-crit")}>
                  {u.is_active ? "active" : "suspended"}
                </span>
                <TierLabel planName={u.plan_name} className="text-xs text-muted-foreground">
                  {u.plan_name ?? "—"}
                </TierLabel>
                <span className="text-xs font-mono tabular">{money(u.current_period_spend_usd)}</span>
                <div className="flex justify-end gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
                    disabled={busyId === u.id}
                    onClick={() => run(u.is_active ? api.suspendUser : api.unsuspendUser, u.id)}
                  >
                    {u.is_active ? "Suspend" : "Unsuspend"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
                    disabled={busyId === u.id}
                    onClick={() => run(u.role === "admin" ? api.demoteUser : api.promoteUser, u.id)}
                  >
                    {u.role === "admin" ? "Demote" : "Promote"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
