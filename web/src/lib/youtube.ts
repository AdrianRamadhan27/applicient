/** Accepts a watch/share/shorts/already-embed YouTube URL (whatever an
 * admin actually pastes) and returns a real `/embed/<id>` URL for an
 * iframe, or null if it doesn't look like a YouTube URL at all —
 * never guessed, the caller just keeps showing a placeholder. Shared
 * between the landing page (renders the saved link) and the admin
 * Landing Page settings page (live-previews whatever's currently
 * typed, before Save is even clicked). */
export function youtubeEmbedUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  let id: string | null = null;
  if (url.hostname.includes("youtu.be")) {
    id = url.pathname.slice(1).split("/")[0] || null;
  } else if (url.hostname.includes("youtube.com")) {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else if (url.pathname.startsWith("/embed/")) id = url.pathname.split("/embed/")[1]?.split("/")[0] || null;
    else if (url.pathname.startsWith("/shorts/")) id = url.pathname.split("/shorts/")[1]?.split("/")[0] || null;
  }
  return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
}
