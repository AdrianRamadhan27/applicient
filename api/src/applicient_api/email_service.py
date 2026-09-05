"""v2 Phase 0 — transactional email via Resend. Hand-rolled httpx calls
against Resend's REST API, matching this codebase's existing
httpx-over-SDK convention for third-party providers (see
gmail_service.py, providers/google_ai_studio.py) — no `resend` SDK
dependency.

Two callers this pass: auth.py's email-verification link, and
scheduler.py's scheduled-run summary. Both go through send_email() so
there's exactly one place that talks to Resend, and both build their
body through _email_shell()/_button() below — one real HTML layout
matching the app's own "Terminal Ledger" design system (IBM Plex Sans,
primary blue, zero border-radius, bordered flat blocks — same tokens
as globals.css and opengraph-image.tsx), not two hand-rolled `<p>`
tags drifting apart. Table-based layout and inline styles throughout
— the only markup that renders consistently across Gmail/Outlook/Apple
Mail, none of which honor a `<style>` block or flexbox/grid reliably.

Centered layout throughout (Adrian, direct) — header mark+wordmark,
eyebrow/heading/body copy, and the CTA button all center-align; the
one deliberate exception is a scheduled-run email's top-matches job
list, which stays left-title/right-score (like every real job row
elsewhere in this app) since centering multi-column tabular data would
hurt scannability rather than help it.
"""

from __future__ import annotations

import html
import os

import httpx

RESEND_API_URL = "https://api.resend.com/emails"

# Same tokens as globals.css's light theme / opengraph-image.tsx's
# PRIMARY — email clients can't read this app's CSS custom properties,
# so the actual hex values are duplicated here once, not re-derived
# per template.
_PRIMARY = "#0f62fe"
_TEXT = "#161616"
_MUTED = "#6f6f6f"
_BORDER = "#e0e0e0"
_PAGE_BG = "#f4f4f4"
_OK = "#0e7c5a"
_OK_BG = "#e8f4ef"
_WARN = "#a86a00"
_WARN_BG = "#fbf1e0"
_CRIT = "#c0392b"
_CRIT_BG = "#fbecea"
_FONT_STACK = "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"


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


def _frontend_url() -> str:
    # Same env var/fallback routers/auth.py's own _frontend_url() uses
    # — not imported from there to avoid a circular import (auth.py
    # imports this module), just the same two lines duplicated.
    return os.environ.get("FRONTEND_URL") or "http://localhost:3000"


def _logo_mark(size: int = 22) -> str:
    """A real hosted <img>, not inline SVG — confirmed live (a real
    received email, not just this module's own Playwright-rendered
    preview) that Gmail strips <svg> out of HTML email bodies entirely,
    regardless of any image-blocking setting; Outlook doesn't render it
    either. Points at web/src/app/icon.tsx's own generated PNG (the
    exact same three-ring mark, already served as a real image for the
    browser-tab favicon) rather than a second logo asset to keep in
    sync by hand."""

    url = f"{_frontend_url()}/icon"
    return (
        f'<img src="{url}" width="{size}" height="{size}" alt="applicient" '
        f'style="display:block; border:0; outline:none;" />'
    )


def _format_idr(amount: int) -> str:
    """"Rp 96.000" — Indonesian thousands-separator style (a dot, not
    a comma), matching billing/page.tsx's own `toLocaleString("id-ID")`
    formatting exactly. Never a $ figure anywhere near this (Phase 16's
    own "never disclose $ equivalence" rule, unchanged in email)."""

    return f"Rp {amount:,}".replace(",", ".")


def _stat_row(stats: list[tuple[str, str]]) -> str:
    """N equal-width bordered stat cells in one row — the same shape
    the scheduled-run-summary email's own two stats already use
    inline, factored out so the purchase-confirmation emails below
    don't hand-roll a second copy of the same table markup."""

    width_pct = 100 // len(stats)
    cells = []
    for i, (value, label) in enumerate(stats):
        cells.append(
            f'<td style="padding: 14px 18px; border:1px solid {_BORDER}; text-align:center; width:{width_pct}%;">'
            f'<div style="font-family:{_FONT_STACK}; font-size:24px; font-weight:600; color:{_TEXT};">{value}</div>'
            f'<div style="font-family:{_FONT_STACK}; font-size:11px; color:{_MUTED}; text-transform:uppercase; letter-spacing:0.04em; margin-top:2px;">{label}</div>'
            "</td>"
        )
        if i < len(stats) - 1:
            cells.append('<td style="width:12px;"></td>')
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 8px 0 4px;"><tr>'
        + "".join(cells)
        + "</tr></table>"
    )


