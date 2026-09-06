"use client";

import * as React from "react";
import { toast } from "sonner";
import { api, API_BASE_URL, type SiteContent } from "@/lib/api";
import { youtubeEmbedUrl } from "@/lib/youtube";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Adrian, direct: "a whole CMS where i can control what shows up in
// the landing page... changing like images and whatnot shouldnt be
// through commits" — scoped to media (the demo video link + each
// screenshot slot); confirmed directly, headlines/feature text/FAQ
// stay in code. Every slot here has to match SITE_MEDIA_SLOTS in
// routers/site_content.py exactly — it's a fixed, code-defined
// vocabulary, not admin-extensible (adding a slot means adding
// somewhere on the actual page to put it).
const SLOTS: { slot: string; label: string; defaultSrc: string }[] = [
  { slot: "hero", label: "Hero (top of page)", defaultSrc: "/screenshots/dashboard.png" },
  { slot: "job-search", label: "AI job search", defaultSrc: "/screenshots/job-search.png" },
  { slot: "cv-compose", label: "Zero-fabrication CV tailoring", defaultSrc: "/screenshots/cv-compose.png" },
  { slot: "pipeline", label: "AI auto-apply", defaultSrc: "/screenshots/pipeline.png" },
  { slot: "track-status", label: "Pipeline auto-updates from email", defaultSrc: "/screenshots/track-status.png" },
  { slot: "interview", label: "AI interview practice", defaultSrc: "/screenshots/interview.png" },
];

function SlotCard({
  slot,
  label,
  defaultSrc,
  overrideUrl,
  onChanged,
}: {
  slot: string;
  label: string;
  defaultSrc: string;
  overrideUrl: string | null;
  onChanged: (content: SiteContent) => void;
}) {
  const [uploading, setUploading] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // Cache-busts the <img> after a replace/reset — the URL itself never
  // changes (always /site-content/media/{slot}/image), so the browser
  // would otherwise keep showing the old bytes it already cached.
  const [bust, setBust] = React.useState(0);

  const src = overrideUrl ? `${API_BASE_URL}${overrideUrl}?v=${bust}` : defaultSrc;

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const content = await api.uploadSiteMedia(slot, file);
      onChanged(content);
      setBust((b) => b + 1);
      toast.success(`${label} updated`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleReset() {
    if (!window.confirm(`Revert "${label}" to the bundled default screenshot?`)) return;
    setResetting(true);
    try {
      const content = await api.resetSiteMedia(slot);
      onChanged(content);
      setBust((b) => b + 1);
      toast.success(`${label} reverted to default`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reset");
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        {overrideUrl ? (
          <span className="font-mono text-[9px] uppercase tracking-wider text-primary">custom</span>
        ) : (
          <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">default</span>
        )}
      </div>
      <div className="overflow-hidden border border-border bg-secondary/40">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={label} className="block h-auto w-full" />
      </div>
      <div className="flex gap-2">
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
        <Button size="sm" variant="outline" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
          {uploading ? "Uploading…" : "Replace image"}
        </Button>
        {overrideUrl && (
          <Button size="sm" variant="ghost" disabled={resetting} onClick={handleReset}>
            {resetting ? "Resetting…" : "Reset to default"}
          </Button>
        )}
      </div>
    </div>
  );
}

export default function AdminSiteContentPage() {
  const [content, setContent] = React.useState<SiteContent | null>(null);
  const [videoUrl, setVideoUrl] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [savingVideo, setSavingVideo] = React.useState(false);
  // Live, off whatever's currently typed — not the saved value — so
  // the admin sees it's a real, working link before ever hitting Save.
  const previewUrl = videoUrl.trim() ? youtubeEmbedUrl(videoUrl.trim()) : null;

  const load = React.useCallback(async () => {
    try {
      const c = await api.getAdminSiteContent();
      setContent(c);
      setVideoUrl(c.demo_video_url ?? "");
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

  async function handleSaveVideo(e: React.FormEvent) {
    e.preventDefault();
    setSavingVideo(true);
    try {
      const updated = await api.updateSiteVideo(videoUrl.trim() || null);
      setContent(updated);
      toast.success("Demo video link saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingVideo(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center gap-3 px-5">
        <span className="text-sm font-semibold">Landing Page</span>
      </header>

      <div className="flex-1 overflow-auto p-5">
        {loading || !content ? (
          <div className="text-sm text-muted-foreground font-mono">loading…</div>
        ) : (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
            <div className="border border-border bg-card p-4 flex flex-col gap-3">
              <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                Demo video
              </span>
              <p className="text-xs text-muted-foreground">
                A YouTube link — the landing page embeds it in place of the &quot;Demo video coming soon&quot;
                placeholder. Leave blank to show the placeholder again.
              </p>
              <form onSubmit={handleSaveVideo} className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:gap-2">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="video-url">YouTube URL</Label>
                  <Input
                    id="video-url"
                    placeholder="https://www.youtube.com/watch?v=…"
                    value={videoUrl}
                    onChange={(e) => setVideoUrl(e.target.value)}
                  />
                </div>
                <Button type="submit" size="sm" disabled={savingVideo}>
                  {savingVideo ? "Saving…" : "Save"}
                </Button>
              </form>
              {videoUrl.trim() &&
                (previewUrl ? (
                  <div className="aspect-video w-full max-w-md overflow-hidden border border-border bg-black">
                    <iframe
                      src={previewUrl}
                      title="Demo video preview"
                      className="h-full w-full"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                    />
                  </div>
                ) : (
                  <span className="text-xs text-crit">
                    Doesn&apos;t look like a YouTube link yet — paste a watch/share/embed URL to preview it.
                  </span>
                ))}
            </div>

            <div className="flex flex-col gap-3">
              <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">
                Screenshots
              </span>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {SLOTS.map((s) => (
                  <SlotCard
                    key={s.slot}
                    slot={s.slot}
                    label={s.label}
                    defaultSrc={s.defaultSrc}
                    overrideUrl={content.media[s.slot] ?? null}
                    onChanged={setContent}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
