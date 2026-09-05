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

from applicient_api import billing_service, credit_ledger, email_ingestion, email_service
from applicient_api.deps import get_session_factory
from applicient_api.models.billing import CreditPack
from applicient_api.models.profile import User

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
    unsigned or mis-signed request. Only subscription.* events (Plan
    subscriptions) and payment.succeeded (Phase 16 credit-pack one-time
    purchases) matter to this app; everything else (refunds, disputes,
    license keys, ...) is acked and ignored. Never trusts the webhook's
    own `data` fields to mutate billing state directly — either re-syncs
    from a direct GET (sync_subscription_from_dodo) or, for a payment,
    re-fetches the payment itself before crediting anything
    (retrieve_payment) — same "the webhook is a nudge, polling is the
    real source of truth" discipline either way. Always acks 200 on a
    validly-signed request — a failure here just means the user's own
    return to /billing (or the next webhook) catches it, rather than
    making Dodo retry-storm an event this handler can't act on
    differently next time anyway."""

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

    if event.type == "payment.succeeded":
        await _handle_payment_succeeded(event.data)
        return {"ok": True}

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


async def _handle_payment_succeeded(payment) -> None:
    """Phase 16 — credits a CreditPack purchase. `metadata` is whatever
    start_pack_checkout stamped onto the checkout session
    (billing_service.py); a payment with no `credit_pack_id` in its
    metadata is a Plan subscription's own initial payment (a
    subscription's first charge also fires payment.succeeded, alongside
    its own subscription.active event) — nothing to do here for those,
    the subscription.* branch above already handles activation."""

    metadata = payment.metadata or {}
    pack_id = metadata.get("credit_pack_id")
    user_id = metadata.get("user_id")
    if not pack_id or not user_id:
        return
    logger.info("dodo payment.succeeded received", extra={"payment_id": payment.payment_id, "credit_pack_id": pack_id})

    with get_session_factory()() as db:
        pack = db.get(CreditPack, pack_id)
        if pack is None:
            return
        # Re-fetch the real payment rather than trusting the webhook
        # payload's own status field, same "webhook is a nudge, polling
        # is authoritative" reasoning sync_subscription_from_dodo uses.
        try:
            confirmed = await billing_service.retrieve_payment(payment.payment_id)
        except billing_service.DodoError:
            logger.exception("dodo webhook-triggered payment re-fetch failed", extra={"payment_id": payment.payment_id})
            return
        if confirmed.status != "succeeded":
            return
        credit_ledger.record_purchase(db, user_id=user_id, pack=pack, dodo_payment_id=payment.payment_id)

        # Adrian, direct: "email notification for any purchase whether
        # its subscription or buy credits" — best-effort, same
        # non-blocking treatment every other email in this codebase
        # gets; the real ledger row above already landed regardless.
        user = db.get(User, user_id)
        if user is not None:
            frontend_url = os.environ.get("FRONTEND_URL") or "http://localhost:3000"
            try:
                await email_service.send_credit_pack_purchase_email(
                    to=user.email,
                    pack_name=pack.name,
                    price_idr=pack.price_idr,
                    credits=pack.credits,
                    billing_url=f"{frontend_url}/console/billing",
                )
            except (RuntimeError, email_service.EmailSendError):
                pass
