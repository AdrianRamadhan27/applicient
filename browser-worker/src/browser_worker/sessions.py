"""F6.2/F6.4/F6.6/§8.3 — one shared Chromium process, many isolated
browser contexts. A `BrowserContext` per (persona, source) is
lightweight in Playwright's own model (unlike a whole browser process),
so this launches Chromium once and hands out real Playwright contexts
per session rather than a process per session.

Uses the async API (`playwright.async_api`), not the sync one — this
runs inside a FastAPI event loop, and the sync API blocks it.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from playwright.async_api import Browser, BrowserContext, Page, Playwright, async_playwright


class SessionNotFoundError(KeyError):
    pass


@dataclass
class Session:
    id: str
    context: BrowserContext
    page: Page
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class SessionManager:
    """One instance per browser-worker process, held on `app.state`."""

    def __init__(self) -> None:
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._sessions: dict[str, Session] = {}

    async def start(self) -> None:
        self._playwright = await async_playwright().start()
        # Chromium's own sandbox needs a non-root process to set up its
        # namespaces; the Docker image runs as root (simplest base-image
        # setup), so it launches with --no-sandbox there. Native/local
        # dev runs as a normal user and keeps the sandbox on by default —
        # opt-in via env var, not a blanket default, since dropping the
        # sandbox is a real (if low-stakes, single-user-local-tool)
        # security relaxation.
        launch_args = ["--no-sandbox"] if os.environ.get("BROWSER_WORKER_NO_SANDBOX") == "1" else []
        self._browser = await self._playwright.chromium.launch(headless=True, args=launch_args)

    async def stop(self) -> None:
        for session_id in list(self._sessions):
            await self.close(session_id)
        if self._browser is not None:
            await self._browser.close()
        if self._playwright is not None:
            await self._playwright.stop()

    def _get(self, session_id: str) -> Session:
        session = self._sessions.get(session_id)
        if session is None:
            raise SessionNotFoundError(session_id)
        return session

    async def open(self, url: str, storage_state: dict | None = None) -> tuple[str, str]:
        """F6.2 — opens the given URL in a fresh, isolated context and
        returns (session_id, initial accessibility snapshot). `storage_state`
        restores a persisted authenticated context (F6.6) when provided."""

        assert self._browser is not None, "SessionManager.start() was never called"
        context = await self._browser.new_context(storage_state=storage_state)
        page = await context.new_page()
        await page.goto(url, wait_until="domcontentloaded")

        session_id = str(uuid.uuid4())
        self._sessions[session_id] = Session(id=session_id, context=context, page=page)
        snapshot = await self.snapshot(session_id)
        return session_id, snapshot

    async def goto(self, session_id: str, url: str) -> None:
        """Navigates this *existing* session's page to a new URL,
        keeping its cookies/login state — `open` always creates a
        brand-new, isolated (and therefore unauthenticated) context,
        so it is the wrong tool for "go somewhere else after logging
        in." Raised live: an agent that logged into LinkedIn in one
        session, then needed the actual job posting, had no way to get
        there without either an in-page link to click or opening a
        second, logged-out session — it repeatedly did the latter,
        got confused about which session was authenticated, and the
        run never recovered."""

        page = self._get(session_id).page
        await page.goto(url, wait_until="domcontentloaded")

    async def snapshot(self, session_id: str) -> str:
        """F6.2 — the accessibility-tree field map, ref-annotated via
        Playwright's own `mode="ai"` aria snapshot (the same mechanism
        Playwright's own MCP/agent tooling uses) so a tool call can act
        on a specific field by `ref` rather than a CSS selector — the
        whole point of F6.2's "not raw DOM scraping" requirement."""

        page = self._get(session_id).page
        return await page.locator("body").aria_snapshot(mode="ai")

    async def fill(self, session_id: str, ref: str, value: str) -> None:
        page = self._get(session_id).page
        await page.locator(f"aria-ref={ref}").fill(value)

    async def select(self, session_id: str, ref: str, label: str) -> None:
        """Native `<select>` dropdowns can't be `.fill()`ed (that's a
        real Playwright limitation, not a missing accessible ref on
        the individual `<option>`s — those never get their own ref in
        the aria snapshot at all). Playwright's own `select_option`
        picks the option by its visible text directly against the
        `<select>` element's own ref — no per-option ref ever needed,
        so there is no legitimate case where a real `<select>` genuinely
        requires a human (raised live: the agent asked a human to open
        devtools and run JavaScript for exactly this — unnecessary and
        not something this app should ever ask of anyone)."""

        page = self._get(session_id).page
        await page.locator(f"aria-ref={ref}").select_option(label=label)

    async def click(self, session_id: str, ref: str) -> None:
        page = self._get(session_id).page
        await page.locator(f"aria-ref={ref}").click()

    async def type_into(self, session_id: str, ref: str, text: str) -> None:
        """Real per-keystroke input via `press_sequentially`, unlike
        `fill`'s single programmatic value-set — some autocomplete/
        typeahead widgets only fire their suggestion-list listeners on
        actual keydown/keyup events, not a value assignment. Slower by
        design; use `fill` first and reach for this only when a field
        needs the live-typing behavior specifically."""

        page = self._get(session_id).page
        await page.locator(f"aria-ref={ref}").press_sequentially(text)

    async def press_key(self, session_id: str, key: str, ref: str | None = None) -> None:
        """`ref` given: focuses that element first (Playwright's
        `Locator.press` does both atomically) — e.g. Enter to commit a
        typed value into a tag/chip input. `ref` omitted: presses
        against whatever currently has focus / the page itself — e.g.
        Escape to dismiss a modal that isn't itself an input."""

        page = self._get(session_id).page
        if ref is not None:
            await page.locator(f"aria-ref={ref}").press(key)
        else:
            await page.keyboard.press(key)

    async def upload(self, session_id: str, ref: str, filename: str, data: bytes, mime_type: str) -> None:
        page = self._get(session_id).page
        await page.locator(f"aria-ref={ref}").set_input_files(
            files=[{"name": filename, "mimeType": mime_type, "buffer": data}]
        )

    async def screenshot(self, session_id: str) -> bytes:
        page = self._get(session_id).page
        return await page.screenshot(type="png", full_page=False)

    async def current_url(self, session_id: str) -> str:
        return self._get(session_id).page.url

    async def mouse_click(self, session_id: str, x: float, y: float) -> None:
        """Live handoff (F6.5) input forwarding — the human clicking
        inside the embedded view, not an agent tool call."""

        page = self._get(session_id).page
        await page.mouse.click(x, y)

    async def type_text(self, session_id: str, text: str) -> None:
        page = self._get(session_id).page
        await page.keyboard.type(text)

    async def key_press(self, session_id: str, key: str) -> None:
        page = self._get(session_id).page
        await page.keyboard.press(key)

    async def get_storage_state(self, session_id: str) -> dict:
        context = self._get(session_id).context
        return await context.storage_state()

    async def close(self, session_id: str) -> dict:
        """Returns the final storage_state before tearing the context
        down, so the caller can persist it (F6.6) even on close."""

        session = self._get(session_id)
        storage_state = await session.context.storage_state()
        await session.context.close()
        del self._sessions[session_id]
        return storage_state
