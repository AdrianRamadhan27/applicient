"use client";

import * as React from "react";
import { toast } from "sonner";
import { api, type SiteContent } from "@/lib/api";
import { youtubeEmbedUrl } from "@/lib/youtube";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Adrian, direct: "a whole CMS where i can control what shows up in the
// landing page... changing like images and whatnot shouldnt be through
// commits" — originally scoped to media (the demo video link + a
// screenshot slot per landing-page section); headlines/feature text/FAQ
// stay in code either way.
//
// The screenshot-slot half of this page was removed once every landing
// section it covered (hero, job search, CV verifier, auto-apply, pipeline
// tracking, interview practice) became an interactive mock instead of a
// screenshot — uploading a replacement image would no longer render
// anywhere. SITE_MEDIA_SLOTS in routers/site_content.py is now empty for
// the same reason; only the demo-video field below still does anything.

export default function AdminSiteContentPage() {
  const [, setContent] = React.useState<SiteContent | null>(null);
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
        {loading ? (
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
          </div>
        )}
      </div>
    </div>
  );
}
