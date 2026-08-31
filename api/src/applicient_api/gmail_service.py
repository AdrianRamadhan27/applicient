"""M5 F8.1/F8.2 — Gmail OAuth connect flow and the token/watch
mechanics email_ingestion.py (Part 4) builds on. Hand-rolled httpx
calls against Gmail's REST API, matching this codebase's existing
httpx-over-SDK convention for third-party providers (see
providers/google_ai_studio.py) — no google-api-python-client.

The FastAPI routes (routers/gmail.py) are intentionally thin wrappers
around this independently callable service layer, same shape as
connections.py for ProviderConnection.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import httpx
from sqlalchemy.orm import Session

from applicient_api.models.gmail import GmailConnection
from applicient_api.security import decrypt_api_key, encrypt_api_key

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
GMAIL_API_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me"
# email/profile alongside gmail.readonly — without them the resulting
# access token can't call USERINFO_URL to identify which Google
# account was granted (confirmed live: Google's userinfo endpoint
# 401s a gmail.readonly-only token with "missing required
# authentication credential", not the 403 insufficient_scope you'd
# expect — it needs an identity scope present, not just Gmail access).
GMAIL_SCOPES = "openid email profile https://www.googleapis.com/auth/gmail.readonly"


class GmailOAuthError(Exception):
    """Raised for any failed step of the connect flow or a refresh-token exchange."""


def _client_id() -> str:
    value = os.environ.get("GMAIL_CLIENT_ID")
    if not value:
        raise RuntimeError("GMAIL_CLIENT_ID is not set")
    return value


def _client_secret() -> str:
    value = os.environ.get("GMAIL_CLIENT_SECRET")
    if not value:
        raise RuntimeError("GMAIL_CLIENT_SECRET is not set")
    return value


def _redirect_uri() -> str:
    value = os.environ.get("GMAIL_REDIRECT_URI")
    if not value:
        raise RuntimeError("GMAIL_REDIRECT_URI is not set")
    return value


def build_authorize_url(state: str) -> str:
    params = {
        "client_id": _client_id(),
        "redirect_uri": _redirect_uri(),
        "response_type": "code",
        "scope": GMAIL_SCOPES,
        "access_type": "offline",
        # Forces Google to hand back a refresh_token even on a repeat
        # consent for the same account — without this, a re-auth after
        # the first grant silently omits it.
        "prompt": "consent",
        "state": state,
    }
    return f"{AUTH_URL}?{httpx.QueryParams(params)}"


async def exchange_code(code: str) -> dict:
    """Returns {access_token, refresh_token, expires_in, scope, ...}."""

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            TOKEN_URL,
            data={
                "code": code,
                "client_id": _client_id(),
                "client_secret": _client_secret(),
                "redirect_uri": _redirect_uri(),
                "grant_type": "authorization_code",
            },
        )
    if resp.status_code >= 400:
        raise GmailOAuthError(f"token exchange failed: {resp.status_code}: {resp.text[:300]}")
    return resp.json()


async def fetch_google_email(access_token: str) -> str:
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
    if resp.status_code >= 400:
        raise GmailOAuthError(f"userinfo fetch failed: {resp.status_code}: {resp.text[:300]}")
    email = resp.json().get("email")
    if not email:
        raise GmailOAuthError("userinfo response had no email")
    return email


def create_connection(
    session: Session,
    *,
    user_id: uuid.UUID,
    google_email: str,
    refresh_token: str,
    scopes: list[str],
) -> GmailConnection:
    existing = session.query(GmailConnection).filter_by(user_id=user_id).one_or_none()
    if existing is not None:
        # Re-connecting (e.g. a token was revoked externally) replaces
        # the grant in place rather than erroring — same account, new
        # refresh token, history_id reset since a stale one is invalid
        # against a different token anyway.
        existing.google_email = google_email
        existing.refresh_token_encrypted = encrypt_api_key(refresh_token)
        existing.scopes = scopes
        existing.history_id = None
        existing.status = "ok"
        existing.last_error = None
        session.flush()
        return existing

    conn = GmailConnection(
        user_id=user_id,
        google_email=google_email,
        refresh_token_encrypted=encrypt_api_key(refresh_token),
        scopes=scopes,
        status="ok",
    )
    session.add(conn)
    session.flush()
    return conn


async def get_valid_access_token(conn: GmailConnection) -> str:
    """Access tokens are never stored — every operation exchanges the
    stored refresh token for a fresh one. Gmail access tokens are
    short-lived (~1h); this trades one extra round trip per operation
    for not having to track expiry."""

    refresh_token = decrypt_api_key(conn.refresh_token_encrypted)
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            TOKEN_URL,
            data={
                "refresh_token": refresh_token,
                "client_id": _client_id(),
                "client_secret": _client_secret(),
                "grant_type": "refresh_token",
            },
        )
    if resp.status_code >= 400:
        raise GmailOAuthError(f"access token refresh failed: {resp.status_code}: {resp.text[:300]}")
    access_token = resp.json().get("access_token")
    if not access_token:
        raise GmailOAuthError("refresh response had no access_token")
    return access_token


async def start_watch(session: Session, conn: GmailConnection) -> None:
    """POST users.watch — best-effort: a missing/unprovisioned Pub/Sub
    topic (GMAIL_PUBSUB_TOPIC unset, or the topic not granting publish
    rights to gmail-api-push@system.gserviceaccount.com — real GCP
    infra the operator provisions out-of-band, not something this
    codebase creates) is caught and stored as last_error rather than
    raised, since polling still works without push."""

    topic = os.environ.get("GMAIL_PUBSUB_TOPIC")
    if not topic:
        conn.last_error = "GMAIL_PUBSUB_TOPIC not configured — push disabled, polling only"
        session.flush()
        return

    try:
        access_token = await get_valid_access_token(conn)
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{GMAIL_API_ROOT}/watch",
                headers={"Authorization": f"Bearer {access_token}"},
                # No labelIds/labelFilterAction — watches the whole
                # mailbox (still bounded by the gmail.readonly scope
                # itself). An empty labelIds + labelFilterAction:
                # "include" would mean "notify for changes to these
                # (zero) labels," i.e. never — a latent bug from the
                # original label-gated design, caught before push was
                # ever actually exercised.
                json={"topicName": topic},
            )
        if resp.status_code >= 400:
            conn.last_error = f"watch failed: {resp.status_code}: {resp.text[:300]}"
            session.flush()
            return
        body = resp.json()
        conn.history_id = str(body.get("historyId")) if body.get("historyId") else conn.history_id
        expiration_ms = body.get("expiration")
        if expiration_ms:
            conn.watch_expiration = datetime.fromtimestamp(int(expiration_ms) / 1000, tz=timezone.utc)
        conn.last_error = None
    except GmailOAuthError as exc:
        conn.last_error = str(exc)
    session.flush()


async def disconnect(session: Session, conn: GmailConnection) -> None:
    try:
        access_token = await get_valid_access_token(conn)
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(f"{GMAIL_API_ROOT}/stop", headers={"Authorization": f"Bearer {access_token}"})
    except (GmailOAuthError, httpx.RequestError):
        pass  # best-effort — the connection row is deleted regardless
    session.delete(conn)
    session.flush()
