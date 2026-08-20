"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  api,
  CATEGORY_COLOR_CLASS,
  CV_PARSE_STAGES,
  EVIDENCE_CATEGORIES,
  type CVParseStage,
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
import { Check, Circle, FileText, Loader2, UploadCloud } from "lucide-react";

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

const STAGE_LABEL: Record<CVParseStage, string> = {
  extracting: "Extracting text",
  resolving_models: "Resolving models",
  parsing: "Parsing with AI",
  saving: "Saving evidence",
  embedding: "Embedding evidence",
};

type ProfileDraft = {
  full_name: string;
  headline: string;
  email: string;
  phone: string;
  location: string;
  links: string;
  summary: string;
  skills: string;
};

function profileDraftFromProfile(profile: Profile): ProfileDraft {
  const p = profile.parsed_profile ?? {};
  return {
    full_name: p.full_name ?? "",
    headline: p.headline ?? "",
    email: p.email ?? "",
    phone: p.phone ?? "",
    location: p.location ?? "",
    links: (p.links ?? []).join(", "),
    summary: p.summary ?? "",
    skills: (p.skills ?? []).join(", "),
  };
}

type EvidenceDraft = {
  category: EvidenceCategory;
  title: string;
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
    title: item.title ?? "",
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
  // `parsing` stays the single source of truth for "a parse is in
  // flight" — it gates the header button/confirm control regardless of
  // whether the modal is open, since closing the modal must not stop
  // the actual request (it's driven by this component's own async
  // generator consumption below, not by anything the modal renders).
  const [parsing, setParsing] = React.useState(false);
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [pendingFile, setPendingFile] = React.useState<File | null>(null);
  const [activeStage, setActiveStage] = React.useState<CVParseStage | null>(null);
  const [completedStages, setCompletedStages] = React.useState<Set<CVParseStage>>(new Set());
  const [parseError, setParseError] = React.useState<string | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [editing, setEditing] = React.useState<EvidenceItem | null>(null);
  const [draft, setDraft] = React.useState<EvidenceDraft | null>(null);
  const [savingEdit, setSavingEdit] = React.useState(false);
  const [editingProfile, setEditingProfile] = React.useState(false);
  const [profileDraft, setProfileDraft] = React.useState<ProfileDraft | null>(null);
  const [savingProfile, setSavingProfile] = React.useState(false);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [resetConfirmText, setResetConfirmText] = React.useState("");
  const [resetting, setResetting] = React.useState(false);
  const modalFileInputRef = React.useRef<HTMLInputElement>(null);

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

  function openUploadModal() {
    // Reopening while a parse is already running just brings the
    // progress screen back — it does not start a second upload. The
    // in-flight request lives in `runParse` below, entirely independent
    // of whether this modal is mounted/open, so closing and reopening
    // never affects it.
    if (!parsing) {
      setPendingFile(null);
      setActiveStage(null);
      setCompletedStages(new Set());
      setParseError(null);
    }
    setUploadOpen(true);
  }

  function selectFile(file: File) {
    setPendingFile(file);
    setParseError(null);
  }

  async function runParse() {
    if (!profile || !pendingFile) return;

    setParsing(true);
    setParseError(null);
    setActiveStage(null);
    setCompletedStages(new Set());

    try {
      for await (const event of api.streamParseCV(profile.id, pendingFile)) {
        if (event.type === "stage") {
          if (event.status === "started") {
            setActiveStage(event.stage);
          } else {
            setCompletedStages((prev) => new Set(prev).add(event.stage));
          }
        } else if (event.type === "done") {
          setItems(event.result.evidence_items);
          setProfile(event.result.profile);
          toast.success(
            `Extracted ${event.result.evidence_items.length} evidence items — cost $${event.result.cost_usd.toFixed(6)}`,
          );
          setTab("all");
          setUploadOpen(false);
          setPendingFile(null);
        } else if (event.type === "error") {
          setParseError(event.message);
          toast.error(event.message);
        }
      }
    } catch (err) {
      setParseError(String(err));
      toast.error(String(err));
    } finally {
      setParsing(false);
    }
  }

  function handleModalFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) selectFile(file);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) selectFile(file);
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
        title: draft.title.trim() || null,
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

  function openProfileEdit() {
    if (!profile) return;
    setProfileDraft(profileDraftFromProfile(profile));
    setEditingProfile(true);
  }

  async function handleSaveProfile() {
    if (!profile || !profileDraft) return;
    setSavingProfile(true);
    try {
      const updated = await api.updateProfile(profile.id, {
        parsed_profile: {
          full_name: profileDraft.full_name.trim() || null,
          headline: profileDraft.headline.trim() || null,
          email: profileDraft.email.trim() || null,
          phone: profileDraft.phone.trim() || null,
          location: profileDraft.location.trim() || null,
          links: profileDraft.links
            .split(",")
            .map((l) => l.trim())
            .filter(Boolean),
          summary: profileDraft.summary.trim() || null,
          skills: profileDraft.skills
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      setProfile(updated);
      setItems((prev) => prev.map((item) => ({ ...item, verified: updated.confirmed })));
      setEditingProfile(false);
      setProfileDraft(null);
      toast.success("Profile updated — confirmation reset, review before re-confirming");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleReset() {
    if (!profile) return;
    setResetting(true);
    try {
      const fresh = await api.resetProfile(profile.id);
      setProfile(fresh);
      setItems([]);
      setTab("all");
      setResetOpen(false);
      setResetConfirmText("");
      toast.success("Profile reset — all evidence and downstream data deleted");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setResetting(false);
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
  // Sub-grouped by title within each employer, not just by employer:
  // a promotion (two roles, one company) reads as two labeled blocks
  // instead of one undifferentiated list — this is exactly what was
  // missing before `title` existed as a field at all.
  const groups = React.useMemo(() => {
    const map = new Map<string, EvidenceItem[]>();
    for (const item of visible) {
      const key = item.employer ?? UNGROUPED;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return Array.from(map.entries()).map(([employer, employerItems]) => {
      const titleMap = new Map<string, EvidenceItem[]>();
      for (const item of employerItems) {
        const key = item.title ?? "";
        if (!titleMap.has(key)) titleMap.set(key, []);
        titleMap.get(key)!.push(item);
      }
      return [employer, Array.from(titleMap.entries())] as const;
    });
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
          <Button
            size="sm"
            variant="outline"
            disabled={!profile}
            onClick={openUploadModal}
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
          <Button
            size="sm"
            variant="destructive"
            disabled={!profile}
            onClick={() => setResetOpen(true)}
          >
            Reset profile
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
                <div className="flex items-center gap-2 shrink-0">
                  {profile.parsed_at && (
                    <span className="font-mono text-[10px] text-muted-foreground">
                      parsed {new Date(profile.parsed_at).toLocaleDateString()}
                    </span>
                  )}
                  <Button size="sm" variant="outline" onClick={openProfileEdit}>
                    Edit
                  </Button>
                </div>
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
                  {groups.map(([employer, titleGroups]) => {
                    const allItems = titleGroups.flatMap(([, groupItems]) => groupItems);
                    const range = groupDateRange(allItems);
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
                              {allItems.length} item{allItems.length === 1 ? "" : "s"}
                            </span>
                          </div>
                        )}
                        {titleGroups.map(([title, groupItems]) => (
                          <div key={title || "__no_title__"}>
                            {title && (
                              <div className="h-7 flex items-center px-3 border-b border-border bg-muted/40">
                                <span className="text-xs font-medium text-muted-foreground">{title}</span>
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
                                        {/* title already shown as a subheader when grouped by employer,
                                            but the ungrouped ("other"/no-employer) case has none — show it
                                            inline there so a title never silently disappears. */}
                                        {employer === UNGROUPED && item.title && (
                                          <span className="text-xs font-medium">{item.title}</span>
                                        )}
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
                        ))}
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
              Title, text and skills changes are re-embedded before saving and require confirmation again.
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
                <Label htmlFor="evidence-title">Title (role / degree / certificate)</Label>
                <Input
                  id="evidence-title"
                  placeholder="e.g. Machine Learning Engineer Intern"
                  value={draft.title}
                  onChange={(event) =>
                    setDraft((current) => (current ? { ...current, title: event.target.value } : current))
                  }
                />
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

      <Dialog
        open={editingProfile}
        onOpenChange={(open) => {
          if (!open) {
            setEditingProfile(false);
            setProfileDraft(null);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit profile</DialogTitle>
            <DialogDescription>
              Changes reset confirmation — review evidence again before re-confirming.
            </DialogDescription>
          </DialogHeader>
          {profileDraft && (
            <div className="grid gap-4 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="profile-name">Full name</Label>
                  <Input
                    id="profile-name"
                    value={profileDraft.full_name}
                    onChange={(e) =>
                      setProfileDraft((d) => (d ? { ...d, full_name: e.target.value } : d))
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="profile-headline">Headline</Label>
                  <Input
                    id="profile-headline"
                    value={profileDraft.headline}
                    onChange={(e) =>
                      setProfileDraft((d) => (d ? { ...d, headline: e.target.value } : d))
                    }
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="profile-email">Email</Label>
                  <Input
                    id="profile-email"
                    type="email"
                    value={profileDraft.email}
                    onChange={(e) => setProfileDraft((d) => (d ? { ...d, email: e.target.value } : d))}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="profile-phone">Phone</Label>
                  <Input
                    id="profile-phone"
                    value={profileDraft.phone}
                    onChange={(e) => setProfileDraft((d) => (d ? { ...d, phone: e.target.value } : d))}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="profile-location">Location</Label>
                <Input
                  id="profile-location"
                  value={profileDraft.location}
                  onChange={(e) => setProfileDraft((d) => (d ? { ...d, location: e.target.value } : d))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="profile-links">Links (comma separated)</Label>
                <Input
                  id="profile-links"
                  value={profileDraft.links}
                  onChange={(e) => setProfileDraft((d) => (d ? { ...d, links: e.target.value } : d))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="profile-summary">Summary</Label>
                <textarea
                  id="profile-summary"
                  value={profileDraft.summary}
                  onChange={(e) => setProfileDraft((d) => (d ? { ...d, summary: e.target.value } : d))}
                  className="min-h-24 w-full border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="profile-skills">Skills (comma separated)</Label>
                <Input
                  id="profile-skills"
                  value={profileDraft.skills}
                  onChange={(e) => setProfileDraft((d) => (d ? { ...d, skills: e.target.value } : d))}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingProfile(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveProfile} disabled={savingProfile}>
              {savingProfile ? "Saving…" : "Save profile"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={resetOpen}
        onOpenChange={(open) => {
          setResetOpen(open);
          if (!open) setResetConfirmText("");
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reset profile</DialogTitle>
            <DialogDescription>
              Permanently deletes every evidence item, persona, document, and downstream
              score or application tied to this profile, then replaces it with a blank
              shell. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5 py-2">
            <Label htmlFor="reset-confirm">
              Type <span className="font-mono">RESET</span> to confirm
            </Label>
            <Input
              id="reset-confirm"
              value={resetConfirmText}
              onChange={(e) => setResetConfirmText(e.target.value)}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={resetConfirmText !== "RESET" || resetting}
              onClick={handleReset}
            >
              {resetting ? "Resetting…" : "Delete everything"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Upload CV</DialogTitle>
            <DialogDescription>
              {parsing
                ? "Runs in the background — closing this is fine, it keeps going."
                : "PDF or DOCX. Parsed into atomic, individually-citable evidence."}
            </DialogDescription>
          </DialogHeader>

          {parsing ? (
            <div className="flex flex-col gap-3 py-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <FileText className="size-3.5" />
                <span className="truncate">{pendingFile?.name}</span>
              </div>
              <div className="flex flex-col gap-0.5 border border-border">
                {CV_PARSE_STAGES.map((stage, i) => {
                  const isDone = completedStages.has(stage);
                  const isActive = activeStage === stage && !isDone;
                  return (
                    <div
                      key={stage}
                      className={cn(
                        "flex items-center gap-2.5 px-3 py-2",
                        i < CV_PARSE_STAGES.length - 1 && "border-b border-border",
                        isActive && "bg-accent",
                      )}
                    >
                      {isDone ? (
                        <Check className="size-3.5 text-ok shrink-0" />
                      ) : isActive ? (
                        <Loader2 className="size-3.5 animate-spin text-primary shrink-0" />
                      ) : (
                        <Circle className="size-3.5 text-muted-foreground shrink-0" />
                      )}
                      <span
                        className={cn(
                          "text-sm",
                          isDone ? "text-muted-foreground" : isActive ? "font-medium" : "text-muted-foreground",
                        )}
                      >
                        {STAGE_LABEL[stage]}
                      </span>
                      {isActive && (
                        <span className="ml-auto font-mono text-[10px] text-muted-foreground">running…</span>
                      )}
                    </div>
                  );
                })}
              </div>
              {activeStage === "parsing" && (
                <p className="text-xs text-muted-foreground">
                  This step calls the AI model and is the slow one — usually the longest wait in the whole flow.
                </p>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setUploadOpen(false)}>
                  Close — keep running in background
                </Button>
              </DialogFooter>
            </div>
          ) : pendingFile ? (
            <div className="flex flex-col gap-3 py-2">
              <div className="flex items-center gap-2 border border-border px-3 py-2.5">
                <FileText className="size-4 text-muted-foreground shrink-0" />
                <span className="text-sm truncate">{pendingFile.name}</span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {(pendingFile.size / 1024).toFixed(0)} KB
                </span>
              </div>
              {parseError && (
                <div className="border border-crit bg-crit-bg px-3 py-2 text-xs text-crit">{parseError}</div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setPendingFile(null)}>
                  Choose different file
                </Button>
                <Button onClick={runParse}>{parseError ? "Try again" : "Parse CV"}</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="flex flex-col gap-3 py-2">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => modalFileInputRef.current?.click()}
                className={cn(
                  "flex flex-col items-center gap-2 border border-dashed px-6 py-10 text-center cursor-pointer transition-colors",
                  dragOver ? "border-primary bg-accent" : "border-input hover:bg-secondary",
                )}
              >
                <UploadCloud className="size-6 text-muted-foreground" />
                <span className="text-sm">Drop a file here, or click to browse</span>
                <span className="text-xs text-muted-foreground">.pdf or .docx</span>
              </div>
              <input
                ref={modalFileInputRef}
                type="file"
                accept=".pdf,.docx"
                className="hidden"
                onChange={handleModalFileInput}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
