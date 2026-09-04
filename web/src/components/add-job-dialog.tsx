"use client";

import * as React from "react";
import { toast } from "sonner";
import { api, type InboxJob, type JobDraft } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Sparkles } from "lucide-react";

// Extracted from inbox/page.tsx (its original, still-only-real-source
// home) so pipeline/page.tsx's own "Add to pipeline" flow can reuse
// the exact same manual-add form instead of a second copy — raised
// directly by Adrian: "add/parse manually just like in job inbox
// page." Both paths — paste a link, or just type the fields — land in
// the same form and the same POST /jobs call; parsing only prefills
// it, never saves anything on its own, so a bad/unrecognized page
// just means an empty form to fill by hand instead of a hard failure.
const EMPTY_JOB_DRAFT: JobDraft = {
  title: "",
  company_name: "",
  location: "",
  remote_policy: "",
  seniority: "",
  employment_type: "",
  salary_min: null,
  salary_max: null,
  salary_currency: "",
  requirements: "",
  responsibilities: "",
  benefits: "",
  apply_url: "",
  source_url: "",
};

export function AddJobDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (job: InboxJob) => void;
}) {
  const [urlInput, setUrlInput] = React.useState("");
  const [parsing, setParsing] = React.useState(false);
  const [draft, setDraft] = React.useState<JobDraft>(EMPTY_JOB_DRAFT);
  const [saving, setSaving] = React.useState(false);

  function field<K extends keyof JobDraft>(key: K, value: JobDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function handleParse() {
    const url = urlInput.trim();
    if (!url) return;
    setParsing(true);
    try {
      const parsed = await api.parseJobUrl(url);
      if (!parsed.found) {
        toast.error("That didn't look like a job posting — fill in the fields below by hand instead");
      } else {
        toast.success("Parsed — review the fields below before saving");
      }
      setDraft((prev) => ({
        ...prev,
        title: parsed.title ?? prev.title,
        company_name: parsed.company_name ?? prev.company_name,
        location: parsed.location ?? prev.location,
        remote_policy: parsed.remote_policy ?? prev.remote_policy,
        seniority: parsed.seniority ?? prev.seniority,
        employment_type: parsed.employment_type ?? prev.employment_type,
        salary_min: parsed.salary_min ?? prev.salary_min,
        salary_max: parsed.salary_max ?? prev.salary_max,
        salary_currency: parsed.salary_currency ?? prev.salary_currency,
        requirements: parsed.requirements ?? prev.requirements,
        responsibilities: parsed.responsibilities ?? prev.responsibilities,
        benefits: parsed.benefits ?? prev.benefits,
        apply_url: parsed.apply_url ?? prev.apply_url,
        source_url: url,
      }));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setParsing(false);
    }
  }

  async function handleSave() {
    const title = draft.title.trim();
    const company = draft.company_name.trim();
    if (!title || !company) {
      toast.error("Title and company are required");
      return;
    }
    setSaving(true);
    try {
      const created = await api.createJob({
        title,
        company_name: company,
        location: draft.location?.trim() || null,
        remote_policy: draft.remote_policy?.trim() || null,
        seniority: draft.seniority?.trim() || null,
        employment_type: draft.employment_type?.trim() || null,
        salary_min: draft.salary_min ?? null,
        salary_max: draft.salary_max ?? null,
        salary_currency: draft.salary_currency?.trim() || null,
        requirements: draft.requirements?.trim() || null,
        responsibilities: draft.responsibilities?.trim() || null,
        benefits: draft.benefits?.trim() || null,
        apply_url: draft.apply_url?.trim() || null,
        source_url: draft.source_url?.trim() || null,
      });
      toast.success(`"${created.title}" saved`);
      onCreated(created);
      setUrlInput("");
      setDraft(EMPTY_JOB_DRAFT);
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setUrlInput("");
          setDraft(EMPTY_JOB_DRAFT);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="w-full max-w-[min(92vw,42rem)] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a job</DialogTitle>
          <DialogDescription>
            Paste a job posting link to auto-fill the fields below, or just type them in — either way ends up
            in the same place.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="job-url">Job posting URL (optional)</Label>
            <div className="flex gap-2">
              <Input
                id="job-url"
                placeholder="https://www.linkedin.com/jobs/view/…"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleParse()}
              />
              <Button
                type="button"
                variant="outline"
                disabled={parsing || !urlInput.trim()}
                onClick={handleParse}
                className="gap-1.5 shrink-0"
              >
                <Sparkles className="size-3.5" />
                {parsing ? "Parsing…" : "Parse"}
              </Button>
            </div>
            <span className="text-xs text-muted-foreground">
              Works with any site — LinkedIn, Indeed, a company career page. An LLM reads the real page and
              fills in what it finds below; nothing is saved until you hit Save.
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="job-title">Title *</Label>
              <Input id="job-title" value={draft.title} onChange={(e) => field("title", e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-company">Company *</Label>
              <Input id="job-company" value={draft.company_name} onChange={(e) => field("company_name", e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-location">Location</Label>
              <Input id="job-location" value={draft.location ?? ""} onChange={(e) => field("location", e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-remote">Remote policy</Label>
              <Input
                id="job-remote"
                placeholder="remote / hybrid / onsite"
                value={draft.remote_policy ?? ""}
                onChange={(e) => field("remote_policy", e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-seniority">Seniority</Label>
              <Input id="job-seniority" value={draft.seniority ?? ""} onChange={(e) => field("seniority", e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-type">Employment type</Label>
              <Input
                id="job-type"
                placeholder="full_time / contract / …"
                value={draft.employment_type ?? ""}
                onChange={(e) => field("employment_type", e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-salary-min">Salary min</Label>
              <Input
                id="job-salary-min"
                type="number"
                value={draft.salary_min ?? ""}
                onChange={(e) => field("salary_min", e.target.value ? Number(e.target.value) : null)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-salary-max">Salary max</Label>
              <Input
                id="job-salary-max"
                type="number"
                value={draft.salary_max ?? ""}
                onChange={(e) => field("salary_max", e.target.value ? Number(e.target.value) : null)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-currency">Currency</Label>
              <Input
                id="job-currency"
                placeholder="USD"
                value={draft.salary_currency ?? ""}
                onChange={(e) => field("salary_currency", e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-apply-url">Apply URL</Label>
              <Input id="job-apply-url" value={draft.apply_url ?? ""} onChange={(e) => field("apply_url", e.target.value)} />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="job-requirements">Requirements</Label>
            <Textarea
              id="job-requirements"
              rows={3}
              value={draft.requirements ?? ""}
              onChange={(e) => field("requirements", e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="job-responsibilities">Responsibilities</Label>
            <Textarea
              id="job-responsibilities"
              rows={3}
              value={draft.responsibilities ?? ""}
              onChange={(e) => field("responsibilities", e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="job-benefits">Benefits</Label>
            <Textarea id="job-benefits" rows={2} value={draft.benefits ?? ""} onChange={(e) => field("benefits", e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSave} disabled={saving || !draft.title.trim() || !draft.company_name.trim()}>
            {saving ? "Saving…" : "Save job"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
