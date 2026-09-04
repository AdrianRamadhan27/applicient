"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  api,
  type AnswerPackDelta,
  type Application,
  type ClaimVerdict,
  type ClaimVerification,
  type CoverLetterDelta,
  type CoverLetterLength,
  type CoverLetterTone,
  type CvScore,
  type CvTemplate,
  type EvidenceItem,
  type InboxJob,
  type JobGroup,
  type Profile,
  type SkillGapItem,
  type TailorProgressEvent,
  type TailoredDocument,
  type TailoringDelta,
} from "@/lib/api";
import { DeltaDiffView } from "@/components/delta-diff-view";
import { CreditCostBadge } from "@/components/credit-cost-badge";
import { usePersona } from "@/components/persona-provider";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  Plus,
  Trash2,
  Download,
  Sparkles,
  Check,
  ArrowRight,
  Loader2,
  Pencil,
  RotateCcw,
  X,
  Copy,
  Send,
  GraduationCap,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
} from "lucide-react";

const VERDICT_VARIANT: Record<ClaimVerdict, "default" | "secondary" | "destructive"> = {
  supported: "default",
  reframed_ok: "secondary",
  unsupported: "destructive",
  inflated: "destructive",
};

function VerdictBadge({ verdict }: { verdict: ClaimVerdict }) {
  return <Badge variant={VERDICT_VARIANT[verdict]}>{verdict.replace("_", " ")}</Badge>;
}

// --- Step progression ---
// Generation is genuinely 2-4 sequential deep-tier LLM calls, not one:
// tailor, verify — and, only if the verifier flags something, one
// regeneration + a second verify (F5.5's hard cap). Each call is a
// real 1-3+ minute request in this environment, not a fast API call,
// so a real stepper (not a single overwritten status line) is what
// actually explains where the time is going.
type StepStatus = "pending" | "active" | "done";
type Step = { key: string; label: string; status: StepStatus; ok?: boolean };

function initialSteps(): Step[] {
  return [
    { key: "tailoring", label: "Generate tailored draft", status: "pending" },
    { key: "verifying-1", label: "Verify claims", status: "pending" },
  ];
}

function applyStageEvent(steps: Step[], event: Extract<TailorProgressEvent, { type: "stage" }>): Step[] {
  const key = event.stage === "verifying" ? `verifying-${event.attempt ?? 1}` : event.stage;
  const idx = steps.findIndex((s) => s.key === key);
  const label =
    event.stage === "regenerating"
      ? "Fix flagged claims"
      : event.attempt === 2
        ? "Re-verify claims"
        : "Verify claims";
  const updated: Step = {
    key,
    label,
    status: event.status === "started" ? "active" : "done",
    ok: event.status === "done" ? event.clean : undefined,
  };
  if (idx === -1) return [...steps, updated];
  const next = [...steps];
  next[idx] = updated;
  return next;
}

function Stepper({ steps }: { steps: Step[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {steps.map((s) => (
        <div key={s.key} className="flex items-center gap-2 text-xs">
          {s.status === "done" ? (
            s.ok === false ? (
              <span className="size-4 rounded-full bg-destructive/20 text-destructive flex items-center justify-center shrink-0">!</span>
            ) : (
              <Check className="size-4 text-primary shrink-0" />
            )
          ) : s.status === "active" ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground shrink-0" />
          ) : (
            <span className="size-4 rounded-full border border-border shrink-0" />
          )}
          <span className={s.status === "pending" ? "text-muted-foreground" : ""}>{s.label}</span>
        </div>
      ))}
    </div>
  );
}

// --- Diff view: each evidence item vs. what the tailored delta did with it ---

// --- Structured, per-section "card" editor (raised by Adrian:
// separate from raw LaTeX editing — add/remove a whole experience
// entry, add/remove/reword a bullet, without touching source). Each
// section is one evidence item's card; title/employer/dates are read
// straight from the evidence bank and never editable here (F5.9 —
// only bullet wording changes, never facts like employer/title/dates).

function evidenceLabel(item: EvidenceItem | undefined, fallbackId: string): string {
  if (!item) return fallbackId;
  return [item.title, item.employer].filter(Boolean).join(" — ") || item.category;
}

