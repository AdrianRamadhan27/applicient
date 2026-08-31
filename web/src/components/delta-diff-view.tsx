import * as React from "react";
import { wordDiff } from "@/lib/diff";
import type { EvidenceItem, TailoringDelta } from "@/lib/api";

// Promoted out of composer/page.tsx so the Assistant chat's document
// card can reuse the exact same evidence-item-centric CV diff view —
// for each evidence-bank item, the tailored bullet(s) derived from it
// with inline word-diff highlighting against the original evidence
// text, or a strikethrough note if that item didn't make it in.
function DiffTokens({ text, source }: { text: string; source: string }) {
  const tokens = React.useMemo(() => wordDiff(source, text), [source, text]);
  return (
    <>
      {tokens.map((t, i) => {
        if (t.type === "same") return <span key={i}>{t.text}</span>;
        if (t.type === "add")
          return (
            <span key={i} className="bg-primary/15 text-primary rounded-[2px]">
              {t.text}
            </span>
          );
        return (
          <span key={i} className="bg-destructive/15 text-destructive line-through rounded-[2px]">
            {t.text}
          </span>
        );
      })}
    </>
  );
}

export function DeltaDiffView({ delta, evidenceBank }: { delta: TailoringDelta; evidenceBank: EvidenceItem[] }) {
  const bulletsByEvidenceId = React.useMemo(() => {
    const map = new Map<string, string[]>();
    for (const section of delta.sections) {
      for (const bullet of section.bullets) {
        const list = map.get(bullet.evidence_id) ?? [];
        list.push(bullet.text);
        map.set(bullet.evidence_id, list);
      }
    }
    return map;
  }, [delta]);

  const included = evidenceBank.filter((item) => bulletsByEvidenceId.has(item.id));
  const omitted = evidenceBank.filter((item) => !bulletsByEvidenceId.has(item.id));

  return (
    <div className="space-y-4 text-sm">
      <div>
        <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1">
          Included — rephrased/reweighted from your evidence bank
        </h4>
        <div className="space-y-2">
          {included.map((item) => (
            <div key={item.id} className="border border-border rounded-md p-2">
              <div className="text-xs text-muted-foreground mb-1">
                {[item.title, item.employer].filter(Boolean).join(" — ") || item.category}
              </div>
              {(bulletsByEvidenceId.get(item.id) ?? []).map((bulletText, i) => (
                <p key={i} className="leading-relaxed">
                  <DiffTokens text={bulletText} source={item.text} />
                </p>
              ))}
            </div>
          ))}
          {included.length === 0 && <p className="text-xs text-muted-foreground">Nothing included yet.</p>}
        </div>
      </div>

      {omitted.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1">
            Not included in this tailored version ({omitted.length})
          </h4>
          <div className="space-y-1">
            {omitted.map((item) => (
              <p key={item.id} className="text-xs text-muted-foreground line-through">
                {[item.title, item.employer].filter(Boolean).join(" — ") || item.text.slice(0, 60)}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
