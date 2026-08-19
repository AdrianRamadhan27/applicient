# Applicient — Implementation Checklist

Working checklist for M0. Check items off as they're done; update the **Status** line at each step when something changes. See [PRD.md](PRD.md) for the requirements and decisions this is built from.

**Status:** Not started — repo is a clean slate (PRD + design canvas only, no commits yet).

---

## 0. Repo bootstrap

- [ ] Initialize the monorepo layout from PRD §8.1: `web/`, `api/`, `agents/`, `sources/`, `worker/`, `browser-worker/`, `scheduler/`, `renderers/`, `models/`, `metering/`
- [ ] `.gitignore`, `.env.example` (never a real `.env`), `README.md` stub, `LICENSE` (MIT)
- [ ] Pin toolchains: Python 3.12 + `uv`, Node 20+ + `pnpm`
- [ ] First commit: empty scaffold + PRD + design canvas

## 1. Infra

- [ ] `docker-compose.yml`: Postgres (pgvector extension), Redis, MinIO, placeholders for `api`, `worker`, `browser-worker`, `web`
- [ ] Confirm the Postgres image ships pgvector ≥0.7 (needed for `halfvec`) — pin the image tag explicitly, don't use `latest`
- [ ] Checkpoint: `docker compose up` gives a running DB + Redis with nothing else built yet

## 2. Database schema

- [ ] Alembic migrations, first migration = every entity from PRD §9, every table carrying `user_id`
- [ ] `EmbeddingIndex` as `halfvec(2048)`, **not** `vector(2048)` — pgvector's HNSW caps `vector` at 2000 dims, this only fails at index creation if you get it wrong. Verify the HNSW index actually builds, don't just trust the migration running clean
- [ ] Seed data: one demo user, empty profile shell

## 3. Models & cost ledger — build before any agent code

- [ ] `models/`: `ProviderConnection`, `ModelCatalogEntry`, `ModelProfile` tables + Pydantic schemas
- [ ] OpenRouter adapter first (default preset + embedding provider) — `list_models()`, live pricing ingest, `/embeddings`
- [ ] Anthropic adapter second (quality reference preset)
- [ ] `metering/`: LangChain callback handler writing `LlmCall` on every call, wired in before the first agent exists — nothing may bypass it
- [ ] Test-connection flow end to end: paste a real OpenRouter key, verify, catalog populates
- [ ] **M0 exit bar:** paste an API key in the GUI, see what a call cost. Don't move to step 4 until this works.

## 4. Backend skeleton

- [ ] FastAPI app: health check, REST CRUD stubs for Profile/EvidenceItem, SSE endpoint stub for run streaming
- [ ] `agents/`: install `deepagents`, get the simplest possible `create_deep_agent` call working standalone (no subagents yet)
- [ ] Confirm tier-based model routing: a stage asks for `fast`/`balanced`/`deep`, resolution walks `ModelProfile` → `ModelCatalogEntry`, never touches a hardcoded model string

## 5. Frontend skeleton

- [ ] Next.js App Router + Tailwind + shadcn/ui init
- [ ] Port `design/Tokens.dc.html` into `app/globals.css` — Terminal Ledger palette, IBM Plex Sans/Mono, zero-radius, no-shadow rule, both theme blocks (light `:root`, dark under `prefers-color-scheme` + `[data-theme]`)
- [ ] Nav shell from the mockups (rail + header), routed but empty pages for the five surfaces
- [ ] Models & Providers page wired to the real API from step 3 — first fully real screen

## 6. CV ingest → evidence bank

- [ ] PDF/DOCX parse → structured `Profile` JSON (`deep`-tier agent call)
- [ ] Decompose into `EvidenceItem` rows, embed each via the `embedding` tier
- [ ] Profile Studio confirm/edit UI

## 7. Close the M0 loop

- [ ] Upload a CV → parsed profile → confirmed → evidence bank populated with embeddings → cost of that flow visible in a minimal Cost & Usage view
- [ ] **M0 done** when this is true. M1 (first discovery adapter, dedup, scoring) starts next.

---

## Log

Short entries only — what changed, what's next, anything worth remembering. Newest first.

- **2026-08-19** — Checklist created. Nothing implemented yet.
