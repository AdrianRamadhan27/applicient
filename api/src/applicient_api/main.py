"""FastAPI app entry point.

uv run uvicorn applicient_api.main:app --reload
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from applicient_api.routers import (
    company_candidates,
    cost,
    cv,
    evidence,
    health,
    jobs,
    model_profiles,
    personas,
    preferences,
    profiles,
    providers,
    radar,
    saved_searches,
    sources,
    streaming,
)

app = FastAPI(title="Applicient API", version="0.1.0")

# Local-first dev: the Next.js dev server runs on a different port, so
# this needs CORS. Tightens to the real deployed origin once there is
# one (PRD §2.2 — no auth in v1, so this is the only access boundary
# for now, and it is intentionally permissive for local dev only).
app.add_middleware(
    CORSMiddleware,
    # 3001 is what this repo's web/package.json pins `next dev` to
    # (port 3000 was already taken by something else on the dev
    # machine this was built on); 3000 stays allowed too since that's
    # Next.js's real default and other clones may not hit the
    # collision.
    allow_origins=["http://localhost:3000", "http://localhost:3001"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(profiles.router)
app.include_router(evidence.router)
app.include_router(cv.router)
app.include_router(providers.router)
app.include_router(model_profiles.router)
app.include_router(cost.router)
app.include_router(streaming.router)
app.include_router(personas.router)
app.include_router(preferences.router)
app.include_router(company_candidates.router)
app.include_router(company_candidates.candidate_router)
app.include_router(sources.router)
app.include_router(saved_searches.router)
app.include_router(radar.router)
app.include_router(jobs.router)