def _button(label: str, url: str) -> str:
    # `align="center"` on the table itself (not just `margin: 0 auto`,
    # which Outlook's Word rendering engine ignores) is what actually
    # centers a table in a mail client — same reason the header/footer
    # tables below set it too.
    return (
        '<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin: 28px auto;"><tr><td '
        f'style="background:{_PRIMARY};">'
        f'<a href="{url}" target="_blank" '
        f'style="display:inline-block; padding: 13px 28px; font-family:{_FONT_STACK}; font-size:14px; '
        f'font-weight:600; color:#ffffff; text-decoration:none;">{label}</a>'
        "</td></tr></table>"
    )


def _recommendation_style(recommendation: str | None) -> tuple[str, str, str]:
    """(background, text color, label) — the exact same mapping
    web/src/lib/recommendation.ts's recommendationColor/
    RECOMMENDATION_LABEL uses, duplicated here for the same "an email
    client can't import this app's frontend code" reason every other
    token in this module is."""

    if recommendation in ("strong_apply", "apply"):
        return _OK_BG, _OK, "strong apply" if recommendation == "strong_apply" else "apply"
    if recommendation == "stretch":
        return _WARN_BG, _WARN, "stretch"
    if recommendation == "skip":
        return _CRIT_BG, _CRIT, "skip"
    return "#eeeeee", _MUTED, "unscored"


def _job_row(job: dict) -> str:
    """One bordered row per top-matched job — left title/company,
    right recommendation badge + score, same left-data/right-badge
    shape Job Inbox's own real cards use (inbox/page.tsx), not a
    centered layout (see this module's own top-of-file note on why)."""

    bg, color, label = _recommendation_style(job.get("recommendation"))
    title = html.escape(job.get("title") or "Untitled role")
    company = html.escape(job.get("company") or "")
    score = job.get("score")
    score_html = f"{score:.0f}" if isinstance(score, (int, float)) else "&mdash;"
    return f"""
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid {_BORDER}; margin-bottom:8px;">
      <tr>
        <td style="padding:12px 16px; text-align:left; vertical-align:middle;">
          <div style="font-family:{_FONT_STACK}; font-size:13px; font-weight:600; color:{_TEXT};">{title}</div>
          <div style="font-family:{_FONT_STACK}; font-size:12px; color:{_MUTED}; margin-top:2px;">{company}</div>
        </td>
        <td style="padding:12px 16px; text-align:right; vertical-align:middle; white-space:nowrap;">
          <span style="display:inline-block; padding:3px 9px; font-family:{_FONT_STACK}; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.03em; background:{bg}; color:{color};">{label}</span>
          <div style="font-family:{_FONT_STACK}; font-size:18px; font-weight:600; color:{_TEXT}; margin-top:6px;">{score_html}</div>
        </td>
      </tr>
    </table>"""


