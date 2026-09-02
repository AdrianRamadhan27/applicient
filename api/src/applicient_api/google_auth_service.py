"""v2 Phase 1 — "Continue with Google" login. Deliberately separate
from gmail_service.py's Gmail-connection OAuth flow, not a reuse of it:
that flow's scope (openid email profile gmail.readonly) plus
access_type=offline/prompt=consent would force every login user
through a mail-access consent screen just to sign in. This flow reuses
only the same GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET (one Google Cloud
OAuth client, a second registered redirect URI — scope and consent
behavior are requested per-authorization, not fixed per-client) with
narrower scope and no offline access, since a login check needs no
refresh token.
"""

from __future__ import annotations

import os

import httpx

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
LOGIN_SCOPES = "openid email profile"


class GoogleLoginError(Exception):
    """Raised for any failed step of the login OAuth flow."""


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
    value = os.environ.get("GOOGLE_LOGIN_REDIRECT_URI")
    if not value:
        raise RuntimeError("GOOGLE_LOGIN_REDIRECT_URI is not set")
    return value


def build_authorize_url(state: str) -> str:
    params = {
        "client_id": _client_id(),
        "redirect_uri": _redirect_uri(),
        "response_type": "code",
        "scope": LOGIN_SCOPES,
        "state": state,
    }
    return f"{AUTH_URL}?{httpx.QueryParams(params)}"


async def exchange_code(code: str) -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(
            TOKEN_URL,
            data={
                "code": code,
                "client_id": _client_id(),
                "client_secret": _client_secret(),
                "redirect_uri": _redirect_uri(),
                "grant_type": "authorization_code",
            },
        )
    if response.status_code >= 400:
        raise GoogleLoginError(f"Google token exchange failed ({response.status_code}): {response.text}")
    return response.json()


async def fetch_google_profile(access_token: str) -> dict:
    """Google's userinfo payload — {"id", "email", "verified_email", ...}.
    `id` is Google's stable per-account identifier, stored as
    User.google_id; `email` is what a first-time login creates the
    account with."""
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
    if response.status_code >= 400:
        raise GoogleLoginError(f"Google userinfo lookup failed ({response.status_code}): {response.text}")
    return response.json()
