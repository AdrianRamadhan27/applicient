"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api, type Notification } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function relatedHref(n: Notification): string | null {
  if (n.related_type === "application" && n.related_id) return `/console/pipeline?application_id=${n.related_id}`;
  return null;
}

export default function NotificationsPage() {
  const [notifications, setNotifications] = React.useState<Notification[]>([]);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    try {
      setNotifications(await api.listNotifications());
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

  async function handleMarkRead(n: Notification) {
    if (n.read_at) return;
    try {
      const updated = await api.markNotificationRead(n.id);
      setNotifications((prev) => prev.map((x) => (x.id === n.id ? updated : x)));
    } catch (e) {
      toast.error(String(e));
    }
  }

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Notifications</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          interview invites, assessments, offers, approaching deadlines, daily summary
        </span>
      </header>

      <div className="flex-1 overflow-auto p-5">
        {loading ? (
          <div className="text-sm text-muted-foreground font-mono">loading…</div>
        ) : notifications.length === 0 ? (
          <div className="text-sm text-muted-foreground border border-dashed border-input p-6 text-center">
            No notifications yet — connect Gmail and label some application emails to see activity here.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {notifications.map((n) => {
              const href = relatedHref(n);
              const unread = !n.read_at;
              const content = (
                <div
                  className={cn(
                    "border border-border bg-card px-4 py-3 flex items-start justify-between gap-3",
                    unread && "border-l-2 border-l-primary",
                  )}
                >
                  <div className="min-w-0">
                    <div className={cn("text-sm", unread && "font-semibold")}>{n.subject}</div>
                    {n.body && <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.body}</div>}
                    <div className="text-[11px] text-muted-foreground font-mono mt-1">
                      {n.sent_at ? new Date(n.sent_at).toLocaleString() : ""}
                    </div>
                  </div>
                  {unread && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(e) => {
                        e.preventDefault();
                        handleMarkRead(n);
                      }}
                    >
                      Mark read
                    </Button>
                  )}
                </div>
              );
              return href ? (
                <Link key={n.id} href={href} onClick={() => handleMarkRead(n)} className="block">
                  {content}
                </Link>
              ) : (
                <div key={n.id}>{content}</div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