def _email_shell(*, preheader: str, body_html: str) -> str:
    """The one branded layout every email in this app shares — a flat
    bordered card (no border-radius/shadow, matching globals.css's own
    "Terminal Ledger" rule), header with the real logo mark + wordmark,
    the caller's own body in the middle, a plain footer. Centered
    throughout (Adrian, direct). `preheader` is the hidden preview-text
    line most clients show next to the subject in an inbox list —
    worth setting deliberately rather than leaving it to whatever the
    body's first line happens to be."""

    return f"""<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Applicient</title>
  </head>
  <body style="margin:0; padding:0; background:{_PAGE_BG}; font-family:{_FONT_STACK};">
    <span style="display:none; visibility:hidden; opacity:0; overflow:hidden; height:0; width:0; max-height:0;">{preheader}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{_PAGE_BG};">
      <tr>
        <td align="center" style="padding: 40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px; background:#ffffff; border:1px solid {_BORDER};">
            <tr>
              <td align="center" style="padding: 22px 32px; border-bottom:1px solid {_BORDER};">
                <table role="presentation" align="center" cellpadding="0" cellspacing="0"><tr>
                  <td style="padding-right:9px; vertical-align:middle;">{_logo_mark()}</td>
                  <td style="vertical-align:middle;">
                    <span style="font-family:{_FONT_STACK}; font-size:16px; font-weight:600; color:{_TEXT}; letter-spacing:-0.2px;">applicient</span>
                  </td>
                </tr></table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding: 36px 32px; font-family:{_FONT_STACK}; font-size:14px; line-height:1.6; color:{_TEXT}; text-align:center;">
                {body_html}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding: 18px 32px; border-top:1px solid {_BORDER}; text-align:center;">
                <p style="margin:0; font-family:{_FONT_STACK}; font-size:12px; color:{_MUTED};">
                  You&rsquo;re receiving this because you have an Applicient account.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>"""


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
    body = f"""
        <p style="margin:0 0 4px; font-family:{_FONT_STACK}; font-size:11px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:{_PRIMARY}; text-align:center;">Verify your email</p>
        <h1 style="margin:6px 0 16px; font-family:{_FONT_STACK}; font-size:20px; font-weight:600; color:{_TEXT}; text-align:center;">One step left to activate your account</h1>
        <p style="margin:0 0 4px; font-family:{_FONT_STACK}; font-size:14px; color:{_TEXT}; text-align:center;">Confirm your email to finish setting up your Applicient account — you&rsquo;ll need to do this before you can sign in.</p>
        {_button("Verify your email", verify_url)}
        <p style="margin:20px 0 0; font-family:{_FONT_STACK}; font-size:12px; color:{_MUTED}; text-align:center;">This link expires in 24 hours. If you didn&rsquo;t sign up for Applicient, you can safely ignore this email.</p>
    """
    html_out = _email_shell(preheader="Confirm your email to activate your Applicient account.", body_html=body)
    await send_email(to=to, subject="Verify your email — Applicient", html=html_out)


async def send_scheduled_run_summary_email(
    *,
    to: str,
    saved_search_name: str,
    new_jobs_count: int,
    strong_matches_count: int,
    radar_url: str,
    top_jobs: list[dict] | None = None,
) -> None:
    """`top_jobs` — up to 3 dicts of `{title, company, score,
    recommendation}`, the run's own highest-scored new jobs (Adrian,
    direct: "if there are any new jobs can you make it preview top 3
    scored ones"). Omitted/empty renders nothing extra — a quiet run
    with only strong-match carryover (no genuinely new postings) has
    nothing new to preview."""

    safe_name = html.escape(saved_search_name)
    stat_cell = (
        "padding: 14px 18px; border:1px solid {border}; text-align:center;"
    ).format(border=_BORDER)
    top_jobs_html = ""
    if top_jobs:
        top_jobs_html = (
            f'<p style="margin:24px 0 8px; font-family:{_FONT_STACK}; font-size:11px; font-weight:600; '
            f'letter-spacing:0.06em; text-transform:uppercase; color:{_MUTED}; text-align:center;">Top matches</p>'
            + "".join(_job_row(job) for job in top_jobs)
        )
    body = f"""
        <p style="margin:0 0 4px; font-family:{_FONT_STACK}; font-size:11px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:{_PRIMARY}; text-align:center;">Job search</p>
        <h1 style="margin:6px 0 16px; font-family:{_FONT_STACK}; font-size:20px; font-weight:600; color:{_TEXT}; text-align:center;">{safe_name} just ran</h1>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 8px 0 4px;"><tr>
          <td style="{stat_cell} width:50%;">
            <div style="font-family:{_FONT_STACK}; font-size:24px; font-weight:600; color:{_TEXT};">{new_jobs_count}</div>
            <div style="font-family:{_FONT_STACK}; font-size:11px; color:{_MUTED}; text-transform:uppercase; letter-spacing:0.04em; margin-top:2px;">New job(s)</div>
          </td>
          <td style="width:12px;"></td>
          <td style="{stat_cell} width:50%;">
            <div style="font-family:{_FONT_STACK}; font-size:24px; font-weight:600; color:{_TEXT};">{strong_matches_count}</div>
            <div style="font-family:{_FONT_STACK}; font-size:11px; color:{_MUTED}; text-transform:uppercase; letter-spacing:0.04em; margin-top:2px;">Strong match(es)</div>
          </td>
        </tr></table>
        {top_jobs_html}
        {_button("View results", radar_url)}
    """
    html_out = _email_shell(
        preheader=f"{new_jobs_count} new job(s), {strong_matches_count} strong match(es) found.",
        body_html=body,
    )
    await send_email(to=to, subject=f"Scheduled search results: {saved_search_name}", html=html_out)


