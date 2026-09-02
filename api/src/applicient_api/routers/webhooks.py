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


@router.post("/dodo", status_code=200)
async def dodo_webhook(request: Request):
    """A best-effort nudge, not the source of truth — see
    billing_service.py's own module docstring. Signature verification
    (Standard Webhooks spec: webhook-id/webhook-signature/
    webhook-timestamp headers, HMAC-SHA256) happens inside
    unwrap_webhook_event via the official `standardwebhooks` library,
    not hand-rolled here — it raises rather than silently accepting an
    unsigned or mis-signed request. Only subscription.* events matter
    to this app; everything else (payments, refunds, disputes, license
    keys, ...) is acked and ignored. Never trusts the webhook's own
    `data` fields to mutate billing state directly — only uses
    subscription_id/customer_id to find which of our own Subscription
    rows to re-sync, then re-derives the rest from a direct GET inside
    sync_subscription_from_dodo. Always acks 200 on a validly-signed
    request — a sync failure here just means the user's own return to
    /billing (or the next webhook) catches it, rather than making Dodo
    retry-storm an event this handler can't act on differently next
    time anyway."""

    raw_body = await request.body()
    headers = {
        "webhook-id": request.headers.get("webhook-id", ""),
        "webhook-signature": request.headers.get("webhook-signature", ""),
        "webhook-timestamp": request.headers.get("webhook-timestamp", ""),
    }
    try:
        event = billing_service.unwrap_webhook_event(raw_body, headers)
    except Exception:
        raise HTTPException(403, "invalid or unverifiable Dodo webhook signature")

    if not event.type.startswith("subscription."):
        return {"ok": True}

    data = event.data
    logger.info("dodo webhook received", extra={"event": event.type, "subscription_id": data.subscription_id})

    with get_session_factory()() as db:
        subscription = billing_service.find_subscription_by_dodo_ids(
            db, dodo_subscription_id=data.subscription_id, dodo_customer_id=data.customer.customer_id
        )
        if subscription is None:
            return {"ok": True}
        try:
            await billing_service.sync_subscription_from_dodo(db, subscription, dodo_subscription_id=data.subscription_id)
        except billing_service.DodoError:
            logger.exception("dodo webhook-triggered sync failed", extra={"subscription_id": data.subscription_id})
    return {"ok": True}
