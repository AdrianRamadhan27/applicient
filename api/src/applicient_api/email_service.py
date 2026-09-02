"""v2 Phase 0 — transactional email via Resend. Hand-rolled httpx calls
against Resend's REST API, matching this codebase's existing
httpx-over-SDK convention for third-party providers (see
gmail_service.py, providers/google_ai_studio.py) — no `resend` SDK
dependency.

Two callers this pass: auth.py's email-verification link, and
scheduler.py's scheduled-run summary. Both go through send_email() so
there's exactly one place that talks to Resend.
"""

from __future__ import annotations

import os

import httpx

RESEND_API_URL = "https://api.resend.com/emails"


class EmailSendError(Exception):
    """Raised when Resend rejects or fails to send an email."""


def _api_key() -> str:
    value = os.environ.get("RESEND_API_KEY")
    if not value:
        raise RuntimeError("RESEND_API_KEY is not set")
    return value


def _from_address() -> str:
    # Resend's shared sandbox sender — works without a verified domain,
    # so this is usable immediately in dev/before DNS records are set
    # up. Real deployments should set EMAIL_FROM to an address on a
    # verified domain once one exists; Resend rejects sends from an
    # unverified custom domain outright, so there's no silent
    # degradation to worry about — just a hard error if misconfigured.
    return os.environ.get("EMAIL_FROM") or "Applicient <onboarding@resend.dev>"


async def send_email(*, to: str, subject: str, html: str) -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(
            RESEND_API_URL,
            headers={"Authorization": f"Bearer {_api_key()}"},
            json={"from": _from_address(), "to": [to], "subject": subject, "html": html},
        )
    if response.status_code >= 400:
        raise EmailSendError(f"Resend rejected the email ({response.status_code}): {response.text}")


async def send_verification_email(*, to: str, verify_url: str) -> None:
    html = (
        "<p>Confirm your email to finish setting up your Applicient account.</p>"
        f'<p><a href="{verify_url}">Verify your email</a></p>'
        "<p>This link expires in 24 hours. If you didn't sign up for Applicient, "
        "you can ignore this email.</p>"
    )
    await send_email(to=to, subject="Verify your email — Applicient", html=html)


async def send_scheduled_run_summary_email(
    *,
    to: str,
    saved_search_name: str,
    new_jobs_count: int,
    strong_matches_count: int,
    radar_url: str,
) -> None:
    html = (
        f"<p>Your scheduled search <strong>{saved_search_name}</strong> just ran.</p>"
        "<ul>"
        f"<li>{new_jobs_count} new job(s) found</li>"
        f"<li>{strong_matches_count} strong match(es)</li>"
        "</ul>"
        f'<p><a href="{radar_url}">View results</a></p>'
    )
    await send_email(to=to, subject=f"Scheduled search results: {saved_search_name}", html=html)
