"""F6.10 — captcha solver plugin interface. Ships with zero real
implementations and no wiring into `browser_tools.py`'s tool set —
`browser_request_handoff` is what actually handles a captcha today (F6.5
hands it to the human). This interface exists only so a user willing to
accept a third-party solving service's own account/ToS risk can plug
one in later; Applicient itself never solves a captcha.
"""

from __future__ import annotations

from typing import Protocol


class CaptchaChallenge:
    def __init__(self, *, kind: str, site_key: str | None, page_url: str) -> None:
        self.kind = kind  # e.g. "recaptcha_v2", "hcaptcha", "turnstile"
        self.site_key = site_key
        self.page_url = page_url


class CaptchaSolver(Protocol):
    """A third-party adapter implements this. No adapter ships with
    this codebase — enabling one requires the separate, explicit
    acknowledgment gate described below, not just providing a class
    that satisfies this Protocol."""

    name: str

    async def solve(self, challenge: CaptchaChallenge) -> str:
        """Returns the token/response value the page's own captcha
        widget expects, or raises if it cannot solve the challenge."""
        ...


def is_captcha_solving_enabled(settings: dict) -> bool:
    """F6.10 — enabling captcha solving requires both a configured
    solver AND a separate, explicit acknowledgment of the account and
    terms-of-service risk (a real checkbox-plus-confirmation-text gate
    in Settings — not built in this milestone, see M4_IMPLEMENTATION.md
    §7). A solver present without that acknowledgment stays disabled."""

    return bool(settings.get("captcha_solver_configured") and settings.get("captcha_risk_acknowledged"))
