"use client";

import * as React from "react";
import { api, AUTH_TOKEN_STORAGE_KEY, getAuthToken, type User } from "@/lib/api";

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = React.createContext<AuthContextValue | null>(null);

/** M5 — real signed-in identity, same shape as PersonaProvider
 * (persisted token, one mount-time resolve). Sits outside
 * PersonaProvider in layout.tsx since persona loading now depends on
 * being authenticated. */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<User | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!getAuthToken()) {
        setLoading(false);
        return;
      }
      try {
        const me = await api.me();
        if (!cancelled) setUser(me);
      } catch {
        // stale/expired token — drop it, land the user back on /login
        if (typeof window !== "undefined") window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function login(email: string, password: string) {
    const { access_token, user: loggedInUser } = await api.login(email, password);
    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, access_token);
    setUser(loggedInUser);
  }

  async function signup(email: string, password: string) {
    const { access_token, user: newUser } = await api.signup(email, password);
    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, access_token);
    setUser(newUser);
  }

  function logout() {
    window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
