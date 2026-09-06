"""F6.2-F6.6/§7.4 — the application-agent's real tool surface. Every
tool here is a thin HTTP client against the browser-worker service
(`browser-worker/src/browser_worker/main.py`) or a thin DB write
against `api/`'s own models — no tool fakes or simulates browser
control; every call in this file makes a real request.

Tools are built per agent run via `build_application_tools(...)`,
not module-level singletons — each run is scoped to one specific
application/persona/document set via closures, which also keeps
concurrent runs (bulk apply, F6.11) from sharing mutable state.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable

import httpx
from langchain_core.tools import tool
from sqlalchemy.orm import sessionmaker

from applicient_api.credential_service import get_secret, list_credentials
from applicient_api.document_resolution import ResolvedDocument
from applicient_api.form_answer_service import lookup_form_answer, save_form_answer
from applicient_api.models.enums import EventActor
from applicient_api.models.pipeline import Application
from applicient_api.object_storage import get_object, put_object
from applicient_api.pipeline_service import MarkAppliedError, TransitionError, mark_applied, transition


def build_application_tools(
    *,
    user_id: uuid.UUID,
    persona_id: uuid.UUID,
    application_id: uuid.UUID,
    document_keys: dict[str, ResolvedDocument],
    session_factory: sessionmaker,
    embeddings_client,
    embeddings_provider: str,
    browser_worker_url: str,
    http_client: httpx.AsyncClient,
    record_screenshot: Callable[[str], None],
    record_email_draft: Callable[[dict], None],
    storage_state: dict | None = None,
) -> list:
    """`document_keys` maps a doc type ("cv" / "cover_letter" /
    "answer_pack") to a `ResolvedDocument` (object-storage key,
    filename, content_type) — resolved once by the caller via
    `applicient_api.document_resolution.resolve_application_documents`
    (which has the DB context to do it and already falls back through
    an explicit primary document, the job_group's tailored documents,
    and finally the persona's own originally-uploaded CV), not
    re-resolved per tool call. `record_screenshot` persists a new
    screenshot's object key onto the current `ApplicationAttempt` row
    immediately (durable even if the run is interrupted mid-flight).
    `storage_state` (F6.6) is a previously-saved, decrypted Playwright
    session — resolved once by the caller (`application_service.py`,
    which has the DB/object-storage access to do it) from this
    application's (persona, source) pair, and handed to `browser_open`
    below so a run that already logged in once can start already
    authenticated instead of hitting a login wall every single time."""

    base = browser_worker_url.rstrip("/")

    def _error_detail(r: httpx.Response) -> str:
        # browser-worker turns real Playwright failures (stale ref,
        # disabled field, an overlay/modal intercepting the click,
        # navigation timeout, etc.) into a 422 with Playwright's own
        # message as `detail` — surfaced here as a normal tool result
        # (not a raised exception) so the agent gets a chance to
        # recover: re-snapshot, try a different ref, or recognize a
        # login/sign-up wall and call browser_request_handoff, instead
        # of the whole run hard-failing on an unhandled HTTP error.
        try:
            return str(r.json().get("detail", r.text))
        except ValueError:
            return r.text

    @tool
    async def browser_open(url: str) -> str:
        """Open a URL in a fresh, isolated browser session and return
        its session_id plus the initial accessibility-tree snapshot.
        Pass the returned session_id to every subsequent browser_*
        tool call — one session per open browser tab. Call this ONCE
        per attempt, at the very start. If you need to go to a
        different URL later — including after logging in — use
        browser_goto on your existing session_id instead: a second
        browser_open call creates a brand-new, unrelated session with
        none of your progress on it, not a new tab in the same one.
        Confusing the two live-crashed a run: the agent logged into
        LinkedIn in one session, needed the job posting, called
        browser_open again "to get there," and then could not tell
        which of its two sessions was actually signed in.

        If this application's site was already logged into on a
        previous run, this session starts already authenticated (a
        saved session, restored automatically — you did nothing wrong
        if you don't remember logging in this run). Check the initial
        snapshot for signs you're already signed in (an account menu,
        a logged-out page instead of a login wall) before assuming you
        need to log in at all."""

        # Adrian, direct: "make it in admin page so i can monitor
        # concurrent browser usage" — an opaque label browser-worker
        # just stores and echoes back on GET /sessions, never parses;
        # user_id/application_id are real closure variables here (this
        # whole tool set is built per-application, see
        # build_application_tools's own docstring), the one real
        # identifying context that exists at browser-worker's session
        # layer, which otherwise has none of its own (no DB/user access
        # by design).
        payload: dict = {"url": url, "label": f"user:{user_id}:app:{application_id}"}
        if storage_state is not None:
            payload["storage_state"] = storage_state
        r = await http_client.post(f"{base}/sessions", json=payload)
        if r.is_error:
            return f"error: {_error_detail(r)}"
        data = r.json()
        return f"session_id={data['session_id']}\n\n{data['snapshot']}"

    @tool
    async def browser_goto(session_id: str, url: str) -> str:
        """Navigate this EXISTING session's page to a new URL, keeping
        its cookies and login state — the correct way to move to a
        different page (e.g. the actual job posting) after logging in
        or after ending up somewhere unintended, within the SAME
        session_id. Never call browser_open for this; that creates an
        unrelated, logged-out session instead."""

        r = await http_client.post(f"{base}/sessions/{session_id}/goto", json={"url": url})
        if r.is_error:
            return f"error: {_error_detail(r)}"
        return r.json()["snapshot"]

    @tool
    async def browser_snapshot(session_id: str) -> str:
        """Re-read the current page's accessibility-tree field map
        (ref-annotated) — call this after any action that might change
        the page (navigation, a click that reveals new fields)."""

        r = await http_client.get(f"{base}/sessions/{session_id}/snapshot")
        if r.is_error:
            return f"error: {_error_detail(r)}"
        return r.json()["snapshot"]

    @tool
    async def browser_fill(session_id: str, ref: str, value: str) -> str:
        """Fill a text or textarea field identified by its `ref` from
        the last snapshot. Does NOT work on a native `<select>`
        dropdown — use browser_select for those instead. Returns the
        updated snapshot."""

        r = await http_client.post(f"{base}/sessions/{session_id}/fill", json={"ref": ref, "value": value})
        if r.is_error:
            return f"error: {_error_detail(r)}"
        return r.json()["snapshot"]

    @tool
    async def browser_select(session_id: str, ref: str, label: str) -> str:
        """Choose an option in a native `<select>` dropdown identified
        by its `ref` — `label` is the option's exact visible text, as
        it appears in the snapshot (e.g. "Universitas Indonesia (UI)").
        This is the only correct way to operate a `<select>`:
        browser_fill does not work on one, and its individual `<option>`
        elements never get their own ref to browser_click on — that is
        expected, not a missing capability, so never ask a human to
        open developer tools or run JavaScript for this. Returns the
        updated snapshot."""

        r = await http_client.post(f"{base}/sessions/{session_id}/select", json={"ref": ref, "label": label})
        if r.is_error:
            return f"error: {_error_detail(r)}"
        return r.json()["snapshot"]

    @tool
    def list_credential_labels() -> str:
        """List which stored login credentials are available (e.g.
        "linkedin"), by label only — never the identifier or secret
        itself. Check this before requesting a handoff for a login
        wall: if a matching label exists, use browser_fill_credential
        to log in yourself instead of asking the human."""

        with session_factory() as db:
            labels = [c.label for c in list_credentials(db, user_id=user_id)]
        return ", ".join(labels) if labels else "no stored credentials"

    @tool
    async def browser_fill_credential(session_id: str, ref: str, label: str, field: str) -> str:
        """Fill a login field (username/email or password) from a
        stored credential by its label (see list_credential_labels) —
        `field` is "identifier" or "secret". The actual value is
        decrypted server-side and never appears in your context; this
        tool's result never echoes it, so do not expect to see or
        report the value anywhere. Returns the updated snapshot on
        success, or "error: no stored credential labeled '<label>'" if
        it doesn't exist — in that case, fall back to
        browser_request_handoff rather than asking the human to paste
        a password into chat."""

        with session_factory() as db:
            found = get_secret(db, user_id=user_id, label=label)
        if found is None:
            return f"error: no stored credential labeled '{label}'"
        identifier, secret = found
        value = identifier if field == "identifier" else secret if field == "secret" else None
        if value is None:
            return "error: field must be 'identifier' or 'secret'"
        r = await http_client.post(f"{base}/sessions/{session_id}/fill", json={"ref": ref, "value": value})
        if r.is_error:
            return f"error: {_error_detail(r)}"
        return r.json()["snapshot"]

    @tool
    async def browser_click(session_id: str, ref: str) -> str:
        """Click a non-submit element (checkbox, dropdown option, a
        'next page' control) identified by its `ref`. For the final
        submit control, use `submit_application` instead — it is
        gated for human approval and this tool is not."""

        r = await http_client.post(f"{base}/sessions/{session_id}/click", json={"ref": ref})
        if r.is_error:
            return f"error: {_error_detail(r)}"
        return r.json()["snapshot"]

    @tool
    async def browser_type(session_id: str, ref: str, text: str) -> str:
        """Type into a field one real keystroke at a time, identified
        by its `ref` — a slower fallback for `browser_fill`. Use this
        specifically for an autocomplete/typeahead field (e.g. company
        or location) whose suggestion dropdown does not appear after
        browser_fill: some widgets only react to real keydown events,
        not a direct value set. Always browser_snapshot afterward — a
        suggestion list that appears becomes new clickable elements you
        still need to pick from, this tool does not select one itself."""

        r = await http_client.post(f"{base}/sessions/{session_id}/type", json={"ref": ref, "text": text})
        if r.is_error:
            return f"error: {_error_detail(r)}"
        return r.json()["snapshot"]

    @tool
    async def browser_key_press(session_id: str, key: str, ref: str | None = None) -> str:
        """Press a single key (e.g. "Enter", "Escape", "Tab") —
        Playwright key names, not literal characters. Pass `ref` to
        focus that element first (e.g. "Enter" on a tag/chip input's
        ref to commit the typed value as a tag); omit `ref` to press
        against the page itself (e.g. "Escape" to dismiss a modal that
        is not itself a focusable field). Always browser_snapshot
        afterward — a key press can change the page just like a click."""

        r = await http_client.post(f"{base}/sessions/{session_id}/key", json={"key": key, "ref": ref})
        if r.is_error:
            return f"error: {_error_detail(r)}"
        return r.json()["snapshot"]

    @tool
    async def browser_upload(session_id: str, ref: str, document_type: str) -> str:
        """Upload one of this application's already-rendered documents
        to a file input identified by `ref`. `document_type` is one of:
        cv, cover_letter, answer_pack."""

        doc = document_keys.get(document_type)
        if doc is None:
            return f"error: no rendered '{document_type}' document is available for this application"
        data = await asyncio.to_thread(get_object, doc.key)
        files = {"file": (doc.filename, data, doc.content_type)}
        r = await http_client.post(f"{base}/sessions/{session_id}/upload", params={"ref": ref}, files=files)
        if r.is_error:
            return f"error: {_error_detail(r)}"
        return r.json()["snapshot"]

    @tool
    async def browser_screenshot(session_id: str) -> str:
        """Take a screenshot of the current page state for the audit
        trail (F6.9) — always call this right before requesting a
        human review or handoff, and again after the final submit."""

        r = await http_client.get(f"{base}/sessions/{session_id}/screenshot")
        if r.is_error:
            return f"error: {_error_detail(r)}"
        key = f"applications/{application_id}/screenshots/{uuid.uuid4()}.png"
        await asyncio.to_thread(put_object, key, r.content, "image/png")
        record_screenshot(key)
        return f"screenshot saved: {key}"

    @tool
    async def propose_email_application(to: str, subject: str, body: str) -> str:
        """Call this instead of any browser_* action when the job
        posting turns out to have no online application form at all —
        e.g. the "how to apply" text says to email a CV/cover letter
        directly to an address. `to` is the literal address from the
        posting; `subject` should name the role; `body` should be a
        real, complete cover message built only from the candidate
        info you were given (never fabricate anything not grounded in
        it). This is a terminal action for this attempt: after calling
        it, do not call any more browser_* tools or
        submit_application — there is nothing left to click. The human
        sends the email themselves; attachments are handled manually
        on their end (a mailto: link cannot carry a file), so do not
        claim you attached anything."""

        record_email_draft({"to": to, "subject": subject, "body": body})
        return "email draft recorded. Stop here — no browser action or submit_application call is needed."

    @tool
    async def browser_request_handoff(session_id: str, reason: str) -> str:
        """Hand control of the live browser to the human when you hit
        a captcha, login wall, MFA prompt, or any blocking state you
        cannot resolve yourself. This call always pauses for a human
        — do not attempt to solve a captcha or guess credentials
        yourself. After the human resumes, re-run browser_snapshot
        before continuing; the page state may have changed."""

        return f"handoff requested: {reason}"

    @tool
    async def ask_user(question: str) -> str:
        """Ask the human a specific question when a field is
        unresolvable through form_answer_lookup and the candidate info
        you were given — e.g. a salary expectation or a preference
        only they can state. This call always pauses this run and
        waits for their reply; use it instead of just stating the
        question in your final response and stopping, since that ends
        the run with no way to resume it (the browser session and
        everything filled so far would be lost). After the human
        replies, call form_answer_save with the question and their
        answer so the same question is never asked again, then
        continue the form."""

        return f"question asked: {question}"

    @tool
    async def submit_application(session_id: str, ref: str) -> str:
        """Click the FINAL submit control for this application. This
        is the point of no return — only call this once every field is
        filled and correct. This call always pauses for human approval
        before it actually executes. On success, this already marks
        the application "applied" itself — you do not need to (and
        should not) call application_transition afterward."""

        r = await http_client.post(f"{base}/sessions/{session_id}/click", json={"ref": ref})
        if r.is_error:
            return f"error: {_error_detail(r)}"
        # Deliberately not left for a follow-up application_transition
        # call: a real run clicked submit for real (this exact
        # snapshot proved it — LinkedIn's own "Your application was
        # sent" confirmation), then the next turn transitioned the
        # Application to "preparing" instead of "applied" (the state
        # machine doesn't even allow a direct discovered -> applied
        # hop, which the model likely hit and improvised past) — the
        # attempt then closed out as "abandoned" despite a genuine
        # success. This is the same "assert a fact about the real
        # world happened" case F9.3's manual mark-as-applied exists
        # for, not a normal workflow hop to validate, so it goes
        # through the same bypass rather than trusting a second LLM
        # decision to get the exact right enum value.
        with session_factory() as db:
            application = db.get(Application, application_id)
            if application is not None:
                try:
                    mark_applied(
                        db,
                        application=application,
                        actor=EventActor.AGENT.value,
                        event_type="state_changed",
                        note="submit_application executed after human approval",
                    )
                except MarkAppliedError as exc:
                    db.rollback()
                    return f"submitted, but could not mark applied: {exc}. {r.json()['snapshot']}"
                db.commit()
        return "submitted and marked applied: " + r.json()["snapshot"]

    @tool
    def form_answer_lookup(question: str) -> str:
        """Check this persona's reusable answer memory for a question
        semantically similar to one already answered before (F6.3's
        first resolution step). Returns 'no prior answer found' if
        nothing close enough exists yet."""

        answer = lookup_form_answer(
            session_factory,
            user_id=user_id,
            persona_id=persona_id,
            question=question,
            embeddings_client=embeddings_client,
            provider=embeddings_provider,
        )
        return answer if answer is not None else "no prior answer found"

    @tool
    def form_answer_save(question: str, answer: str) -> str:
        """Save a question/answer pair to this persona's reusable
        answer memory — call this every time a human answers an
        unresolvable field via an interrupt, so the same question is
        never asked twice."""

        save_form_answer(
            session_factory,
            user_id=user_id,
            persona_id=persona_id,
            question=question,
            answer=answer,
            embeddings_client=embeddings_client,
            provider=embeddings_provider,
            source_application_id=application_id,
        )
        return "saved"

    @tool
    def application_transition(new_state: str, note: str = "") -> str:
        """Move this application to a new pipeline stage (F7.2). Each
        user has their own customizable list of stage names — a common
        one is 'applied' (e.g. immediately after a successful
        submit_application), but don't assume it always exists; if the
        stage name you pass isn't one of this user's own defined
        stages, this returns an error string naming the actual valid
        options instead of applying anything."""

        with session_factory() as db:
            application = db.get(Application, application_id)
            if application is None:
                return f"error: application {application_id} not found"
            try:
                transition(db, application=application, new_state=new_state, actor=EventActor.AGENT.value, note=note)
            except TransitionError as exc:
                db.rollback()
                return f"error: {exc}"
            db.commit()
        return f"transitioned to {new_state}"

    return [
        browser_open,
        browser_goto,
        browser_snapshot,
        browser_fill,
        browser_select,
        browser_click,
        browser_type,
        browser_key_press,
        browser_upload,
        browser_screenshot,
        list_credential_labels,
        browser_fill_credential,
        propose_email_application,
        browser_request_handoff,
        ask_user,
        submit_application,
        form_answer_lookup,
        form_answer_save,
        application_transition,
    ]