async def send_subscription_purchase_email(
    *,
    to: str,
    plan_name: str,
    price_idr: int,
    monthly_credits: int,
    renewed: bool,
    billing_url: str,
) -> None:
    """Adrian, direct: "email notification for any purchase whether
    its subscription or buy credits". Fires from
    billing_service.sync_subscription_from_dodo at the exact point it
    already distinguishes a real activation/plan-change from a
    same-plan rollover (`plan_changed or period_advanced`) —
    `renewed=True` only for the latter, so the copy says "renewed"
    rather than "confirmed" for a plan that was already active."""

    safe_plan = html.escape(plan_name)
    eyebrow = "Subscription renewed" if renewed else "Subscription confirmed"
    heading = f"Your {safe_plan} plan renewed" if renewed else f"You&rsquo;re on the {safe_plan} plan"
    verb = "renewing" if renewed else "subscribing to"
    body = f"""
        <p style="margin:0 0 4px; font-family:{_FONT_STACK}; font-size:11px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:{_PRIMARY}; text-align:center;">{eyebrow}</p>
        <h1 style="margin:6px 0 16px; font-family:{_FONT_STACK}; font-size:20px; font-weight:600; color:{_TEXT}; text-align:center;">{heading}</h1>
        <p style="margin:0 0 4px; font-family:{_FONT_STACK}; font-size:14px; color:{_TEXT}; text-align:center;">Thanks for {verb} Applicient {safe_plan}.</p>
        {_stat_row([(_format_idr(price_idr), "Charged"), (f"+{monthly_credits:,}", "Credits added")])}
        {_button("View your billing", billing_url)}
    """
    html_out = _email_shell(preheader=f"{eyebrow}: {plan_name}.", body_html=body)
    await send_email(to=to, subject=f"{eyebrow} — Applicient", html=html_out)


async def send_credit_pack_purchase_email(
    *, to: str, pack_name: str, price_idr: int, credits: int, billing_url: str
) -> None:
    """Adrian, direct: same "any purchase" ask above, for a one-time
    credit-pack buy — fires from routers/webhooks.py's
    _handle_payment_succeeded right after credit_ledger.record_purchase
    lands the real ledger row."""

    safe_pack = html.escape(pack_name)
    body = f"""
        <p style="margin:0 0 4px; font-family:{_FONT_STACK}; font-size:11px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:{_PRIMARY}; text-align:center;">Credits purchased</p>
        <h1 style="margin:6px 0 16px; font-family:{_FONT_STACK}; font-size:20px; font-weight:600; color:{_TEXT}; text-align:center;">{safe_pack} credit pack purchased</h1>
        <p style="margin:0 0 4px; font-family:{_FONT_STACK}; font-size:14px; color:{_TEXT}; text-align:center;">These credits never expire, and stack on top of whatever your plan already grants each month.</p>
        {_stat_row([(_format_idr(price_idr), "Charged"), (f"+{credits:,}", "Credits added")])}
        {_button("View your billing", billing_url)}
    """
    html_out = _email_shell(
        preheader=f"{pack_name} credit pack purchased — {credits} credits added.", body_html=body
    )
    await send_email(to=to, subject="Credits purchased — Applicient", html=html_out)


async def send_subscription_ended_email(*, to: str, plan_name: str, billing_url: str) -> None:
    """Adrian, direct: "notification if their subscription runs out to
    ask to renew". Fires from sync_subscription_from_dodo's own
    cancelled/expired branch, right as it falls the account back to
    the Free plan — `plan_name` is the plan that just ended (captured
    before that branch overwrites `subscription.plan_id`), not "Free"."""

    safe_plan = html.escape(plan_name)
    body = f"""
        <p style="margin:0 0 4px; font-family:{_FONT_STACK}; font-size:11px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:{_WARN}; text-align:center;">Subscription ended</p>
        <h1 style="margin:6px 0 16px; font-family:{_FONT_STACK}; font-size:20px; font-weight:600; color:{_TEXT}; text-align:center;">Your {safe_plan} plan has ended</h1>
        <p style="margin:0 0 4px; font-family:{_FONT_STACK}; font-size:14px; color:{_TEXT}; text-align:center;">You&rsquo;ve been moved to the Free plan. Renew to get {safe_plan}&rsquo;s monthly credits and features back.</p>
        {_button("Renew your plan", billing_url)}
    """
    html_out = _email_shell(
        preheader=f"Your {plan_name} plan has ended — renew to keep your features.", body_html=body
    )
    await send_email(to=to, subject="Your subscription has ended — Applicient", html=html_out)
