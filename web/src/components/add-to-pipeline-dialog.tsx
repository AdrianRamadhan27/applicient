"use client";

import * as React from "react";
import { toast } from "sonner";
import { api, type Application, type InboxJob } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { AddJobDialog } from "@/components/add-job-dialog";
import { Search } from "lucide-react";

// Adrian, direct: "in application pipeline page... I want to be able
// to add job to pipeline from the application pipeline page similar
// to like adding events in calendar. User may select from list of job
// in job inbox or add/parse manually just like in job inbox page." —
// two tabs, matching that exactly: browse/search the Job Inbox and
// add-to-pipeline in one click, or fall through to the exact same
// manual add-job form Job Inbox itself uses (add-job-dialog.tsx),
// chained straight into an Application afterward. Either path ends at
// the same `POST /applications` call — idempotent server-side
// (routers/applications.py), so re-adding an already-piped job is a
// safe no-op, not a duplicate or an error.
export function AddToPipelineDialog({
  open,
  onOpenChange,
  personaId,
  existingJobIds,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  personaId: string;
  existingJobIds: Set<string>;
  onAdded: (application: Application) => void;
}) {
  const [jobs, setJobs] = React.useState<InboxJob[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [addingId, setAddingId] = React.useState<string | null>(null);
  const [manualOpen, setManualOpen] = React.useState(false);

  const loadJobs = React.useCallback(async () => {
    setLoading(true);
    try {
      setJobs(await api.listInboxJobs(personaId, { search: search || undefined, sort: "recommended", limit: 100 }));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, [personaId, search]);

  React.useEffect(() => {
    (async () => {
      if (!open) return;
      setJobs(null);
      await loadJobs();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, personaId]);

  async function handleAdd(job: InboxJob) {
    setAddingId(job.id);
    try {
      const application = await api.createApplication({ job_id: job.id, persona_id: personaId });
      toast.success(`"${job.title}" added to the pipeline`);
      onAdded(application);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setAddingId(null);
    }
  }

  async function handleManualCreated(job: InboxJob) {
    setManualOpen(false);
    try {
      const application = await api.createApplication({ job_id: job.id, persona_id: personaId });
      toast.success(`"${job.title}" added to the pipeline`);
      onAdded(application);
    } catch (e) {
      toast.error(String(e));
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-full max-w-[min(92vw,36rem)] max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add to pipeline</DialogTitle>
            <DialogDescription>
              Pick an already-discovered job from your Inbox, or add one manually — either way creates a
              tracked application here.
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="inbox">
            <TabsList>
              <TabsTrigger value="inbox">From Job Inbox</TabsTrigger>
              <TabsTrigger value="manual">Add manually</TabsTrigger>
            </TabsList>

            <TabsContent value="inbox" className="flex flex-col gap-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="Search title or company…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && loadJobs()}
                />
              </div>
              <div className="flex flex-col gap-1.5 max-h-96 overflow-y-auto">
                {loading ? (
                  <div className="py-8 text-center text-xs text-muted-foreground font-mono">loading…</div>
                ) : !jobs || jobs.length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted-foreground">
                    No jobs found — try a different search, or add one manually instead.
                  </div>
                ) : (
                  jobs.map((job) => {
                    const already = existingJobIds.has(job.id);
                    return (
                      <div
                        key={job.id}
                        className="flex items-center justify-between gap-3 border border-border px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{job.title}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {job.company_name_raw}
                            {job.location ? ` · ${job.location}` : ""}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant={already ? "outline" : "default"}
                          className="shrink-0"
                          disabled={addingId === job.id}
                          onClick={() => handleAdd(job)}
                        >
                          {addingId === job.id ? "Adding…" : already ? "Already added" : "Add"}
                        </Button>
                      </div>
                    );
                  })
                )}
              </div>
            </TabsContent>

            <TabsContent value="manual" className="flex flex-col items-start gap-3 py-2">
              <p className="text-xs text-muted-foreground">
                Paste a job link or type the fields in by hand — same form as Job Inbox&apos;s own &ldquo;Add a job.&rdquo;
              </p>
              <Button size="sm" onClick={() => setManualOpen(true)}>
                Open manual add form
              </Button>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <AddJobDialog open={manualOpen} onOpenChange={setManualOpen} onCreated={handleManualCreated} />
    </>
  );
}
