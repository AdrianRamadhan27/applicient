"use client";

import * as React from "react";
import { api, getAuthToken, type Persona } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const STORAGE_KEY = "applicient.selectedPersonaId";

type PersonaContextValue = {
  personas: Persona[];
  loading: boolean;
  selectedPersonaId: string;
  selectedPersona: Persona | null;
  setSelectedPersonaId: (id: string) => void;
  refreshPersonas: () => Promise<void>;
};

const PersonaContext = React.createContext<PersonaContextValue | null>(null);

/** App-wide "which persona am I working with" — the first shared
 * state this app has (confirmed: everything else is page-local
 * `useState`). Every persona now owns its own Profile/evidence bank
 * exclusively, so which persona is selected actually changes what the
 * Dashboard's Preferences/Profile/Experience tabs show, not just a
 * saved-search default. Persisted to
 * localStorage (first use of it in this app) so a reload doesn't
 * silently reset back to whichever persona happens to sort first. */
export function PersonaProvider({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [personas, setPersonas] = React.useState<Persona[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [selectedPersonaId, setSelectedPersonaIdState] = React.useState("");

  const refreshPersonas = React.useCallback(async () => {
    if (!getAuthToken()) return;
    const list = await api.listPersonas();
    setPersonas(list);
    setSelectedPersonaIdState((current) => {
      if (current && list.some((p) => p.id === current)) return current;
      const stored = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
      if (stored && list.some((p) => p.id === stored)) return stored;
      return list.find((p) => p.active)?.id ?? list[0]?.id ?? "";
    });
  }, []);

  // Persona loading depends on being authenticated — waits for
  // AuthProvider to resolve, then only fetches (or clears, on logout)
  // once there's an actual signed-in user.
  React.useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    (async () => {
      if (!user) {
        setPersonas([]);
        setSelectedPersonaIdState("");
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        await refreshPersonas();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, user, refreshPersonas]);

  function setSelectedPersonaId(id: string) {
    setSelectedPersonaIdState(id);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, id);
  }

  const selectedPersona = personas.find((p) => p.id === selectedPersonaId) ?? null;

  return (
    <PersonaContext.Provider
      value={{ personas, loading, selectedPersonaId, selectedPersona, setSelectedPersonaId, refreshPersonas }}
    >
      {children}
    </PersonaContext.Provider>
  );
}

export function usePersona(): PersonaContextValue {
  const ctx = React.useContext(PersonaContext);
  if (!ctx) throw new Error("usePersona must be used within a PersonaProvider");
  return ctx;
}
