"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  api,
  type ConversationCard,
  type EvidenceItem,
  type TailoredDocument,
  type TailoringDelta,
} from "@/lib/api";
import { usePersona } from "@/components/persona-provider";
import { DeltaDiffView } from "@/components/delta-diff-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// M7.1 — the Assistant chat's rich embeds. A tool result the model
// sees is always plain text (orchestrator_tools.py's own return
// value); these three components render the structured side-channel
// `emit_card` also sends, so a scored job list, a tailored document,
// or a running application show up as real, clickable content instead
// of being collapsed into prose. Every embed reuses an existing page's
// own data/components rather than re-implementing anything — a job
// row links into the real Job Inbox, the document preview/diff reuse
// exactly what Composer already built, and the application card links
// into the real Pipeline/Live Browser pages for anything beyond a
// one-time log snapshot.

function recommendationVariant(recommendation: string): "default" | "secondary" | "outline" {
  if (recommendation === "strong_apply") return "default";
  if (recommendation === "apply") return "secondary";
  return "outline";
}

export function JobsCard({ card }: { card: Extract<ConversationCard, { card_type: "jobs" }> }) {
  if (card.jobs.length === 0) {
    return (
      <div className="max-w-[85%] rounded-md border border-border bg-card p-3 text-xs text-muted-foreground">
        No matching jobs yet.
      </div>
    );
  }
  return (
    <div className="max-w-[85%] rounded-md border border-border bg-card p-2 space-y-1.5">
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground px-1">
        {card.jobs.length} job{card.jobs.length === 1 ? "" : "s"}
      </div>
      {card.jobs.map((job) => (
        <Link
          key={job.job_id}
          href={`/inbox?job_id=${encodeURIComponent(job.job_id)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded border border-border bg-background px-2 py-1.5 text-xs hover:border-primary transition-colors"
        >
          <Badge variant={recommendationVariant(job.recommendation)} className="shrink-0 text-[9px] font-mono">
            {job.recommendation}
          </Badge>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{job.title}</div>
            <div className="truncate text-muted-foreground">
              {job.company_name}
              {job.location ? ` · ${job.location}` : ""}
            </div>
          </div>
          <div className="shrink-0 font-mono text-sm font-semibold tabular-nums">{job.score}</div>
        </Link>
      ))}
    </div>
  );
}

export function DocumentCard({ card }: { card: Extract<ConversationCard, { card_type: "document" }> }) {
  const { selectedPersona } = usePersona();
  const [tab, setTab] = React.useState<"preview" | "diff">("preview");
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = React.useState(true);
  const [document, setDocument] = React.useState<TailoredDocument | null>(null);
  const [evidenceBank, setEvidenceBank] = React.useState<EvidenceItem[] | null>(null);
  const [loadingDiff, setLoadingDiff] = React.useState(false);
  const previewUrlRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingPreview(true);
      try {
        const blob = (await api.getRenderedPdf(card.document_id, card.template))
          ?? (await api.renderDocument(card.document_id, card.template));
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        previewUrlRef.current = url;
        setPreviewUrl(url);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : "Failed to load the document preview");
      } finally {
        if (!cancelled) setLoadingPreview(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [card.document_id, card.template]);

  React.useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  async function handleShowDiff() {
    setTab("diff");
    if (document && evidenceBank) return;
    setLoadingDiff(true);
    try {
      const [doc, evidence] = await Promise.all([
        document ?? api.getDocument(card.document_id),
        selectedPersona ? api.listEvidence(selectedPersona.profile_id) : Promise.resolve([]),
      ]);
      setDocument(doc);
      setEvidenceBank(evidence);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load what changed");
    } finally {
      setLoadingDiff(false);
    }
  }

  const docTypeLabel = card.doc_type === "cover_letter" ? "Cover letter" : card.doc_type === "answer_pack" ? "Answer pack" : "CV";

  return (
    <div className="max-w-[85%] w-full rounded-md border border-border bg-card p-2 space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{docTypeLabel}</span>
        <div className="flex items-center gap-2">
          <Badge variant={card.verified ? "default" : "destructive"} className="text-[9px]">
            {card.verified ? "verified" : "not verified"}
          </Badge>
          <Link href="/composer" target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary hover:underline">
            Open in Composer ↗
          </Link>
        </div>
      </div>

      {card.doc_type === "cv" && (
        <div className="flex gap-1 px-1">
          <Button size="sm" variant={tab === "preview" ? "secondary" : "ghost"} className="h-6 px-2 text-[10px]" onClick={() => setTab("preview")}>
            Preview
          </Button>
          <Button size="sm" variant={tab === "diff" ? "secondary" : "ghost"} className="h-6 px-2 text-[10px]" onClick={handleShowDiff}>
            What changed
          </Button>
        </div>
      )}

      {tab === "preview" || card.doc_type !== "cv" ? (
        loadingPreview ? (
          <div className="flex h-64 items-center justify-center text-xs text-muted-foreground font-mono">loading preview…</div>
        ) : previewUrl ? (
          <iframe src={previewUrl} className="w-full h-64 rounded border border-border bg-background" title={`${docTypeLabel} preview`} />
        ) : (
          <div className="flex h-64 items-center justify-center text-xs text-muted-foreground font-mono">preview unavailable</div>
        )
      ) : loadingDiff ? (
        <div className="flex h-64 items-center justify-center text-xs text-muted-foreground font-mono">loading…</div>
      ) : document && evidenceBank ? (
        <div className="max-h-80 overflow-y-auto p-1">
          <DeltaDiffView delta={document.json_delta as TailoringDelta} evidenceBank={evidenceBank} />
        </div>
      ) : (
        <div className="flex h-64 items-center justify-center text-xs text-muted-foreground font-mono">unavailable</div>
      )}
    </div>
  );
}

export function ApplicationCard({ card }: { card: Extract<ConversationCard, { card_type: "application" }> }) {
  const [log, setLog] = React.useState<string[] | null>(null);
  const [loadingLog, setLoadingLog] = React.useState(false);

  async function handleShowLog() {
    if (!card.attempt_id) return;
    setLoadingLog(true);
    try {
      const events = await api.getApplicationAttemptEvents(card.application_id, card.attempt_id);
      setLog(
        events
          .filter((e): e is Extract<typeof e, { type: "stage" }> => e.type === "stage")
          .map((e) => e.message)
          .filter(Boolean),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load the run log");
    } finally {
      setLoadingLog(false);
    }
  }

  return (
    <div className="max-w-[85%] w-full rounded-md border border-border bg-card p-2 space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Application</span>
        <div className="flex items-center gap-2 text-[10px]">
          <Link href={`/pipeline?application_id=${encodeURIComponent(card.application_id)}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            View in Pipeline ↗
          </Link>
          {card.session_id && card.attempt_id && (
            <Link
              href={`/pipeline/live?application_id=${encodeURIComponent(card.application_id)}&attempt_id=${encodeURIComponent(card.attempt_id)}&session_id=${encodeURIComponent(card.session_id)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Watch live browser ↗
            </Link>
          )}
        </div>
      </div>

      {log === null ? (
        <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={handleShowLog} disabled={!card.attempt_id || loadingLog}>
          {loadingLog ? "loading…" : "Show run log"}
        </Button>
      ) : (
        <div className="max-h-40 overflow-y-auto rounded border border-border bg-background p-2 text-[10px] font-mono space-y-1">
          {log.length === 0 ? (
            <div className="text-muted-foreground">no log lines yet</div>
          ) : (
            log.map((line, i) => <div key={i}>{line}</div>)
          )}
        </div>
      )}
    </div>
  );
}
