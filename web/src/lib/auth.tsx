"use client";

import * as React from "react";
import { ApiError, api, AUTH_TOKEN_STORAGE_KEY, getAuthToken, type User } from "@/lib/api";

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  // True when the mount-time /auth/me check couldn't get a real answer
  // from the server (not "you're logged out" — "we don't know yet").
  // app-shell.tsx uses this to show a retry state instead of bouncing
  // to /login, and retryAuth lets it (or anything else) ask for another
  // attempt without a full page reload.
  connectionError: boolean;
  retryAuth: () => void;
  login: (email: string, password: string) => Promise<void>;
  // Resolves to the email address, not void — signup no longer signs
  // the caller in (see api.signup's own comment), so the signup page
  // needs the email back to route to the "check your inbox" page.
  signup: (email: string, password: string) => Promise<string>;
  loginWithToken: (token: string) => Promise<void>;
  logout: () => void;
  // Re-fetches /auth/me and updates `user` in place — for anything
  // that changes account state the frontend caches here without a
  // fresh login (e.g. console/settings/page.tsx after setting a
  // password on a Google-only account flips has_password false->true).
  refreshUser: () => Promise<void>;
};

const AuthContext = React.createContext<AuthContextValue | null>(null);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** M5 — real signed-in identity, same shape as PersonaProvider
 * (persisted token, one mount-time resolve). Sits outside
 * PersonaProvider in layout.tsx since persona loading now depends on
 * being authenticated. */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<User | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [connectionError, setConnectionError] = React.useState(false);
  const [retryTick, setRetryTick] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setConnectionError(false);
      if (!getAuthToken()) {
        setLoading(false);
        return;
      }
      // A 401 here means the token itself is genuinely bad — that's
      // the only case that should ever clear it and send someone back
      // to /login. Anything else (a 500, a network error, the API
      // being unreachable for a moment mid-restart) says nothing about
      // whether the token is still good, and treating it as "logged
      // out" was the actual bug: refreshing mid an interview-practice
      // session — one single long-lived page — was enough to
      // occasionally catch the API in exactly that kind of momentary
      // gap and silently wipe a perfectly valid session. Retry a few
      // times first (a real restart is usually over in a couple of
      // seconds); only surface connectionError if it's still failing
      // after that, and even then, never touch the stored token.
      const attempts = 3;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const me = await api.me();
          if (!cancelled) {
            setUser(me);
            setConnectionError(false);
          }
          break;
        } catch (e) {
          if (cancelled) break;
          if (e instanceof ApiError && e.status === 401) {
            if (typeof window !== "undefined") window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
            break;
          }
          if (attempt === attempts) {
            setConnectionError(true);
          } else {
            await sleep(800 * attempt);
          }
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [retryTick]);

  function retryAuth() {
    setRetryTick((t) => t + 1);
  }

  async function login(email: string, password: string) {
    const { access_token, user: loggedInUser } = await api.login(email, password);
    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, access_token);
    setUser(loggedInUser);
  }

  async function signup(email: string, password: string) {
    const { email: signedUpEmail } = await api.signup(email, password);
    return signedUpEmail;
  }

  // v2 Phase 1 (Google OAuth) — the callback page already has a real
  // token (issued by /auth/google/callback), it just needs this
  // context's `user` set from it. Deliberately NOT a full page reload
  // to a page that re-checks localStorage on mount (what the callback
  // page used to do): that had a real race — window.location.assign()
  // can start unloading the current page before its own in-flight
  // /auth/me resolves, so the result never lands anywhere. Setting
  // `user` directly here, in the same JS context, has no such race.
  async function loginWithToken(token: string) {
    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    const me = await api.me();
    setUser(me);
  }

  function logout() {
    window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    setUser(null);
  }

  async function refreshUser() {
    const me = await api.me();
    setUser(me);
  }

  return (
    <AuthContext.Provider
      value={{ user, loading, connectionError, retryAuth, login, signup, loginWithToken, logout, refreshUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
