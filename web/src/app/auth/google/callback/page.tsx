"use client";

import * as React from "react";
import { AUTH_TOKEN_STORAGE_KEY } from "@/lib/api";

/** Lands here after Google OAuth login (routers/auth.py's
 * google_callback redirects here with ?token=...). Stores the token
 * and does a full page navigation rather than a client-side route
 * change — AuthProvider only resolves the signed-in user once, on
 * mount, so a fresh page load is what makes it pick up the token that
 * was just set. */
export default function GoogleCallbackPage() {
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (token) {
      window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
      // Not router.push() — needs a full reload so AuthProvider's
      // mount-only effect re-reads the token that was just set.
      window.location.assign("/assistant");
    } else {
      window.location.assign("/login");
    }
  }, []);

  return (
    <div className="flex h-screen items-center justify-center text-sm text-muted-foreground font-mono">
      signing you in…
    </div>
  );
}
