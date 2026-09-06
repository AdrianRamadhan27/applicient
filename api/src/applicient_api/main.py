"""FastAPI app entry point.

uv run uvicorn applicient_api.main:app --reload
"""

import os
from contextlib import asynccontextmanager

from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from applicient_agents.application_service import reconcile_stale_attempts
from applicient_agents.orchestrator_service import close_checkpointer, init_checkpointer

from applicient_api.deps import get_session_factory
from applicient_api.logging_config import configure_logging
from applicient_api.scheduler import start_scheduler, stop_scheduler
from applicient_api.routers import (
    admin,
    applications,
    auth,
    billing,
    calendar_events,
    company_candidates,
    cost,
    credentials,
    cv,
    dashboard,
    email_messages,
    evidence,
    gmail,
    health,
    interview_sessions,
    job_groups,
    jobs,
    model_profiles,
    notifications,
    orchestrator,
    personas,
    pipeline_stages,
    preferences,
    profiles,
    providers,
    radar,
    saved_searches,
    site_content,
    sources,
    streaming,
    webhooks,
)

def _require_secret_key() -> None:
    """SaaS pivot — docker-compose.yml no longer ships a default
    fallback SECRET_KEY (a real, known-to-anyone-who-reads-the-repo
    value that used to encrypt every tenant's provider keys/Gmail
    tokens by default). security.py's own Fernet call already raises
    if this is unset, but only lazily, the first time some request
    happens to touch an encrypted field — for a multi-tenant deployment
    that's "boots fine, breaks mysteriously three weeks later," not a
    real fail-fast. This makes the same failure happen at startup,
    before the process ever accepts a request."""

    key = os.environ.get("SECRET_KEY")
    if not key:
        raise RuntimeError(
            "SECRET_KEY is not set — generate one with: "
            "python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
        )
    try:
        Fernet(key.encode())
    except (ValueError, TypeError) as exc:
        raise RuntimeError(f"SECRET_KEY is set but not a valid Fernet key: {exc}") from exc


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    _require_secret_key()
    # See reconcile_stale_attempts's own docstring — _ACTIVE_ATTEMPTS is
    # in-memory only, so any application-agent attempt that looked
    # "in progress"/"awaiting_*" when this process last stopped can
    # never actually resume; this closes those out instead of leaving
    # them stuck.
    reconcile_stale_attempts(get_session_factory())
    # M7 — a real, persistent LangGraph checkpointer (unlike
    # application_service.py's per-attempt InMemorySaver): a
    # conversation is meant to span days, so it needs to survive an API
    # restart. Opened once here, closed on shutdown.
    await init_checkpointer()
    # M5 — the in-process scheduler (saved-search cron dispatch, Gmail
    # polling, watch renewal). Started after the checkpointer, stopped
    # before it, same ordering discipline as everything else in this
    # lifespan.
    await start_scheduler(get_session_factory())
    try:
        yield
    finally:
        stop_scheduler()
        await close_checkpointer()


app = FastAPI(title="Applicient API", version="0.1.0", lifespan=lifespan)

# Local-first dev: the Next.js dev server runs on a different port, so
# this needs CORS. Deployed origins come from CORS_ORIGINS (comma-
# separated, e.g. "https://applicient.web.id,https://www.applicient.web.id")
# rather than being hardcoded here — see DEPLOYMENT.md.
_cors_origins = [
    # 3001 is what this repo's web/package.json pins `next dev` to
    # (port 3000 was already taken by something else on the dev
    # machine this was built on); 3000 stays allowed too since that's
    # Next.js's real default and other clones may not hit the
    # collision.
    "http://localhost:3000",
    "http://localhost:3001",
    *(origin.strip() for origin in os.environ.get("CORS_ORIGINS", "").split(",") if origin.strip()),
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
    # Content-Disposition isn't on the CORS-safelisted response-header
    # list, so a cross-origin fetch() can't read it unless explicitly
    # exposed — needed by get_application_document's real filename
    # (a raw-CV fallback isn't always a .pdf). X-Interview-Session-Id
    # is the same story for create_interview_session's response (Phase
    # 11, v2 plan) — the frontend needs the new session's id before
    # it's ever mentioned in an SSE event.
    expose_headers=["Content-Disposition", "X-Interview-Session-Id"],
)

app.include_router(health.router)
app.include_router(auth.router)
app.include_router(profiles.router)
app.include_router(evidence.router)
app.include_router(cv.router)
app.include_router(providers.router)
app.include_router(providers.audio_settings_router)
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
app.include_router(job_groups.router)
app.include_router(job_groups.persona_router)
app.include_router(job_groups.documents_router)
app.include_router(job_groups.base_cv_router)
app.include_router(applications.router)
app.include_router(pipeline_stages.router)
app.include_router(credentials.router)
app.include_router(gmail.router)
app.include_router(email_messages.router)
app.include_router(notifications.router)
app.include_router(webhooks.router)
app.include_router(orchestrator.router)
app.include_router(interview_sessions.router)
app.include_router(admin.router)
app.include_router(billing.router)
app.include_router(calendar_events.router)
app.include_router(dashboard.router)
app.include_router(site_content.router)
app.include_router(site_content.admin_router)
