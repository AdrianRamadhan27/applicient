"""M1 §3 — the radar-run trigger. SSE, mirroring routers/cv.py's shape
exactly: precondition/ownership checks happen here, synchronously,
before the stream starts (so a bad ID or an unmet precondition gets a
real HTTP status, not a 200 with an error event); the actual fan-out
lives in radar.py's generator."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from applicient_api.deps import current_user_id, get_db, get_session_factory
from applicient_api.models.discovery import SavedSearch
from applicient_api.models.profile import Persona, Profile
from applicient_api.billing_service import enforce_usage_cap
from applicient_api.radar import run_radar_search
from applicient_api.rate_limit import rate_limit

router = APIRouter(prefix="/saved-searches", tags=["radar"])


@router.post(
    "/{saved_search_id}/run",
    dependencies=[Depends(rate_limit("radar-run", limit=5, window_seconds=60)), Depends(enforce_usage_cap)],
)
def run_saved_search(
    saved_search_id: uuid.UUID, db: Session = Depends(get_db), user_id: uuid.UUID = Depends(current_user_id)
):
    saved_search = db.query(SavedSearch).filter_by(id=saved_search_id, user_id=user_id).one_or_none()
    if saved_search is None:
        raise HTTPException(404, "saved search not found")
    if not saved_search.active:
        raise HTTPException(409, "saved search is not active")
    if not saved_search.source_ids:
        raise HTTPException(409, "saved search has no sources selected")

    persona = db.get(Persona, saved_search.persona_id)
    if persona is None or not persona.active:
        raise HTTPException(409, "saved search's persona is missing or inactive")

    # Every persona owns its own Profile exclusively — check that
    # persona's specific profile, not "the" user's (there can be
    # several, one per persona).
    profile = db.get(Profile, persona.profile_id)
    if profile is None or not profile.confirmed:
        raise HTTPException(409, "profile must be confirmed before running a search")

    return EventSourceResponse(run_radar_search(saved_search_id, user_id, get_session_factory()))
