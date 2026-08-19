"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  api,
  CATEGORY_COLOR_CLASS,
  EVIDENCE_CATEGORIES,
  type EvidenceCategory,
  type EvidenceItem,
  type Profile,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const CATEGORY_LABEL: Record<EvidenceCategory, string> = {
  experience: "Experience",
  education: "Education",
  certification: "Certifications",
  project: "Projects",
  achievement: "Achievements",
  skill: "Skills",
  other: "Other",
};

const UNGROUPED = "__ungrouped__"; // sentinel — never a real employer string

type EvidenceDraft = {
  category: EvidenceCategory;
  text: string;
  skills: string;
  metrics: string;
  employer: string;
  date_start: string;
  date_end: string;
};

function draftFromItem(item: EvidenceItem): EvidenceDraft {
  return {
    category: item.category,
    text: item.text,
    skills: item.skills.join(", "),
    metrics: JSON.stringify(item.metrics, null, 2),
    employer: item.employer ?? "",
    date_start: item.date_start ?? "",
    date_end: item.date_end ?? "",
  };
}

function hasParsedProfile(profile: Profile): boolean {
  return Object.values(profile.parsed_profile ?? {}).some((value) =>
    Array.isArray(value) ? value.length > 0 : Boolean(value),
  );
}

function formatDateRange(item: EvidenceItem): string | null {
  if (!item.date_start && !item.date_end) return null;
  return `${item.date_start ?? "?"} — ${item.date_end ?? "ongoing"}`;
}

/** Items under one employer/role rarely share identical dates once
 * you allow for minor drift, but usually agree closely enough to show
 * one range in the group header — use the widest span present. */
function groupDateRange(items: EvidenceItem[]): string | null {
  const starts = items.map((i) => i.date_start).filter((d): d is string => !!d);
  const ends = items.map((i) => i.date_end).filter((d): d is string => !!d);
  const hasOngoing = items.some((i) => i.date_start && !i.date_end);
  if (starts.length === 0) return null;
  const start = starts.sort()[0];
  const end = hasOngoing ? "ongoing" : ends.length ? ends.sort().at(-1) : "?";
  return `${start} — ${end}`;
}

