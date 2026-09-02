"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  api,
  CALENDAR_EVENT_TYPES,
  CALENDAR_EVENT_TYPE_LABEL,
  type Application,
  type CalendarEvent,
  type CalendarEventType,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight, Mail, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

const NO_APPLICATION = "none";

const CHIP_CLASS: Record<CalendarEventType, string> = {
  interview: "bg-ok-bg text-ok border-l-ok",
  assessment_deadline: "bg-warn-bg text-warn border-l-warn",
  application_deadline: "bg-crit-bg text-crit border-l-crit",
  custom: "bg-secondary text-secondary-foreground border-l-muted-foreground",
};

const AUTO_DETECTED_PREFIX = "Auto-detected from email";
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** `datetime-local` inputs want/give local wall-clock time with no
 * timezone suffix — these two convert between that and the ISO string
 * the API stores, in the browser's own local timezone both ways. */
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocal(value: string): string {
  return new Date(value).toISOString();
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function sameDay(a: Date, b: Date): boolean {
  return dateKey(a) === dateKey(b);
}

/** 6 full weeks (42 days), Monday-first, spanning whatever range covers
 * `monthDate`'s whole month — the standard month-grid shape, padded
 * with the tail end of the previous/next month rather than leaving
 * ragged edges. */
function buildMonthGrid(monthDate: Date): Date[] {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const first = new Date(year, month, 1);
  const firstWeekday = (first.getDay() + 6) % 7; // Monday = 0
  const start = new Date(year, month, 1 - firstWeekday);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

export default function CalendarPage() {
  const [events, setEvents] = React.useState<CalendarEvent[]>([]);
  const [applications, setApplications] = React.useState<Application[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [month, setMonth] = React.useState(() => {
    const d = new Date();
    d.setDate(1);
    return d;
  });
  const [dragOverKey, setDragOverKey] = React.useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CalendarEvent | null>(null);
  const [title, setTitle] = React.useState("");
  const [eventType, setEventType] = React.useState<CalendarEventType>("custom");
  const [scheduledAt, setScheduledAt] = React.useState("");
  const [applicationId, setApplicationId] = React.useState<string>(NO_APPLICATION);
  const [notes, setNotes] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [ev, apps] = await Promise.all([api.listCalendarEvents(), api.listApplications()]);
      setEvents(ev);
      setApplications(apps);
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

  const eventsByDay = React.useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      const key = dateKey(new Date(ev.scheduled_at));
      const list = map.get(key) ?? [];
      list.push(ev);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
    return map;
  }, [events]);

  const days = React.useMemo(() => buildMonthGrid(month), [month]);

  function openCreate(defaultDate?: Date) {
    setEditing(null);
    setTitle("");
    setEventType("custom");
    const when = defaultDate ? new Date(defaultDate) : new Date();
    when.setHours(when.getHours() + 1, 0, 0, 0);
    setScheduledAt(toDatetimeLocal(when.toISOString()));
    setApplicationId(NO_APPLICATION);
    setNotes("");
    setDialogOpen(true);
  }

  function openEdit(ev: CalendarEvent) {
    setEditing(ev);
    setTitle(ev.title);
    setEventType(ev.event_type);
    setScheduledAt(toDatetimeLocal(ev.scheduled_at));
    setApplicationId(ev.application_id ?? NO_APPLICATION);
    setNotes(ev.notes ?? "");
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!title.trim() || !scheduledAt) {
      toast.error("Title and date/time are required");
      return;
    }
    setSaving(true);
    try {
      const application_id = applicationId === NO_APPLICATION ? null : applicationId;
      if (editing) {
        const updated = await api.updateCalendarEvent(editing.id, {
          title: title.trim(),
          event_type: eventType,
          scheduled_at: fromDatetimeLocal(scheduledAt),
          application_id,
          notes: notes.trim() || null,
        });
        setEvents((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
        toast.success("Event updated");
      } else {
        const created = await api.createCalendarEvent({
          title: title.trim(),
          event_type: eventType,
          scheduled_at: fromDatetimeLocal(scheduledAt),
          application_id,
          notes: notes.trim() || null,
        });
        setEvents((prev) => [...prev, created]);
        toast.success("Event added");
      }
      setDialogOpen(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editing) return;
    if (!window.confirm(`Delete "${editing.title}"?`)) return;
    setSaving(true);
    try {
      await api.deleteCalendarEvent(editing.id);
      setEvents((prev) => prev.filter((e) => e.id !== editing.id));
      toast.success("Event deleted");
      setDialogOpen(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDrop(day: Date, eventId: string) {
    const ev = events.find((e) => e.id === eventId);
    if (!ev) return;
    const original = new Date(ev.scheduled_at);
    const moved = new Date(day);
    moved.setHours(original.getHours(), original.getMinutes(), 0, 0);
    if (moved.getTime() === original.getTime()) return;

    const movedIso = moved.toISOString();
    setEvents((prev) => prev.map((e) => (e.id === eventId ? { ...e, scheduled_at: movedIso } : e)));
    try {
      const updated = await api.updateCalendarEvent(eventId, { scheduled_at: movedIso });
      setEvents((prev) => prev.map((e) => (e.id === eventId ? updated : e)));
    } catch (e) {
      toast.error(String(e));
      setEvents((prev) => prev.map((e) => (e.id === eventId ? ev : e)));
    }
  }

  const today = new Date();

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Calendar</span>
        <div className="flex items-center gap-1 ml-2">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <span className="text-xs font-mono w-32 text-center">
            {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
          >
            <ChevronRight className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}
          >
            Today
          </Button>
        </div>
        <div className="ml-auto">
          <Button size="sm" onClick={() => openCreate()}>
            Add event
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-5">
        {loading ? (
          <div className="text-sm text-muted-foreground font-mono">loading…</div>
        ) : (
          <div className="border border-border bg-card">
            <div className="grid grid-cols-7">
              {WEEKDAY_LABELS.map((label) => (
                <div
                  key={label}
                  className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground px-2 py-1.5 border-b border-r border-border last:border-r-0"
                >
                  {label}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {days.map((day, i) => {
                const key = dateKey(day);
                const dayEvents = eventsByDay.get(key) ?? [];
                const inMonth = day.getMonth() === month.getMonth();
                const isToday = sameDay(day, today);
                return (
                  <div
                    key={key}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverKey(key);
                    }}
                    onDragLeave={() => setDragOverKey((k) => (k === key ? null : k))}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverKey(null);
                      const eventId = e.dataTransfer.getData("text/plain");
                      if (eventId) handleDrop(day, eventId);
                    }}
                    onClick={() => openCreate(day)}
                    className={cn(
                      "min-h-24 border-b border-r border-border p-1 flex flex-col gap-1 cursor-pointer",
                      i % 7 === 6 && "border-r-0",
                      !inMonth && "bg-muted/30",
                      dragOverKey === key && "bg-accent",
                    )}
                  >
                    <span
                      className={cn(
                        "text-[11px] font-mono self-start px-1",
                        !inMonth && "text-muted-foreground/50",
                        isToday && "bg-primary text-primary-foreground",
                      )}
                    >
                      {day.getDate()}
                    </span>
                    <div className="flex flex-col gap-0.5 max-h-28 overflow-y-auto">
                      {dayEvents.map((ev) => {
                        const autoDetected = ev.notes?.startsWith(AUTO_DETECTED_PREFIX);
                        return (
                          <button
                            key={ev.id}
                            type="button"
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData("text/plain", ev.id);
                              e.dataTransfer.effectAllowed = "move";
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              openEdit(ev);
                            }}
                            title={`${ev.title}${ev.job_title ? ` — ${ev.job_title} at ${ev.company_name}` : ""}`}
                            className={cn(
                              "text-left text-[10px] leading-tight px-1 py-0.5 border-l-2 truncate cursor-grab active:cursor-grabbing",
                              CHIP_CLASS[ev.event_type],
                            )}
                          >
                            {autoDetected && <Mail className="inline size-2.5 mr-0.5 align-[-1px]" strokeWidth={2} />}
                            {new Date(ev.scheduled_at).toLocaleTimeString(undefined, {
                              hour: "numeric",
                              minute: "2-digit",
                            })}{" "}
                            {ev.title}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit event" : "Add event"}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="event-title">Title</Label>
              <Input
                id="event-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Onsite interview — Acme Corp"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Type</Label>
              <Select value={eventType} onValueChange={(v) => setEventType(v as CalendarEventType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CALENDAR_EVENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {CALENDAR_EVENT_TYPE_LABEL[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="event-when">Date &amp; time</Label>
              <Input
                id="event-when"
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Related job</Label>
              <Select value={applicationId} onValueChange={setApplicationId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_APPLICATION}>None</SelectItem>
                  {applications.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.job_title || "Untitled"} — {a.company_name || "—"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="event-notes">Notes</Label>
              <Textarea
                id="event-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional — meeting link, interviewer names, anything worth remembering"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter className="sm:justify-between">
            {editing && (
              <Button variant="destructive" onClick={handleDelete} disabled={saving}>
                <Trash2 className="size-3.5" />
                Delete
              </Button>
            )}
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
