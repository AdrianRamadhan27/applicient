// A client-side, few-minutes-TTL cache for the rendered Base CV PDF —
// Adrian, direct: "each time i refresh or access pages with cv it has
// to wait for the loading/rendering... I want a cache on the client
// with like a few minutes ttl so it doesnt render each time." A Base
// CV render is a real Tectonic compile (latex_rendering.py), not free,
// and api.renderBaseCv's own docstring already says it "always
// recompiles fresh, nothing persisted server-side" — so the only place
// left to cache it is here, client-side. One shared module-level Map
// (not per-component state) so Dashboard's own preview card and
// Composer's BaseCvPanel — both call api.renderBaseCv for the exact
// same persona+template — hit the same cache instead of each
// recompiling it independently the first time either is visited.
//
// Invalidated (api.ts calls invalidateBaseCvCache()) wherever the
// evidence bank could plausibly have just changed — a fresh CV parse,
// a manual evidence add/edit/delete, a "fix my CV" run — rather than
// trying to scope it to one persona: none of those call sites reliably
// have a personaId in hand (evidence/profile mutations are keyed by
// profileId), so clearing everything is simpler and safer than a
// profileId->personaId lookup that could get the key wrong and leave
// a real stale render behind.

const TTL_MS = 5 * 60 * 1000;

type CacheEntry = { blob: Blob; expiresAt: number };
const cache = new Map<string, CacheEntry>();

function cacheKey(personaId: string, templateId: string): string {
  return `${personaId}:${templateId}`;
}

export function getCachedBaseCvBlob(personaId: string, templateId: string): Blob | null {
  const key = cacheKey(personaId, templateId);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.blob;
}

export function setCachedBaseCvBlob(personaId: string, templateId: string, blob: Blob): void {
  cache.set(cacheKey(personaId, templateId), { blob, expiresAt: Date.now() + TTL_MS });
}

export function invalidateBaseCvCache(): void {
  cache.clear();
}
