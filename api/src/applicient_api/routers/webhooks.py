"""M5 F8.1 — the Pub/Sub push side of Gmail ingestion. No
current_user_id dependency: Google calls this directly, with no user
session — real verification instead comes from the push subscription's
own OIDC bearer token, not from trusting the payload.

Inert without GMAIL_PUBSUB_TOPIC/a real Pub/Sub push subscription
pointed at a public HTTPS URL — never reachable against localhost.
Polling (scheduler.py) is what actually exercises ingestion in local
dev; this exists so push becomes a free upgrade once deployed
somewhere public, per F8.1's "two adapters, one interface."
"""

import base64
import json
import os

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Request
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

from applicient_api import email_ingestion
from applicient_api.deps import get_session_factory

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


def _verify_pubsub_token(authorization: str | None) -> None:
    audience = os.environ.get("GMAIL_PUSH_ENDPOINT_URL")
    if not authorization or not authorization.startswith("Bearer ") or not audience:
        raise HTTPException(403, "missing or unconfigured Pub/Sub push verification")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        id_token.verify_oauth2_token(token, google_requests.Request(), audience=audience)
    except ValueError:
        raise HTTPException(403, "invalid Pub/Sub push token")


@router.post("/gmail", status_code=200)
async def gmail_push(request: Request, background_tasks: BackgroundTasks, authorization: str | None = Header(default=None)):
    _verify_pubsub_token(authorization)
    body = await request.json()
    data_b64 = body.get("message", {}).get("data")
    if not data_b64:
        return {"ok": True}  # nothing to do — don't make Pub/Sub retry a malformed envelope

    payload = json.loads(base64.b64decode(data_b64))
    google_email = payload.get("emailAddress")
    if not google_email:
        return {"ok": True}

    # Must return fast — Pub/Sub retries on a non-2xx or slow response,
    # and a large backlog sync could exceed its ack deadline.
    background_tasks.add_task(email_ingestion.GmailIngestor.handle_push, get_session_factory(), google_email=google_email)
    return {"ok": True}
