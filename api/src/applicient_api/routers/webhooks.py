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
import hmac
import json
import logging
import os

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Request
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

from applicient_api import billing_service, email_ingestion
from applicient_api.deps import get_session_factory

router = APIRouter(prefix="/webhooks", tags=["webhooks"])
logger = logging.getLogger(__name__)


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


@router.post("/xendit", status_code=200)
async def xendit_webhook(request: Request, x_callback_token: str | None = Header(default=None)):
    """A best-effort nudge, not the source of truth — see
    billing_service.py's own module docstring. Xendit's exact payload
    shape for `payment_session.completed` couldn't be fully confirmed
    from their docs during this build, so this handler doesn't trust
    any field beyond `reference_id` (used only to look up which of our
    own `Subscription` rows to re-sync); everything else is re-derived
    from a direct, confirmed-shape GET against Xendit's own API inside
    `sync_subscription_from_xendit`. Always acks 200 on a structurally
    valid, correctly-signed request — a sync failure here just means
    the user's own "sync" button (or the next webhook) catches it,
    rather than making Xendit retry-storm an event this handler can't
    act on differently next time anyway."""

    expected = billing_service.webhook_token()
    if not expected or not x_callback_token or not hmac.compare_digest(x_callback_token, expected):
        raise HTTPException(403, "invalid or unconfigured Xendit webhook token")

    body = await request.json()
    event = body.get("event", "unknown")
    reference_id = body.get("data", {}).get("reference_id") or body.get("reference_id")
    logger.info("xendit webhook received", extra={"event": event, "reference_id": reference_id})
    if not reference_id:
        return {"ok": True}

    with get_session_factory()() as db:
        subscription = billing_service.find_subscription_by_reference(db, reference_id)
        if subscription is None:
            return {"ok": True}
        try:
            await billing_service.sync_subscription_from_xendit(db, subscription)
        except billing_service.XenditError:
            logger.exception("xendit webhook-triggered sync failed", extra={"reference_id": reference_id})
    return {"ok": True}
