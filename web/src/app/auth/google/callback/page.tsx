"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

/** Lands here after Google OAuth login (routers/auth.py's
 * google_callback redirects here with ?token=...). Sets the signed-in
 * user directly via AuthProvider's loginWithToken, then navigates
 * client-side — deliberately NOT window.location.assign() to a page
 * that re-checks localStorage on mount (the original approach here).
 * That had a real race: a full-page navigation can start unloading
 * the current document before its own in-flight /auth/me resolves, so
 * the result never lands anywhere — confirmed live, not theoretical.
 * Staying in the same JS context/AuthProvider instance the whole way
 * through has no such race. */
export default function GoogleCallbackPage() {
  const router = useRouter();
  const { loginWithToken } = useAuth();
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (!token) {
      (() => setError(`No token in callback URL. Full URL was: ${window.location.href}`))();
      return;
    }
    (async () => {
      try {
        await loginWithToken(token);
        router.replace("/console");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground font-mono">
        <p>Google sign-in didn&apos;t complete.</p>
        <p className="max-w-md break-all text-xs">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center text-sm text-muted-foreground font-mono">
      signing you in…
    </div>
  );
}