export default function ProfileStudioPage() {
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [items, setItems] = React.useState<EvidenceItem[]>([]);
  const [tab, setTab] = React.useState<"all" | EvidenceCategory>("all");
  const [loading, setLoading] = React.useState(true);
  const [parsing, setParsing] = React.useState(false);
  const [editing, setEditing] = React.useState<EvidenceItem | null>(null);
  const [draft, setDraft] = React.useState<EvidenceDraft | null>(null);
  const [savingEdit, setSavingEdit] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const loadAll = React.useCallback(async () => {
    const profiles = await api.listProfiles();
    const p = profiles[0] ?? null;
    setProfile(p);
    if (p) {
      const evidence = await api.listEvidence(p.id);
      setItems(evidence);
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadAll();
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAll]);

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !profile) return;

    setParsing(true);
    try {
      const result = await api.parseCV(profile.id, file);
      setItems(result.evidence_items);
      setProfile(result.profile);
      toast.success(
        `Extracted ${result.evidence_items.length} evidence items — cost $${result.cost_usd.toFixed(6)}`,
      );
      setTab("all");
    } catch (err) {
      toast.error(String(err));
    } finally {
      setParsing(false);
    }
  }

  function openEdit(item: EvidenceItem) {
    setEditing(item);
    setDraft(draftFromItem(item));
  }

  async function handleSaveEdit() {
    if (!profile || !editing || !draft) return;
    if (!draft.text.trim()) {
      toast.error("Evidence text cannot be empty");
      return;
    }

    let metrics: Record<string, string>;
    try {
      const parsed = JSON.parse(draft.metrics || "{}");
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("metrics must be a JSON object");
      }
      metrics = parsed as Record<string, string>;
    } catch (e) {
      toast.error(`Metrics JSON is invalid: ${String(e)}`);
      return;
    }

    setSavingEdit(true);
    try {
      const updated = await api.updateEvidence(profile.id, editing.id, {
        category: draft.category,
        text: draft.text.trim(),
        skills: draft.skills
          .split(",")
          .map((skill) => skill.trim())
          .filter(Boolean),
        metrics,
        employer: draft.employer.trim() || null,
        date_start: draft.date_start || null,
        date_end: draft.date_end || null,
      });
      setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setEditing(null);
      setDraft(null);
      const profiles = await api.listProfiles();
      setProfile(profiles[0] ?? null);
      toast.success("Evidence updated and re-embedded");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDelete(id: string) {
    if (!profile) return;
    try {
      await api.deleteEvidence(profile.id, id);
      setItems((prev) => prev.filter((it) => it.id !== id));
      const profiles = await api.listProfiles();
      setProfile(profiles[0] ?? null);
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function handleConfirm() {
    if (!profile) return;
    if (!profile.confirmed && (!items.length || items.some((item) => !item.embedded))) {
      toast.error("Parse the CV and make sure every evidence item is embedded first");
      return;
    }
    try {
      const updated = await api.updateProfile(profile.id, { confirmed: !profile.confirmed });
      setProfile(updated);
      setItems((prev) => prev.map((item) => ({ ...item, verified: updated.confirmed })));
      toast.success(updated.confirmed ? "Profile confirmed" : "Profile unconfirmed");
    } catch (e) {
      toast.error(String(e));
    }
  }

  const counts = React.useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    for (const cat of EVIDENCE_CATEGORIES) c[cat] = 0;
    for (const item of items) c[item.category] = (c[item.category] ?? 0) + 1;
    return c;
  }, [items]);

  const visible = tab === "all" ? items : items.filter((it) => it.category === tab);

  // Each atomic accomplishment stays its own separately-selectable
  // evidence row underneath (the tailoring agent will need to pick
  // individual ones later, not whole employers) — grouping here is
  // display only, so it reads like a CV instead of a flat item dump.
  const groups = React.useMemo(() => {
    const map = new Map<string, EvidenceItem[]>();
    for (const item of visible) {
      const key = item.employer ?? UNGROUPED;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return Array.from(map.entries());
  }, [visible]);

  const embeddedCount = items.filter((item) => item.embedded).length;

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Profile Studio</span>
        {profile && (
          <span
            className={cn(
              "font-mono text-[10px] uppercase px-2 py-0.5",
              profile.confirmed ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn",
            )}
          >
            {profile.confirmed ? "confirmed" : "unconfirmed"}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx"
            className="hidden"
            onChange={handleFileSelected}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!profile || parsing}
            onClick={() => fileInputRef.current?.click()}
          >
            {parsing ? "Parsing…" : "Upload CV"}
          </Button>
          <Button
            size="sm"
            disabled={
              !profile ||
              parsing ||
              (!profile.confirmed && (!items.length || embeddedCount !== items.length))
            }
            onClick={handleConfirm}
          >
            {profile?.confirmed ? "Unconfirm" : "Confirm profile"}
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-5 flex flex-col gap-4">
        {loading ? (
          <div className="text-sm text-muted-foreground font-mono">loading…</div>
        ) : !profile ? (
          <div className="text-sm text-muted-foreground border border-dashed border-input p-6 text-center">
            No profile shell exists yet. Run the API seed command first.
          </div>
        ) : (
          <>
            <section className="border border-border bg-card p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                    Structured profile
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Parsed fields are kept with revision {profile.revision} and stay behind the confirmation gate.
                  </span>
                </div>
                {profile.parsed_at && (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    parsed {new Date(profile.parsed_at).toLocaleDateString()}
                  </span>
                )}
              </div>
              {!hasParsedProfile(profile) ? (
                <p className="text-sm text-muted-foreground">
                  Upload a CV to populate the structured profile. Configure and verify the deep and embedding tiers in Models &amp; Providers first.
                </p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {[
                    ["Name", profile.parsed_profile.full_name],
                    ["Headline", profile.parsed_profile.headline],
                    ["Email", profile.parsed_profile.email],
                    ["Phone", profile.parsed_profile.phone],
                    ["Location", profile.parsed_profile.location],
                  ].map(([label, value]) =>
                    value ? (
                      <div key={label} className="flex flex-col gap-1">
                        <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                          {label}
                        </span>
                        <span className="text-sm">{value}</span>
                      </div>
                    ) : null,
                  )}
                  {profile.parsed_profile.summary && (
                    <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-3">
                      <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                        Summary
                      </span>
                      <span className="text-sm leading-relaxed">{profile.parsed_profile.summary}</span>
                    </div>
                  )}
                  {!!profile.parsed_profile.skills?.length && (
                    <div className="flex flex-col gap-1 lg:col-span-4">
                      <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                        Skills
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {profile.parsed_profile.skills.map((skill) => (
                          <Badge key={skill} variant="secondary" className="text-[9px] font-mono">
                            {skill}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="border border-border bg-card px-3 py-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                <span className="font-mono text-[10px] tracking-wider uppercase">Evidence bank</span>
                <span>·</span>
                <span>{items.length} atomic records</span>
                <span>·</span>
                <span className={embeddedCount === items.length ? "text-ok" : "text-warn"}>
                  {embeddedCount}/{items.length} embedded
                </span>
              </div>
              <span className="font-mono text-[10px] text-muted-foreground">
                {profile.confirmed ? "verified for downstream use" : "review before confirming"}
              </span>
            </section>

            {items.length === 0 ? (
              <div className="text-sm text-muted-foreground border border-dashed border-input p-6 text-center">
                No evidence yet. Upload a CV (.pdf or .docx) — it&apos;s parsed into atomic,
                individually-citable accomplishment records, each one a future CV bullet
                has to trace back to.
              </div>
            ) : (
              <>
                <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
                  <TabsList>
                    <TabsTrigger value="all">All ({counts.all})</TabsTrigger>
                    {EVIDENCE_CATEGORIES.filter((cat) => counts[cat] > 0).map((cat) => (
                      <TabsTrigger key={cat} value={cat}>
                        {CATEGORY_LABEL[cat]} ({counts[cat]})
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>

                <div className="flex flex-col gap-4">
                  {groups.map(([employer, groupItems]) => {
                    const range = groupDateRange(groupItems);
                    return (
                      <div key={employer} className="border border-border bg-card">
                        {employer !== UNGROUPED && (
                          <div className="h-9 border-b border-border bg-secondary flex items-center gap-2 px-3">
                            <span className="text-sm font-medium">{employer}</span>
                            {range && (
                              <span className="font-mono text-[11px] text-muted-foreground tabular">
                                {range}
                              </span>
                            )}
                            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                              {groupItems.length} item{groupItems.length === 1 ? "" : "s"}
                            </span>
                          </div>
                        )}
                        <div className="flex flex-col">
                          {groupItems.map((item) => {
                            const itemRange = formatDateRange(item);
                            return (
                              <div
                                key={item.id}
                                className="flex items-start gap-3 px-3 py-2.5 border-b border-border last:border-b-0"
                              >
                                <span className="text-muted-foreground text-sm leading-6">–</span>
                                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <Badge
                                      variant="secondary"
                                      className={cn("text-[9px] font-mono", CATEGORY_COLOR_CLASS[item.category])}
                                    >
                                      {item.category}
                                    </Badge>
                                    <Badge
                                      variant="secondary"
                                      className={cn(
                                        "text-[9px] font-mono",
                                        item.embedded ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn",
                                      )}
                                    >
                                      {item.embedded ? "embedded" : "needs embedding"}
                                    </Badge>
                                    {employer === UNGROUPED && itemRange && (
                                      <span className="font-mono text-[10px] text-muted-foreground tabular">
                                        {itemRange}
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-sm leading-relaxed">{item.text}</p>
                                  {item.skills.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                      {item.skills.map((s) => (
                                        <Badge
                                          key={s}
                                          variant="secondary"
                                          className="text-[9px] font-mono"
                                        >
                                          {s}
                                        </Badge>
                                      ))}
                                    </div>
                                  )}
                                </div>
                                <div className="flex gap-2 shrink-0">
                                  <Button size="sm" variant="outline" onClick={() => openEdit(item)}>
                                    Edit
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleDelete(item.id)}
                                  >
                                    Delete
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}
      </div>

      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setDraft(null);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit evidence</DialogTitle>
            <DialogDescription>
              Text and skills changes are re-embedded before saving and require confirmation again.
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="grid gap-4 py-2">
              <div className="grid gap-1.5">
                <Label htmlFor="evidence-category">Category</Label>
                <Select
                  value={draft.category}
                  onValueChange={(value) =>
                    setDraft((current) =>
                      current ? { ...current, category: value as EvidenceCategory } : current,
                    )
                  }
                >
                  <SelectTrigger id="evidence-category" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EVIDENCE_CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category}>
                        {CATEGORY_LABEL[category]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="evidence-text">Evidence text</Label>
                <textarea
                  id="evidence-text"
                  value={draft.text}
                  onChange={(event) =>
                    setDraft((current) => (current ? { ...current, text: event.target.value } : current))
                  }
                  className="min-h-24 w-full border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="evidence-skills">Skills (comma separated)</Label>
                <Input
                  id="evidence-skills"
                  value={draft.skills}
                  onChange={(event) =>
                    setDraft((current) => (current ? { ...current, skills: event.target.value } : current))
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="evidence-employer">Employer / project</Label>
                <Input
                  id="evidence-employer"
                  value={draft.employer}
                  onChange={(event) =>
                    setDraft((current) => (current ? { ...current, employer: event.target.value } : current))
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="evidence-start">Start date</Label>
                  <Input
                    id="evidence-start"
                    type="date"
                    value={draft.date_start}
                    onChange={(event) =>
                      setDraft((current) => (current ? { ...current, date_start: event.target.value } : current))
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="evidence-end">End date</Label>
                  <Input
                    id="evidence-end"
                    type="date"
                    value={draft.date_end}
                    onChange={(event) =>
                      setDraft((current) => (current ? { ...current, date_end: event.target.value } : current))
                    }
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="evidence-metrics">Metrics (JSON object)</Label>
                <textarea
                  id="evidence-metrics"
                  value={draft.metrics}
                  onChange={(event) =>
                    setDraft((current) => (current ? { ...current, metrics: event.target.value } : current))
                  }
                  className="min-h-20 w-full border border-input bg-transparent px-2.5 py-2 font-mono text-xs outline-none focus-visible:border-ring"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={savingEdit}>
              {savingEdit ? "Saving…" : "Save evidence"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