function SectionCardEditor({
  delta,
  evidenceBank,
  onChange,
}: {
  delta: TailoringDelta;
  evidenceBank: EvidenceItem[];
  onChange: (next: TailoringDelta) => void;
}) {
  const evidenceById = React.useMemo(() => new Map(evidenceBank.map((e) => [e.id, e])), [evidenceBank]);
  const includedIds = new Set(delta.sections.map((s) => s.evidence_id));
  const omitted = evidenceBank.filter((e) => !includedIds.has(e.id));

  function updateSection(index: number, section: TailoringDelta["sections"][number]) {
    const sections = [...delta.sections];
    sections[index] = section;
    onChange({ ...delta, sections });
  }

  function removeSection(index: number) {
    onChange({ ...delta, sections: delta.sections.filter((_, i) => i !== index) });
  }

  function addSection(evidenceId: string) {
    const item = evidenceById.get(evidenceId);
    if (!item) return;
    onChange({
      ...delta,
      sections: [...delta.sections, { evidence_id: evidenceId, bullets: [{ evidence_id: evidenceId, text: item.text }] }],
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-xs">Summary</Label>
        <textarea
          value={delta.summary}
          onChange={(e) => onChange({ ...delta, summary: e.target.value })}
          className="w-full text-sm border border-border rounded-md p-2 bg-background mt-1"
          style={{ height: 70 }}
        />
      </div>

      {delta.sections.map((section, i) => (
        <div key={i} className="border border-border rounded-md p-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {evidenceLabel(evidenceById.get(section.evidence_id), section.evidence_id)}
            </span>
            <button
              className="text-muted-foreground hover:text-destructive"
              title="Remove this section"
              onClick={() => removeSection(i)}
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
          <div className="space-y-1.5">
            {section.bullets.map((bullet, j) => (
              <div key={j} className="flex items-start gap-1.5">
                <textarea
                  value={bullet.text}
                  onChange={(e) => {
                    const bullets = [...section.bullets];
                    bullets[j] = { ...bullet, text: e.target.value };
                    updateSection(i, { ...section, bullets });
                  }}
                  className="flex-1 text-sm border border-border rounded-md p-1.5 bg-background"
                  style={{ height: 50 }}
                />
                <button
                  className="text-muted-foreground hover:text-destructive mt-1.5"
                  title="Remove this bullet"
                  onClick={() => updateSection(i, { ...section, bullets: section.bullets.filter((_, k) => k !== j) })}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
          <button
            className="text-xs text-muted-foreground hover:text-foreground mt-1.5"
            onClick={() =>
              updateSection(i, {
                ...section,
                bullets: [...section.bullets, { evidence_id: section.evidence_id, text: "" }],
              })
            }
          >
            + Add bullet
          </button>
        </div>
      ))}

      {omitted.length > 0 && (
        <Select onValueChange={addSection} value="">
          <SelectTrigger className="w-full h-8 text-xs">
            <SelectValue placeholder="+ Add a section from your evidence bank" />
          </SelectTrigger>
          <SelectContent>
            {omitted.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {evidenceLabel(item, item.id)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

// --- Cover letter (F5.7) — a per-application toggle, off by default:
// nothing here generates or even fetches anything until the user
// checks the box. Self-contained (its own docs/preview/verification
// state) so it doesn't interfere with the CV panel above it.

const COVER_LETTER_TONES: { value: CoverLetterTone; label: string }[] = [
  { value: "neutral", label: "Neutral" },
  { value: "formal", label: "Formal" },
  { value: "very_formal", label: "Very formal" },
  { value: "warm", label: "Warm / conversational" },
];
const COVER_LETTER_LENGTHS: { value: CoverLetterLength; label: string }[] = [
  { value: "short", label: "Short (~150 words)" },
  { value: "medium", label: "Medium (~250-300 words)" },
  { value: "long", label: "Long (~400-450 words)" },
];

/** Shown before any job group has been created/selected — an
 * untailored CV straight from the Dashboard's evidence bank, so
 * there's something real to look at/export immediately rather than
 * an empty "select a job group" screen (raised by Adrian). Fully
 * self-contained/stateless on the server side (api.renderBaseCv never
 * persists anything), so this component's own state is deliberately
 * separate from the rest of ComposerPage's tailored-per-group state
 * machine rather than woven into it. */
/** Overall/category scores come back on a 0-100 scale
 * (cv_score_engine.py) — color bands purely for the at-a-glance read,
 * same rough cutoffs the prompt itself was calibrated against. */
function scoreColorClass(score: number): string {
  if (score >= 70) return "text-ok";
  if (score >= 40) return "text-warn";
  return "text-crit";
}

function CvScorePanel({
  profileId,
  score,
  scoredAt,
  onScoreChanged,
}: {
  profileId: string;
  score: CvScore | null;
  scoredAt: string | null;
  onScoreChanged: (profile: Profile) => void;
}) {
  const [analyzing, setAnalyzing] = React.useState(false);
  const [fixing, setFixing] = React.useState(false);

  async function handleAnalyze() {
    setAnalyzing(true);
    try {
      const profile = await api.scoreCv(profileId);
      onScoreChanged(profile);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleFix() {
    setFixing(true);
    try {
      const result = await api.fixCv(profileId);
      toast.success(
        result.updated_count > 0
          ? `Reworded ${result.updated_count} evidence item${result.updated_count === 1 ? "" : "s"}`
          : "Your evidence bank already reads well — nothing needed changing",
      );
      // Free, and the whole point is to see the improved analysis —
      // re-score right away rather than leaving the pre-fix numbers
      // showing next to text that no longer matches them.
      const profile = await api.scoreCv(profileId);
      onScoreChanged(profile);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setFixing(false);
    }
  }

  return (
    <div className="border border-border bg-card p-4 space-y-3 h-full overflow-y-auto">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold">CV Analysis</h3>
          {scoredAt && (
            <span className="text-[11px] text-muted-foreground font-mono">
              last analyzed {new Date(scoredAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleAnalyze} disabled={analyzing || fixing}>
            {analyzing ? "Analyzing…" : score ? "Re-analyze" : "Analyze my CV"}
          </Button>
          <div className="relative">
            <Button size="sm" onClick={handleFix} disabled={fixing || analyzing || !score}>
              {fixing ? "Fixing…" : "Fix my CV"}
            </Button>
            <CreditCostBadge featureKey="cv-fix" />
          </div>
        </div>
      </div>

      {!score ? (
        <p className="text-xs text-muted-foreground">
          Get honest, specific feedback on your evidence bank — free — before deciding what to fix.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <div className={cn("text-3xl font-bold font-mono tabular", scoreColorClass(score.overall_score))}>
              {Math.round(score.overall_score)}
            </div>
            <p className="text-xs text-muted-foreground flex-1">{score.summary}</p>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {score.categories.map((c) => (
              <div key={c.category} className="border border-border p-2" title={c.feedback}>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono truncate">
                  {c.category}
                </div>
                <div className={cn("text-lg font-semibold font-mono", scoreColorClass(c.score))}>
                  {Math.round(c.score)}
                </div>
              </div>
            ))}
          </div>

          {score.strengths.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold text-ok uppercase tracking-wider mb-1">Strengths</div>
              <ul className="space-y-1">
                {score.strengths.map((s, i) => (
                  <li key={i} className="flex gap-1.5 text-xs">
                    <Check className="size-3.5 shrink-0 text-ok mt-0.5" />
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {score.improvements.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold text-warn uppercase tracking-wider mb-1">
                Suggested improvements
              </div>
              <ul className="space-y-1">
                {score.improvements.map((s, i) => (
                  <li key={i} className="flex gap-1.5 text-xs">
                    <ArrowRight className="size-3.5 shrink-0 text-warn mt-0.5" />
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Shown before any job group has been created/selected — an
 * untailored CV straight from the Dashboard's evidence bank, so
 * there's something real to look at/export immediately rather than
 * an empty "select a job group" screen (raised by Adrian). Fully
 * self-contained/stateless on the server side (api.renderBaseCv never
 * persists anything), so this component's own state is deliberately
 * separate from the rest of ComposerPage's tailored-per-group state
 * machine rather than woven into it.
 *
 * `profileId` is Phase 16 follow-up (Adrian, direct): general CV
 * scoring + a "fix my CV" action, both shown here — CvScorePanel above
 * owns that state, this component only owns the render/preview pane
 * and re-renders it once a fix actually changes the underlying
 * evidence bank. */
function BaseCvPanel({ personaId, profileId }: { personaId: string; profileId: string }) {
  const [templates, setTemplates] = React.useState<CvTemplate[]>([]);
  const [templateId, setTemplateId] = React.useState("");
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [previewBlob, setPreviewBlob] = React.useState<Blob | null>(null);
  const [rendering, setRendering] = React.useState(false);
  const [cvScore, setCvScore] = React.useState<CvScore | null>(null);
  const [cvScoredAt, setCvScoredAt] = React.useState<string | null>(null);

  const render = React.useCallback(
    async (tplId: string, opts?: { force?: boolean }) => {
      if (!tplId) return;
      setRendering(true);
      try {
        const blob = await api.renderBaseCv(personaId, tplId, opts);
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
        setPreviewBlob(blob);
      } catch (e) {
        toast.error(String(e));
      } finally {
        setRendering(false);
      }
    },
    [personaId],
  );

  React.useEffect(() => {
    let cancelled = false;
    (() =>
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      }))();
    (() => setPreviewBlob(null))();
    (async () => {
      try {
        const [tpls, profile] = await Promise.all([api.listTemplates(), api.getProfile(profileId)]);
        if (cancelled) return;
        setTemplates(tpls);
        setCvScore(profile.cv_score);
        setCvScoredAt(profile.cv_scored_at);
        const first = tpls[0]?.id ?? "";
        setTemplateId(first);
        if (first) await render(first);
      } catch (e) {
        toast.error(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaId, profileId]);

  function handleExport() {
    if (!previewBlob) return;
    const url = URL.createObjectURL(previewBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cv-base.pdf";
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleScoreChanged(profile: Profile) {
    setCvScore(profile.cv_score);
    setCvScoredAt(profile.cv_scored_at);
    // A "fix" changes the actual evidence text, not just the score —
    // the preview pane needs a fresh render or it'd keep showing the
    // pre-fix wording next to a post-fix analysis.
    void render(templateId);
  }

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Base CV</h2>
        <p className="text-xs text-muted-foreground mt-1 max-w-xl">
          An untailored CV straight from your Dashboard evidence bank — every entry, as recorded, nothing
          selected or reworded for a specific role yet. Create a job group above and generate a tailored CV once
          you have specific jobs to target.
        </p>
      </div>

      {/* Adrian, direct: "The cv and the score/analysis should be side
          by side" — a two-column layout on wide screens (stacks on
          narrow ones, same lg: breakpoint the rest of this app's own
          grids use), preview on the left since that's the thing being
          judged, analysis on the right. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Select
              value={templateId}
              onValueChange={(v) => {
                setTemplateId(v);
                void render(v);
              }}
            >
              <SelectTrigger className="w-56 h-8 text-xs">
                <SelectValue placeholder="Template" />
              </SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => render(templateId, { force: true })}
              disabled={rendering || !templateId}
            >
              {rendering ? "Rendering…" : "Refresh"}
            </Button>
            <Button size="sm" onClick={handleExport} disabled={!previewBlob}>
              <Download className="size-4" />
              Export
            </Button>
          </div>
          <div className="border border-border rounded-md overflow-hidden bg-muted/30" style={{ height: 700 }}>
            {previewUrl ? (
              <iframe src={previewUrl} className="w-full h-full" title="Base CV preview" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground font-mono">
                {rendering ? "Rendering…" : "No evidence yet — add some in the Dashboard"}
              </div>
            )}
          </div>
        </div>

        <CvScorePanel profileId={profileId} score={cvScore} scoredAt={cvScoredAt} onScoreChanged={handleScoreChanged} />
      </div>
    </div>
  );
}

function CoverLetterPanel({ groupId }: { groupId: string }) {
  const [docs, setDocs] = React.useState<TailoredDocument[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [verifications, setVerifications] = React.useState<ClaimVerification[]>([]);
  const [tone, setTone] = React.useState<CoverLetterTone>("neutral");
  const [length, setLength] = React.useState<CoverLetterLength>("medium");
  const [generating, setGenerating] = React.useState(false);
  const [steps, setSteps] = React.useState<Step[]>([]);
  const [templates, setTemplates] = React.useState<CvTemplate[]>([]);
  const [templateId, setTemplateId] = React.useState("");
  const [rendering, setRendering] = React.useState(false);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [previewBlob, setPreviewBlob] = React.useState<Blob | null>(null);
  const [editingTex, setEditingTex] = React.useState(false);
  const [texValue, setTexValue] = React.useState("");
  const [texIsEdited, setTexIsEdited] = React.useState(false);
  const [loadingTex, setLoadingTex] = React.useState(false);
  const [savingTex, setSavingTex] = React.useState(false);

  const selectedDoc = docs.find((d) => d.id === selectedId) ?? null;
  const delta = selectedDoc?.json_delta as CoverLetterDelta | undefined;
  const latestAttempt = verifications.reduce((max, v) => Math.max(max, v.attempt_number), 0);

  React.useEffect(() => {
    (async () => {
      try {
        const [d, tpls] = await Promise.all([
          api.listGroupDocuments(groupId, "cover_letter"),
          api.listTemplates("cover_letter"),
        ]);
        setDocs(d);
        setSelectedId(d[0]?.id ?? null);
        setTemplates(tpls);
        setTemplateId((prev) => prev || tpls[0]?.id || "");
      } catch (e) {
        toast.error(String(e));
      }
    })();
  }, [groupId]);

  React.useEffect(() => {
    (async () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setPreviewBlob(null);
      setEditingTex(false);
      if (!selectedId) {
        setVerifications([]);
        return;
      }
      try {
        setVerifications(await api.listDocumentVerifications(selectedId));
      } catch (e) {
        toast.error(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  React.useEffect(() => {
    if (!selectedId || !templateId) return;
    (async () => {
      try {
        const blob = await api.getRenderedPdf(selectedId, templateId);
        if (blob) {
          setPreviewUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return URL.createObjectURL(blob);
          });
          setPreviewBlob(blob);
        }
      } catch (e) {
        toast.error(String(e));
      }
    })();
  }, [selectedId, templateId]);

  async function handleGenerate() {
    setGenerating(true);
    setSteps([{ key: "tailoring", label: "Write cover letter draft", status: "pending" }]);
    try {
      for await (const event of api.streamGenerateCoverLetter(groupId, { tone, length })) {
        if (event.type === "stage") {
          setSteps((prev) => applyStageEvent(prev, event));
        } else if (event.type === "error") {
          toast.error(event.message);
        } else if (event.type === "done") {
          setDocs((prev) => [event.result, ...prev]);
          setSelectedId(event.result.id);
          toast.success(
            event.result.verified
              ? "Cover letter generated and verified"
              : "Cover letter generated — some claims could not be verified, export is blocked",
          );
        }
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function handlePreview() {
    if (!selectedDoc || !templateId) return;
    setRendering(true);
    try {
      const blob = await api.renderDocument(selectedDoc.id, templateId);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
      setPreviewBlob(blob);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setRendering(false);
    }
  }

  function handleExport() {
    if (!previewBlob || !selectedDoc) return;
    const url = URL.createObjectURL(previewBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cover-letter-v${selectedDoc.version}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleOpenTexEditor() {
    if (!selectedDoc || !templateId) return;
    setLoadingTex(true);
    setEditingTex(true);
    try {
      const { tex, is_edited } = await api.getDocumentTex(selectedDoc.id, templateId);
      setTexValue(tex);
      setTexIsEdited(is_edited);
    } catch (e) {
      toast.error(String(e));
      setEditingTex(false);
    } finally {
      setLoadingTex(false);
    }
  }

  async function handleSaveTex() {
    if (!selectedDoc || !templateId) return;
    setSavingTex(true);
    try {
      await api.saveDocumentTex(selectedDoc.id, templateId, texValue);
      setTexIsEdited(true);
      toast.success("Saved — this hand-edited version won't be overwritten by regenerating");
      await handlePreview();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSavingTex(false);
    }
  }

  async function handleResetTex() {
    if (!selectedDoc || !templateId) return;
    setSavingTex(true);
    try {
      await api.clearDocumentTex(selectedDoc.id, templateId);
      const { tex } = await api.getDocumentTex(selectedDoc.id, templateId);
      setTexValue(tex);
      setTexIsEdited(false);
      toast.success("Reset to the AI-generated draft");
      await handlePreview();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSavingTex(false);
    }
  }

  return (
    <div className="pt-2">
      <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Select value={tone} onValueChange={(v) => setTone(v as CoverLetterTone)}>
              <SelectTrigger className="w-44 h-8 text-xs">
                <SelectValue placeholder="Tone" />
              </SelectTrigger>
              <SelectContent>
                {COVER_LETTER_TONES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={length} onValueChange={(v) => setLength(v as CoverLetterLength)}>
              <SelectTrigger className="w-52 h-8 text-xs">
                <SelectValue placeholder="Length" />
              </SelectTrigger>
              <SelectContent>
                {COVER_LETTER_LENGTHS.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-start gap-4">
            <div className="relative">
              <Button size="sm" onClick={handleGenerate} disabled={generating}>
                <Sparkles className="size-4" />
                {generating ? "Writing…" : "Generate cover letter"}
              </Button>
              <CreditCostBadge featureKey="cover-letter" />
            </div>
            {steps.length > 0 && generating && (
              <div className="border border-border rounded-md p-3">
                <Stepper steps={steps} />
              </div>
            )}
            {docs.length > 1 && !generating && (
              <Select value={selectedId ?? ""} onValueChange={setSelectedId}>
                <SelectTrigger className="w-40 h-8 text-xs">
                  <SelectValue placeholder="Version" />
                </SelectTrigger>
                <SelectContent>
                  {docs.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      v{d.version} {d.verified ? "✓ verified" : "unverified"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {delta && selectedDoc && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="space-y-2 text-sm min-w-0">
                <Badge variant={selectedDoc.verified ? "default" : "destructive"}>
                  {selectedDoc.verified ? "verified" : "unverified — export blocked"}
                </Badge>
                <p className="mt-2">{delta.greeting}</p>
                {delta.paragraphs.map((p, i) => (
                  <p key={i}>{p.text}</p>
                ))}
                <p className="whitespace-pre-line">{delta.closing}</p>

                {verifications.length > 0 && (
                  <div className="pt-2">
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1">
                      Verification report {latestAttempt > 1 && `(attempt ${latestAttempt})`}
                    </h4>
                    <div className="space-y-1.5">
                      {verifications
                        .filter((v) => v.attempt_number === latestAttempt)
                        .map((v) => (
                          <div key={v.id} className="text-xs border border-border rounded-md p-2">
                            <VerdictBadge verdict={v.verdict} />
                            <div className="mt-1">{v.claim_text}</div>
                            {v.rationale && <div className="text-muted-foreground mt-0.5">{v.rationale}</div>}
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2 min-w-0">
                <div className="flex items-center gap-2">
                  <Select value={templateId} onValueChange={setTemplateId}>
                    <SelectTrigger className="w-48 h-8 text-xs">
                      <SelectValue placeholder="Template" />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="secondary" onClick={handlePreview} disabled={rendering}>
                    {rendering ? "Rendering…" : "Preview"}
                  </Button>
                  {!editingTex ? (
                    <Button size="sm" variant="ghost" onClick={handleOpenTexEditor} disabled={!templateId}>
                      <Pencil className="size-4" />
                      Edit LaTeX
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setEditingTex(false)}>
                      Close editor
                    </Button>
                  )}
                  <Button size="sm" onClick={handleExport} disabled={!previewBlob || !selectedDoc.verified}>
                    <Download className="size-4" />
                    Export
                  </Button>
                </div>

                {editingTex ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        The AI-generated letter is a draft — edit the LaTeX source directly if you don&apos;t
                        like something. {texIsEdited && <span className="font-medium text-foreground">Hand-edited.</span>}
                      </p>
                      {texIsEdited && (
                        <Button size="sm" variant="ghost" onClick={handleResetTex} disabled={savingTex}>
                          <RotateCcw className="size-3.5" />
                          Reset to AI draft
                        </Button>
                      )}
                    </div>
                    {loadingTex ? (
                      <div className="text-xs text-muted-foreground font-mono">Loading…</div>
                    ) : (
                      <textarea
                        value={texValue}
                        onChange={(e) => setTexValue(e.target.value)}
                        className="w-full font-mono text-xs border border-border rounded-md p-2 bg-background"
                        style={{ height: 460 }}
                        spellCheck={false}
                      />
                    )}
                    <Button size="sm" onClick={handleSaveTex} disabled={savingTex || loadingTex}>
                      {savingTex ? "Saving…" : "Save & preview"}
                    </Button>
                  </div>
                ) : (
                  <div
                    className="border border-border rounded-md overflow-hidden bg-muted/30"
                    style={{ height: 500 }}
                  >
                    {previewUrl ? (
                      <iframe src={previewUrl} className="w-full h-full" title="Cover letter preview" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground font-mono">
                        Choose a template and click Preview
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
    </div>
  );
}

// --- Answer Pack (F6.8) — ready-to-copy answers to real screening
// questions. This system has no scraped screening-question data
// (that's M4/F6 territory), so the questions are pasted in by the
// user from the real application, not guessed. No rendering/preview —
// "ready-to-copy" means copy-paste into a web form, not a PDF.

function AnswerPackPanel({ groupId }: { groupId: string }) {
  const [docs, setDocs] = React.useState<TailoredDocument[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [verifications, setVerifications] = React.useState<ClaimVerification[]>([]);
  const [questionsInput, setQuestionsInput] = React.useState("");
  const [generating, setGenerating] = React.useState(false);
  const [steps, setSteps] = React.useState<Step[]>([]);

  const selectedDoc = docs.find((d) => d.id === selectedId) ?? null;
  const delta = selectedDoc?.json_delta as AnswerPackDelta | undefined;
  const latestAttempt = verifications.reduce((max, v) => Math.max(max, v.attempt_number), 0);

  React.useEffect(() => {
    (async () => {
      try {
        const d = await api.listGroupDocuments(groupId, "answer_pack");
        setDocs(d);
        setSelectedId(d[0]?.id ?? null);
      } catch (e) {
        toast.error(String(e));
      }
    })();
  }, [groupId]);

  React.useEffect(() => {
    (async () => {
      if (!selectedId) {
        setVerifications([]);
        return;
      }
      try {
        setVerifications(await api.listDocumentVerifications(selectedId));
      } catch (e) {
        toast.error(String(e));
      }
    })();
  }, [selectedId]);

  async function handleGenerate() {
    const questions = questionsInput
      .split("\n")
      .map((q) => q.trim())
      .filter(Boolean);
    if (questions.length === 0) {
      toast.error("Paste at least one screening question, one per line");
      return;
    }
    setGenerating(true);
    setSteps([{ key: "tailoring", label: "Answer screening questions", status: "pending" }]);
    try {
      for await (const event of api.streamGenerateAnswerPack(groupId, questions)) {
        if (event.type === "stage") {
          setSteps((prev) => applyStageEvent(prev, event));
        } else if (event.type === "error") {
          toast.error(event.message);
        } else if (event.type === "done") {
          setDocs((prev) => [event.result, ...prev]);
          setSelectedId(event.result.id);
          toast.success(
            event.result.verified
              ? "Answer pack generated and verified"
              : "Answer pack generated — some claims could not be verified",
          );
        }
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Couldn't copy — your browser may be blocking clipboard access");
    }
  }

  return (
    <div className="pt-2">
      <div className="space-y-3">
          <div>
            <Label className="text-xs">Screening questions (one per line, from the real application)</Label>
            <textarea
              value={questionsInput}
              onChange={(e) => setQuestionsInput(e.target.value)}
              className="w-full text-sm border border-border rounded-md p-2 bg-background mt-1"
              style={{ height: 90 }}
              placeholder={"Why do you want to work here?\nDescribe a challenge you solved."}
            />
          </div>

          <div className="flex items-start gap-4">
            <div className="relative">
              <Button size="sm" onClick={handleGenerate} disabled={generating}>
                <Sparkles className="size-4" />
                {generating ? "Answering…" : "Generate answers"}
              </Button>
              <CreditCostBadge featureKey="answer-pack" />
            </div>
            {steps.length > 0 && generating && (
              <div className="border border-border rounded-md p-3">
                <Stepper steps={steps} />
              </div>
            )}
            {docs.length > 1 && !generating && (
              <Select value={selectedId ?? ""} onValueChange={setSelectedId}>
                <SelectTrigger className="w-40 h-8 text-xs">
                  <SelectValue placeholder="Version" />
                </SelectTrigger>
                <SelectContent>
                  {docs.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      v{d.version} {d.verified ? "✓ verified" : "unverified"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {delta && selectedDoc && (
            <div className="space-y-2 text-sm">
              <Badge variant={selectedDoc.verified ? "default" : "destructive"}>
                {selectedDoc.verified ? "verified" : "unverified — check the report below"}
              </Badge>
              <div className="space-y-2">
                {delta.answers.map((a, i) => (
                  <div key={i} className="border border-border rounded-md p-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-xs font-semibold text-muted-foreground">{a.question}</div>
                      <button
                        className="text-muted-foreground hover:text-foreground shrink-0"
                        onClick={() => handleCopy(a.answer)}
                        title="Copy answer"
                      >
                        <Copy className="size-3.5" />
                      </button>
                    </div>
                    <p className="mt-1">{a.answer}</p>
                  </div>
                ))}
              </div>

              {verifications.length > 0 && (
                <div className="pt-2">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1">
                    Verification report {latestAttempt > 1 && `(attempt ${latestAttempt})`}
                  </h4>
                  <div className="space-y-1.5">
                    {verifications
                      .filter((v) => v.attempt_number === latestAttempt)
                      .map((v) => (
                        <div key={v.id} className="text-xs border border-border rounded-md p-2">
                          <VerdictBadge verdict={v.verdict} />
                          <div className="mt-1">{v.claim_text}</div>
                          {v.rationale && <div className="text-muted-foreground mt-0.5">{v.rationale}</div>}
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
    </div>
  );
}

// Module-level, not component state — survives unmount/remount (i.e.
// navigating away and back), which is the whole point: a React state
// reset on every mount is exactly what made this page always start
// from a blank loading spinner. Same stale-while-revalidate shape
// credit-cost-badge.tsx's own module-level caches already use.
const _composerGroupsCache = new Map<
  string,
  { groups: JobGroup[]; jobs: InboxJob[]; evidence: EvidenceItem[] }
>();

export default function ComposerPage() {
  const router = useRouter();
  const { selectedPersonaId, selectedPersona } = usePersona();

  const [groups, setGroups] = React.useState<JobGroup[]>([]);
  const [addingToPipelineJobId, setAddingToPipelineJobId] = React.useState<string | null>(null);
  const [inboxJobs, setInboxJobs] = React.useState<InboxJob[]>([]);
  const [evidenceBank, setEvidenceBank] = React.useState<EvidenceItem[]>([]);
  const [selectedGroupId, setSelectedGroupId] = React.useState<string | null>(null);
  const [loadingGroups, setLoadingGroups] = React.useState(false);
  // Below `lg` the job-groups sidebar (permanently visible on desktop)
  // becomes a toggled full-screen browse overlay instead — a fixed
  // 256px sidebar next to the editor left almost nothing usable on a
  // phone width.
  const [groupsPanelOpen, setGroupsPanelOpen] = React.useState(false);

  const [newGroupOpen, setNewGroupOpen] = React.useState(false);
  const [newGroupName, setNewGroupName] = React.useState("");
  // Adrian, direct: composing a CV shouldn't require a real job
  // listing first — these back the "Target role" / "Target company"
  // fields in the New job group dialog, both optional and independent
  // of assigning real scored jobs afterward via the existing selector.
  const [newGroupTargetRole, setNewGroupTargetRole] = React.useState("");
  const [newGroupTargetCompany, setNewGroupTargetCompany] = React.useState("");
  const [creatingGroup, setCreatingGroup] = React.useState(false);

  const [documents, setDocuments] = React.useState<TailoredDocument[]>([]);
  const [selectedDocId, setSelectedDocId] = React.useState<string | null>(null);
  const [verifications, setVerifications] = React.useState<ClaimVerification[]>([]);
  const [showOlderAttempts, setShowOlderAttempts] = React.useState(false);
  const [skillGap, setSkillGap] = React.useState<SkillGapItem[]>([]);
  const [generatingSyllabusId, setGeneratingSyllabusId] = React.useState<string | null>(null);
  const [expandedSyllabusId, setExpandedSyllabusId] = React.useState<string | null>(null);
  const [templates, setTemplates] = React.useState<CvTemplate[]>([]);
  const [templateId, setTemplateId] = React.useState<string>("");

  const [tailoring, setTailoring] = React.useState(false);
  // Off by default (raised by Adrian) — the verify(+retry) pass roughly
  // doubles, worst case ~4x's, an already-slow tailor call. Re-verify
  // is still one click away on the generated draft for anyone who
  // wants the extra safety net, just not forced up front every time.
  const [verifyOnTailor, setVerifyOnTailor] = React.useState(false);
  const [reverifying, setReverifying] = React.useState(false);
  const [steps, setSteps] = React.useState<Step[]>([]);
  const [rendering, setRendering] = React.useState(false);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [previewBlob, setPreviewBlob] = React.useState<Blob | null>(null);

  const [editDelta, setEditDelta] = React.useState<TailoringDelta | null>(null);
  const [savingDelta, setSavingDelta] = React.useState(false);

  const selectedGroup = groups.find((g) => g.id === selectedGroupId) ?? null;
  // `documents` is fetched with doc_type="cv" (see loadGroupDetail),
  // so json_delta is guaranteed to be CV-shaped here — cast once
  // rather than at every read site, since TailoredDocument's own type
  // stays a union to match the wire shape both doc types actually use.
  const selectedDoc = documents.find((d) => d.id === selectedDocId) ?? null;
  const selectedCvDelta = selectedDoc?.json_delta as TailoringDelta | undefined;
  const jobsById = React.useMemo(() => new Map(inboxJobs.map((j) => [j.id, j])), [inboxJobs]);
  const latestAttempt = verifications.reduce((max, v) => Math.max(max, v.attempt_number), 0);
  // The card editor only mutates local state — Preview renders
  // whatever's currently SAVED on the document, so an edit made but
  // never saved would silently never show up (confirmed: this exact
  // report, deleting a section then hitting Preview with no save in
  // between). Compared by content, not reference, since editDelta is
  // seeded from the doc's own json_delta on load/save.
  const deltaDirty = Boolean(editDelta && selectedDoc && JSON.stringify(editDelta) !== JSON.stringify(selectedDoc.json_delta));
  // `selectedDoc.verified` alone can't tell "never checked" (verify was
  // skipped, or hasn't run yet) apart from "checked and still flagged"
  // — only the second one is a real reason to block export. A draft
  // that was never verified is the whole point of making verification
  // optional, so it exports freely; a draft the verifier actually
  // looked at and couldn't clear stays blocked, same as before.
  const canExportCv = Boolean(selectedDoc?.verified) || verifications.length === 0;

  const loadGroups = React.useCallback(async (personaId: string, profileId: string) => {
    // Stale-while-revalidate (Adrian, direct: "why do i have to wait
    // render everytime i check cv composer... is it not cached") —
    // this fetch (job groups + up to 500 inbox jobs + the full
    // evidence bank, three real round trips) used to re-run from a
    // blank loading state on every single visit to this page, even
    // seconds after the last one. A cached hit now paints instantly
    // (no spinner) while still kicking off the same real fetch in the
    // background to catch anything that actually changed — never
    // permanently stale, just not blocking on a visit that's probably
    // showing the same data as last time.
    const cached = _composerGroupsCache.get(personaId);
    if (cached) {
      setGroups(cached.groups);
      setInboxJobs(cached.jobs);
      setEvidenceBank(cached.evidence);
    } else {
      setLoadingGroups(true);
    }
    try {
      const [g, jobs, evidence] = await Promise.all([
        api.listJobGroups(personaId),
        api.listInboxJobs(personaId, { limit: 500 }),
        api.listEvidence(profileId),
      ]);
      _composerGroupsCache.set(personaId, { groups: g, jobs, evidence });
      setGroups(g);
      setInboxJobs(jobs);
      setEvidenceBank(evidence);
    } catch (e) {
      if (!cached) toast.error(String(e)); // a background revalidation failing silently is fine — the cached view is still shown
    } finally {
      setLoadingGroups(false);
    }
  }, []);

  React.useEffect(() => {
    if (!selectedPersonaId || !selectedPersona) return;
    (() => {
      setSelectedGroupId(null);
      void loadGroups(selectedPersonaId, selectedPersona.profile_id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPersonaId]);

  const loadGroupDetail = React.useCallback(async (groupId: string) => {
    try {
      const [docs, gap, tpls] = await Promise.all([
        api.listGroupDocuments(groupId, "cv"),
        api.getSkillGap(groupId),
        api.listTemplates(),
      ]);
      setDocuments(docs);
      setSelectedDocId(docs[0]?.id ?? null);
      setSkillGap(gap);
      setTemplates(tpls);
      setTemplateId((prev) => prev || tpls[0]?.id || "");
    } catch (e) {
      toast.error(String(e));
    }
  }, []);

  React.useEffect(() => {
    (() => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setPreviewBlob(null);
      if (!selectedGroupId) {
        setDocuments([]);
        setSelectedDocId(null);
        setSkillGap([]);
        return;
      }
      void loadGroupDetail(selectedGroupId);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupId]);

  React.useEffect(() => {
    (async () => {
      setShowOlderAttempts(false);
      if (!selectedDocId) {
        setVerifications([]);
        setEditDelta(null);
        return;
      }
      setEditDelta((documents.find((d) => d.id === selectedDocId)?.json_delta as TailoringDelta | undefined) ?? null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setPreviewBlob(null);
      try {
        setVerifications(await api.listDocumentVerifications(selectedDocId));
      } catch (e) {
        toast.error(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDocId]);

  // Restores a previously-rendered PDF for this exact document +
  // template, instead of always starting blank until an explicit
  // Preview click — raised by Adrian: "every time I refresh the page
  // I have to click preview again," even though a real render already
  // existed in object storage.
  React.useEffect(() => {
    if (!selectedDocId || !templateId) return;
    (async () => {
      try {
        const blob = await api.getRenderedPdf(selectedDocId, templateId);
        if (blob) {
          setPreviewUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return URL.createObjectURL(blob);
          });
          setPreviewBlob(blob);
        }
      } catch (e) {
        toast.error(String(e));
      }
    })();
  }, [selectedDocId, templateId]);

  async function handleCreateGroup() {
    if (!selectedPersonaId || !newGroupName.trim()) return;
    setCreatingGroup(true);
    try {
      const group = await api.createJobGroup(selectedPersonaId, {
        name: newGroupName.trim(),
        target_role_title: newGroupTargetRole.trim() || null,
        target_company: newGroupTargetCompany.trim() || null,
      });
      setGroups((prev) => [...prev, group]);
      setSelectedGroupId(group.id);
      setNewGroupName("");
      setNewGroupTargetRole("");
      setNewGroupTargetCompany("");
      setNewGroupOpen(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCreatingGroup(false);
    }
  }

  async function handleDeleteGroup(groupId: string) {
    try {
      await api.deleteJobGroup(groupId);
      setGroups((prev) => prev.filter((g) => g.id !== groupId));
      if (selectedGroupId === groupId) setSelectedGroupId(null);
      toast.success("Job group deleted");
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function handleToggleMember(jobId: string, member: boolean) {
    if (!selectedGroup) return;
    try {
      const updated = member
        ? await api.removeJobGroupMember(selectedGroup.id, jobId)
        : await api.addJobGroupMember(selectedGroup.id, jobId);
      setGroups((prev) => prev.map((g) => (g.id === updated.id ? updated : g)));
      setSkillGap(await api.getSkillGap(updated.id));
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function handleAddToPipeline(jobId: string) {
    if (!selectedPersonaId || !selectedGroup) return;
    setAddingToPipelineJobId(jobId);
    try {
      // Same idempotent-server-side create Inbox's own "Add to
      // Pipeline" button relies on — safe to click again on a job
      // that's already tracked, it just reopens it. job_group_id ties
      // the Application back to this Composer session; primary_document_id
      // is this group's currently-selected tailored document, if one
      // has been generated yet (a group with no generated CV at all
      // still creates the Application, just without one attached).
      const application: Application = await api.createApplication({
        job_id: jobId,
        persona_id: selectedPersonaId,
        job_group_id: selectedGroup.id,
        ...(selectedDoc ? { primary_document_id: selectedDoc.id } : {}),
      });
      router.push(`/console/pipeline?application_id=${application.id}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setAddingToPipelineJobId(null);
    }
  }

  async function handleGenerate() {
    if (!selectedGroup) return;
    const verify = verifyOnTailor;
    setTailoring(true);
    setSteps(initialSteps());
    try {
      for await (const event of api.streamTailorJobGroup(selectedGroup.id, verify)) {
        if (event.type === "stage") {
          setSteps((prev) => applyStageEvent(prev, event));
        } else if (event.type === "error") {
          toast.error(event.message);
        } else if (event.type === "done") {
          setDocuments((prev) => [event.result, ...prev]);
          setSelectedDocId(event.result.id);
          toast.success(
            !verify
              ? "Tailored CV generated — claims weren't checked (verification was off)"
              : event.result.verified
                ? "Tailored CV generated and verified"
                : "Tailored CV generated — some claims could not be verified, export is blocked",
          );
          // Preview starts automatically — the user only needs to
          // press Preview themselves after an edit, not after every
          // fresh generation (raised by Adrian).
          await renderPreviewFor(event.result);
        }
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setTailoring(false);
    }
  }

  async function handleReverify() {
    if (!selectedDoc) return;
    setReverifying(true);
    setSteps([{ key: "verifying-1", label: "Verify claims", status: "pending" }]);
    try {
      for await (const event of api.streamReverifyDocument(selectedDoc.id)) {
        if (event.type === "stage") {
          setSteps((prev) => applyStageEvent(prev, event));
        } else if (event.type === "error") {
          toast.error(event.message);
        } else if (event.type === "done") {
          setDocuments((prev) => prev.map((d) => (d.id === event.result.id ? event.result : d)));
          setVerifications(await api.listDocumentVerifications(event.result.id));
          toast.success(event.result.verified ? "Verified" : "Still not fully verified — see the report below");
        }
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setReverifying(false);
    }
  }

  /** Persists the card editor's pending edit, if any — shared by the
   * explicit "Save changes" button and by Preview, which must save a
   * pending edit itself before rendering or it would silently render
   * the last-saved (i.e. stale) content instead of what's on screen. */
  async function persistDeltaIfDirty(): Promise<TailoredDocument | null> {
    if (!selectedDoc || !editDelta || !deltaDirty) return null;
    const updated = await api.saveDocumentDelta(selectedDoc.id, editDelta);
    setDocuments((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
    setEditDelta(updated.json_delta as TailoringDelta);
    toast.success("Saved — this document is now unverified again; re-verify before exporting");
    return updated;
  }

  /** Shared by the manual Preview button and the auto-render right
   * after a tailored CV finishes generating — takes the document
   * explicitly rather than reading `selectedDoc` so the just-generated
   * doc renders immediately without waiting on a state update/re-render
   * to land first (calling this straight after `setSelectedDocId` in
   * the same tick would otherwise still see the PREVIOUS `selectedDoc`
   * from this render's closure). */
  async function renderPreviewFor(doc: TailoredDocument) {
    if (!templateId) return;
    setRendering(true);
    try {
      const blob = await api.renderDocument(doc.id, templateId);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
      setPreviewBlob(blob);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setRendering(false);
    }
  }

  async function handleRenderPreview() {
    if (!selectedDoc || !templateId) return;
    setRendering(true);
    try {
      await persistDeltaIfDirty();
    } catch (e) {
      toast.error(String(e));
      setRendering(false);
      return;
    }
    await renderPreviewFor(selectedDoc);
  }

  function handleExport() {
    if (!previewBlob || !selectedDoc) return;
    const url = URL.createObjectURL(previewBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cv-${selectedGroup?.name ?? "tailored"}-v${selectedDoc.version}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleSaveDelta() {
    if (!selectedDoc || !editDelta) return;
    setSavingDelta(true);
    try {
      const saved = await persistDeltaIfDirty();
      // Re-render immediately so the preview reflects this edit
      // without a separate manual Preview click — same convention as
      // the LaTeX editor's "Save & preview".
      if (saved) await handleRenderPreview();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSavingDelta(false);
    }
  }

  async function handleToggleSkillGap(item: SkillGapItem) {
    if (!selectedGroup) return;
    try {
      const updated =
        item.status === "done"
          ? await api.reopenSkillGapItem(selectedGroup.id, item.id)
          : await api.completeSkillGapItem(selectedGroup.id, item.id);
      setSkillGap((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      toast.success(
        updated.status === "done"
          ? `Added "${updated.skill_text}" to your evidence bank`
          : `Removed "${updated.skill_text}" from your evidence bank`,
      );
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function handleGenerateSyllabus(item: SkillGapItem) {
    if (!selectedGroup) return;
    setGeneratingSyllabusId(item.id);
    try {
      const updated = await api.generateSkillGapSyllabus(selectedGroup.id, item.id);
      setSkillGap((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setExpandedSyllabusId(updated.id);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setGeneratingSyllabusId(null);
    }
  }

  const busy = tailoring || reverifying;
  const shownVerifications = verifications.filter(
    (v) => showOlderAttempts || v.attempt_number === latestAttempt,
  );

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-2 px-5 justify-between">
        <div className="flex items-center gap-2 min-w-0">
          {selectedPersonaId && (
            <Button
              size="sm"
              variant="outline"
              className="lg:hidden shrink-0"
              onClick={() => setGroupsPanelOpen(true)}
            >
              {selectedGroup ? selectedGroup.name : "Base CV"}
            </Button>
          )}
          <span className="text-sm font-semibold">CV Composer</span>
        </div>
        {selectedPersona && (
          <span className="text-xs text-muted-foreground font-mono truncate">Persona: {selectedPersona.name}</span>
        )}
      </header>

      {!selectedPersonaId ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground font-mono">
          Select or create a persona in the sidebar first
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden relative">
          {/* Backdrop — mobile only, closes the job-groups browse
              overlay below the same way tapping outside any other
              drawer in this app does. */}
          {groupsPanelOpen && (
            <div
              className="fixed inset-0 z-40 bg-black/40 lg:hidden"
              onClick={() => setGroupsPanelOpen(false)}
              aria-hidden="true"
            />
          )}

          {/* Job groups sidebar — permanently visible on desktop;
              below `lg` it's a toggled full-screen browse overlay
              instead (opened via the header button above), since a
              permanent 256px sidebar next to the editor left almost
              nothing usable on a phone width. */}
          <div
            className={cn(
              "w-64 shrink-0 border-r border-border overflow-y-auto p-3 space-y-2 bg-card",
              "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-50 max-lg:w-[85%] max-lg:max-w-xs max-lg:transition-transform max-lg:duration-200",
              groupsPanelOpen ? "max-lg:translate-x-0" : "max-lg:-translate-x-full",
            )}
          >
            <div className="flex items-center justify-between lg:hidden">
              <span className="text-xs font-semibold text-muted-foreground uppercase">Browse</span>
              <Button size="icon" variant="ghost" className="size-6" onClick={() => setGroupsPanelOpen(false)}>
                <X className="size-4" />
              </Button>
            </div>
            <button
              onClick={() => {
                setSelectedGroupId(null);
                setGroupsPanelOpen(false);
              }}
              className={`flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-sm text-left ${
                !selectedGroupId ? "bg-muted font-medium" : "hover:bg-muted/50 text-muted-foreground"
              }`}
            >
              <FileText className="size-3.5 shrink-0" />
              Base CV
            </button>
            <Separator />
            <div className="flex items-center justify-between px-1">
              <span className="text-xs font-semibold text-muted-foreground uppercase">Job groups</span>
              <Button size="icon" variant="ghost" className="size-6" onClick={() => setNewGroupOpen(true)}>
                <Plus className="size-4" />
              </Button>
            </div>
            {loadingGroups && <div className="text-xs text-muted-foreground px-1">Loading…</div>}
            {!loadingGroups && groups.length === 0 && (
              <div className="text-xs text-muted-foreground px-1">
                No job groups yet. Create one and assign scored jobs to it — one CV can serve every job in a
                group at once.
              </div>
            )}
            {groups.map((g) => (
              <div
                key={g.id}
                className={`group flex items-center justify-between rounded-md px-2 py-1.5 text-sm cursor-pointer ${
                  g.id === selectedGroupId ? "bg-muted" : "hover:bg-muted/50"
                }`}
                onClick={() => {
                  setSelectedGroupId(g.id);
                  setGroupsPanelOpen(false);
                }}
              >
                <div className="min-w-0">
                  <div className="truncate">{g.name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {g.job_ids.length > 0
                      ? `${g.job_ids.length} job(s)`
                      : g.target_role_title
                        ? `Targeting: ${g.target_role_title}${g.target_company ? ` @ ${g.target_company}` : ""}`
                        : "0 job(s)"}
                  </div>
                </div>
                <button
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteGroup(g.id);
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>

          {/* Main panel */}
          {!selectedGroup ? (
            selectedPersonaId && selectedPersona ? (
              <BaseCvPanel personaId={selectedPersonaId} profileId={selectedPersona.profile_id} />
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground font-mono">
                Select a job group
              </div>
            )
          ) : (
            <div className="flex-1 overflow-y-auto p-5 space-y-6">
              <div>
                <h2 className="text-lg font-semibold">{selectedGroup.name}</h2>
                {selectedGroup.job_ids.length === 0 && selectedGroup.target_role_title && (
                  <p className="text-xs text-muted-foreground mt-1">
                    No specific job listing — tailoring generally toward{" "}
                    <span className="font-medium text-foreground">{selectedGroup.target_role_title}</span>
                    {selectedGroup.target_company && (
                      <>
                        {" "}
                        at <span className="font-medium text-foreground">{selectedGroup.target_company}</span>
                      </>
                    )}
                    .
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedGroup.job_ids.map((jobId) => {
                    const job = jobsById.get(jobId);
                    return (
                      <Badge key={jobId} variant="outline" className="gap-1">
                        {job ? `${job.title} · ${job.company_name_raw}` : jobId}
                        <button
                          className="text-muted-foreground hover:text-primary disabled:opacity-50"
                          title="Add to Pipeline — creates a tracked Application with this group's tailored document attached"
                          onClick={() => handleAddToPipeline(jobId)}
                          disabled={addingToPipelineJobId === jobId}
                        >
                          <Send className="size-3" />
                        </button>
                        <button
                          className="ml-1 text-muted-foreground hover:text-destructive"
                          onClick={() => handleToggleMember(jobId, true)}
                        >
                          ×
                        </button>
                      </Badge>
                    );
                  })}
                </div>
                <div className="mt-2">
                  <Select onValueChange={(jobId) => handleToggleMember(jobId, false)} value="">
                    <SelectTrigger className="w-72 h-8 text-xs">
                      <SelectValue placeholder="+ add a scored job to this group" />
                    </SelectTrigger>
                    <SelectContent>
                      {inboxJobs
                        .filter((j) => !selectedGroup.job_ids.includes(j.id))
                        .map((j) => (
                          <SelectItem key={j.id} value={j.id}>
                            {j.title} · {j.company_name_raw}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Separator />

              {/* CV / Cover Letter / Answer Pack as real tabs, not one
                  long scroll — raised by Adrian: a lengthy CV
                  verification report pushed Cover Letter out of reach
                  below it. Each document type keeps its own generate
                  + preview flow, just switched between instead of
                  stacked. */}
              <Tabs defaultValue="cv">
                <TabsList>
                  <TabsTrigger value="cv">CV</TabsTrigger>
                  <TabsTrigger value="cover-letter">Cover Letter</TabsTrigger>
                  <TabsTrigger value="answer-pack">Answer Pack</TabsTrigger>
                </TabsList>

                <TabsContent value="cv" className="space-y-6">
              {/* Skill-gap checklist */}
              {skillGap.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold mb-2">Skill gap for this group</h3>
                  <div className="space-y-1.5">
                    {skillGap.map((item) => {
                      const expanded = expandedSyllabusId === item.id;
                      const generating = generatingSyllabusId === item.id;
                      return (
                        <div key={item.id}>
                          <div className="flex items-center gap-2 text-sm">
                            <label className="flex items-center gap-2 flex-1 min-w-0">
                              <Checkbox
                                checked={item.status === "done"}
                                onCheckedChange={() => handleToggleSkillGap(item)}
                              />
                              <span className={item.status === "done" ? "line-through text-muted-foreground" : ""}>
                                {item.skill_text}
                              </span>
                            </label>
                            <div className="relative shrink-0">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[11px] text-muted-foreground"
                                disabled={generating}
                                onClick={() =>
                                  item.syllabus
                                    ? setExpandedSyllabusId(expanded ? null : item.id)
                                    : handleGenerateSyllabus(item)
                                }
                              >
                                {generating ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : item.syllabus ? (
                                  expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />
                                ) : (
                                  <GraduationCap className="size-3" />
                                )}
                                {generating ? "Generating…" : item.syllabus ? "Learning plan" : "Generate learning plan"}
                              </Button>
                              {!item.syllabus && <CreditCostBadge featureKey="skill-gap-syllabus" />}
                            </div>
                          </div>

                          {expanded && item.syllabus && (
                            <div className="ml-6 mt-1.5 mb-2 rounded-md border border-border bg-muted/30 p-2.5 space-y-2 text-xs">
                              <div>
                                <div className="font-semibold text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
                                  Resources
                                </div>
                                <ul className="space-y-1">
                                  {item.syllabus.resources.map((r, i) => (
                                    <li key={i}>
                                      <a
                                        href={r.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-primary hover:underline"
                                      >
                                        {r.title}
                                        <ExternalLink className="size-2.5" />
                                      </a>
                                      <span className="text-muted-foreground"> · {r.kind}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                              <div>
                                <div className="font-semibold text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
                                  Project ideas
                                </div>
                                <ul className="space-y-1 list-disc pl-4">
                                  {item.syllabus.project_ideas.map((p, i) => (
                                    <li key={i}>
                                      <span className="font-medium">{p.title}</span> — {p.description}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                              <button
                                className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
                                disabled={generating}
                                onClick={() => handleGenerateSyllabus(item)}
                              >
                                Regenerate
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Checking a skill off adds it to your evidence bank as self-attested, so future CVs can
                    honestly cite it.
                  </p>
                </div>
              )}

              <Separator />

              <div className="flex items-start gap-4">
                <div className="flex flex-col gap-2">
                  <div className="relative w-fit">
                    <Button
                      onClick={handleGenerate}
                      disabled={busy || (selectedGroup.job_ids.length === 0 && !selectedGroup.target_role_title)}
                    >
                      <Sparkles className="size-4" />
                      {tailoring ? "Generating…" : "Generate tailored CV"}
                    </Button>
                    <CreditCostBadge featureKey="cv-tailor" />
                  </div>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Checkbox
                      checked={verifyOnTailor}
                      onCheckedChange={(v) => setVerifyOnTailor(v === true)}
                      disabled={busy}
                    />
                    Verify claims against evidence bank
                  </label>
                  <p className="text-xs text-muted-foreground max-w-52">
                    {verifyOnTailor
                      ? "Two real AI steps (draft, then verify), each 1-3+ minutes — plus one automatic retry if the verifier flags a claim, so a full run can take a few minutes."
                      : "One AI step (draft only) — faster, but claims aren't fact-checked against your evidence bank. Run Re-verify on the draft any time, or turn this on."}
                  </p>
                </div>
                {steps.length > 0 && busy && (
                  <div className="border border-border rounded-md p-3">
                    <Stepper steps={steps} />
                  </div>
                )}
                {documents.length > 1 && !busy && (
                  <Select value={selectedDocId ?? ""} onValueChange={setSelectedDocId}>
                    <SelectTrigger className="w-40 h-8 text-xs">
                      <SelectValue placeholder="Version" />
                    </SelectTrigger>
                    <SelectContent>
                      {documents.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          v{d.version} {d.verified ? "✓ verified" : "unverified"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {selectedDoc && (
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <div className="space-y-4 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={
                          selectedDoc.verified ? "default" : verifications.length === 0 ? "outline" : "destructive"
                        }
                      >
                        {selectedDoc.verified
                          ? "verified"
                          : verifications.length === 0
                            ? "not verified"
                            : "unverified — export blocked"}
                      </Badge>
                      {!selectedDoc.verified && !busy && (
                        <Button size="sm" variant="secondary" onClick={handleReverify}>
                          Re-verify
                        </Button>
                      )}
                    </div>
                    {!selectedDoc.verified && !busy && verifications.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        This draft has never actually been checked yet (verification was off, or hasn&apos;t run) —
                        export works either way, but click Re-verify if you want claims fact-checked against your
                        evidence bank first.
                      </p>
                    )}

                    <Tabs defaultValue="diff">
                      <TabsList>
                        <TabsTrigger value="diff">What changed</TabsTrigger>
                        <TabsTrigger value="summary">Summary &amp; rationale</TabsTrigger>
                        <TabsTrigger value="edit">Edit sections</TabsTrigger>
                      </TabsList>
                      <TabsContent value="diff">
                        {selectedCvDelta && <DeltaDiffView delta={selectedCvDelta} evidenceBank={evidenceBank} />}
                      </TabsContent>
                      <TabsContent value="summary" className="space-y-3">
                        <p className="text-sm">{selectedCvDelta?.summary}</p>
                        <div>
                          <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1">Rationale</h4>
                          <p className="text-xs text-muted-foreground">{selectedCvDelta?.rationale}</p>
                        </div>
                        {selectedCvDelta && selectedCvDelta.skills_highlight.length > 0 && (
                          <div>
                            <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1">
                              Skills highlighted
                            </h4>
                            <div className="flex flex-wrap gap-1">
                              {selectedCvDelta.skills_highlight.map((s) => (
                                <Badge key={s} variant="outline">
                                  {s}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </TabsContent>
                      <TabsContent value="edit" className="space-y-2">
                        <p className="text-xs text-muted-foreground">
                          Add or remove a whole experience card, or add/remove/reword a bullet. Employer, title,
                          and dates always come straight from your evidence bank and can&apos;t be changed here —
                          only bullet wording. Saving resets this document to unverified.
                        </p>
                        {editDelta && (
                          <SectionCardEditor delta={editDelta} evidenceBank={evidenceBank} onChange={setEditDelta} />
                        )}
                        <div className="relative w-fit">
                          <Button size="sm" onClick={handleSaveDelta} disabled={savingDelta}>
                            {savingDelta ? "Saving…" : "Save changes"}
                          </Button>
                          <CreditCostBadge featureKey="cv-tailor" />
                        </div>
                      </TabsContent>
                    </Tabs>

                    {verifications.length > 0 && (
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <h4 className="text-xs font-semibold text-muted-foreground uppercase">
                            Verification report {latestAttempt > 1 && `(attempt ${latestAttempt})`}
                          </h4>
                          {latestAttempt > 1 && (
                            <button
                              className="text-xs text-muted-foreground underline"
                              onClick={() => setShowOlderAttempts((v) => !v)}
                            >
                              {showOlderAttempts ? "hide earlier attempt" : "show earlier attempt"}
                            </button>
                          )}
                        </div>
                        <div className="space-y-1.5">
                          {shownVerifications.map((v) => (
                            <div key={v.id} className="text-xs border border-border rounded-md p-2">
                              <div className="flex items-center gap-2 mb-1">
                                <VerdictBadge verdict={v.verdict} />
                                {latestAttempt > 1 && (
                                  <span className="text-muted-foreground">attempt {v.attempt_number}</span>
                                )}
                              </div>
                              <div>{v.claim_text}</div>
                              {v.rationale && <div className="text-muted-foreground mt-0.5">{v.rationale}</div>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-3 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Select value={templateId} onValueChange={setTemplateId}>
                        <SelectTrigger className="w-56 h-8 text-xs">
                          <SelectValue placeholder="Template" />
                        </SelectTrigger>
                        <SelectContent>
                          {templates.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button size="sm" variant="secondary" onClick={handleRenderPreview} disabled={rendering}>
                        {rendering ? "Rendering…" : "Preview"}
                      </Button>
                      <Button
                        size="sm"
                        onClick={handleExport}
                        disabled={!previewBlob || !canExportCv}
                        title={!canExportCv ? "Export is blocked until every claim is verified" : ""}
                      >
                        <Download className="size-4" />
                        Export
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Want to change the LaTeX directly — remove a section, reword something, adjust formatting?
                      Ask the Assistant in chat (it can list your CVs and edit one&apos;s LaTeX per your instruction).
                    </p>

                    <div
                      className="border border-border rounded-md overflow-hidden bg-muted/30"
                      style={{ height: 600 }}
                    >
                      {previewUrl ? (
                        <iframe src={previewUrl} className="w-full h-full" title="CV preview" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground font-mono">
                          Choose a template and click Preview
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

                </TabsContent>

                <TabsContent value="cover-letter">
                  <CoverLetterPanel groupId={selectedGroup.id} />
                </TabsContent>
                <TabsContent value="answer-pack">
                  <AnswerPackPanel groupId={selectedGroup.id} />
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>
      )}

      <Dialog
        open={newGroupOpen}
        onOpenChange={(open) => {
          setNewGroupOpen(open);
          if (!open) {
            setNewGroupTargetRole("");
            setNewGroupTargetCompany("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New job group</DialogTitle>
            <DialogDescription>
              Assign real scored jobs from the Job Inbox afterward, and/or set a target role below — a group
              with no jobs but a target role is tailored generally toward that role instead of any one
              listing.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="group-name">Name</Label>
              <Input
                id="group-name"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="e.g. Backend roles"
                onKeyDown={(e) => e.key === "Enter" && handleCreateGroup()}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-target-role">Target role (optional)</Label>
              <Input
                id="group-target-role"
                value={newGroupTargetRole}
                onChange={(e) => setNewGroupTargetRole(e.target.value)}
                placeholder="e.g. Senior Backend Engineer"
                onKeyDown={(e) => e.key === "Enter" && handleCreateGroup()}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-target-company">Target company (optional)</Label>
              <Input
                id="group-target-company"
                value={newGroupTargetCompany}
                onChange={(e) => setNewGroupTargetCompany(e.target.value)}
                placeholder="e.g. Acme Corp"
                onKeyDown={(e) => e.key === "Enter" && handleCreateGroup()}
              />
            </div>
          </div>
          <Button onClick={handleCreateGroup} disabled={creatingGroup || !newGroupName.trim()}>
            {creatingGroup ? "Creating…" : "Create"}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
