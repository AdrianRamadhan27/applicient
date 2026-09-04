# Bulk Apply Queue — Plan

> **Status: proposed, not yet implemented.** Written 2026-09-04 in response to Adrian's request for a sequential/queued bulk "run agent" across multiple Pipeline applications. Nothing in this doc has been built — treat it as a design reference for when this is picked up.

## Context

Today the application-agent ("Run agent" on the Pipeline board) runs on exactly one `Application` at a time — a per-application panel drives one SSE stream, one `ApplicationAttempt`. Adrian wants to select several jobs from the Pipeline board and have the agent work through them **one after another, automatically** ("not parallel but sequential/queue so go from job to jobs") — without having to sit there and manually click "Run agent" on each one in turn.

Two things confirmed directly with Adrian before finalizing this plan (via `AskUserQuestion`):

1. **L2 "fill & review" pause behavior**: `build_application_agent`'s `interrupt_on` gate (`agents/src/applicient_agents/application_agent.py`) always pauses before a real submit unless autonomy is `l3_fill_submit` — this is baked into the agent itself, not something a queue can bypass. When a queued job hits that pause, **the queue auto-advances to the next job** and leaves the paused one sitting in `awaiting_review` (exactly like a single run left un-reviewed today) — Adrian reviews/approves each one afterward from the board. This is what makes "go from job to job" actually unattended instead of requiring him to babysit every L2 submission.
2. **Durability**: the queue itself must be **backend-persisted** — it keeps advancing job to job even if the Pipeline tab is closed or the laptop sleeps, not just something that resumes if the tab stays open. (An individual attempt already keeps running server-side regardless of the HTTP connection — confirmed via `application_service.py`'s own docstring and the existing `pollApplicationAttemptEvents` reconnect path; this plan extends that same durability to the "start the *next* queued job" step.)

Research (via an Explore agent) confirmed the backend has **zero concurrency limiter** on `start_application_attempt` — nothing stops calling it for a second `application_id` before the first's stream finishes; `application_agent.py` even has a comment anticipating "concurrent attempts (bulk apply, F6.11)". The "sequential, not parallel" constraint is entirely a product/orchestration choice this plan implements, not a backend limitation being worked around. `browser-worker` independently caps at 20 concurrent Chromium contexts (`MAX_CONCURRENT_SESSIONS`), well above what a sequential queue will ever need at once (exactly one).

## Design

### Data model — a real queue, not just orchestration state

New tables in `api/src/applicient_api/models/pipeline.py`, right next to `Application`/`ApplicationAttempt`, same `UUIDPKMixin`/`TimestampMixin` style:

```python
class ApplyQueue(UUIDPKMixin, TimestampMixin, UserScopedMixin, Base):
    __tablename__ = "apply_queues"
    persona_id: Mapped[uuid.UUID]  # FK personas.id, CASCADE
    status: Mapped[str]  # queued | running | paused | completed | cancelled
    started_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]

class ApplyQueueItem(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "apply_queue_items"
    queue_id: Mapped[uuid.UUID]        # FK apply_queues.id, CASCADE
    application_id: Mapped[uuid.UUID]  # FK applications.id, CASCADE
    position: Mapped[int]              # queue order
    status: Mapped[str]  # queued | running | done | awaiting_review | failed | skipped | cancelled
    attempt_id: Mapped[uuid.UUID | None]  # FK application_attempts.id, SET NULL — set once the item actually runs
    error: Mapped[str | None]
    started_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]
```

One migration creates both tables.

### Driver — a thin sequencer around the EXISTING single-attempt code, zero duplication

New `agents/src/applicient_agents/apply_queue_service.py`, mirroring `application_service.py`'s own established shape (module-level in-memory registries for the live coordination, same disclosed limitation style as `_ACTIVE_ATTEMPTS`/`_CANCEL_EVENTS`):

```python
_ACTIVE_QUEUE_TASKS: dict[uuid.UUID, asyncio.Task] = {}
_QUEUE_CANCEL_EVENTS: dict[uuid.UUID, asyncio.Event] = {}
```

- `create_apply_queue(session_factory, *, user_id, persona_id, application_ids) -> (ApplyQueue, excluded: list[{application_id, reason}])` — validates each application up front (owned by user; `Job.apply_url` set; `autonomy_level != "l0_manual"`; no attempt currently `in_progress`/`awaiting_*` for it already) — mirrors the exact checks `start_application_attempt` already makes, just applied before creating items instead of failing mid-drive. Only eligible ones become `ApplyQueueItem` rows (`status="queued"`, in board order); ineligible ones are reported back, never persisted.
- `start_apply_queue_driver(queue_id, user_id, session_factory)` — `asyncio.create_task(run_apply_queue(...))`, stored in `_ACTIVE_QUEUE_TASKS` (a strong reference so it isn't garbage-collected once the HTTP request that spawned it returns).
- `run_apply_queue(session_factory, *, queue_id, user_id)` — the actual loop. For each `queued` item in position order (re-querying the DB each iteration, not a cached list, so a `cancel` request lands immediately): pre-flight `credit_ledger.insufficient_credits_message(...)` for `FEATURE_APPLICATION_APPLY` — if insufficient, mark this item **and every remaining queued item** `skipped` with that message and stop (no point burning through the rest, they'll all fail the same check). Otherwise mark the item `running`, then:
  ```python
  async for _event in start_application_attempt(session_factory, application_id=item.application_id, user_id=user_id):
      pass  # already persisted via RunEvent inside start_application_attempt itself — nothing to do with it here
  ```
  This is the entire integration point — the queue never re-implements apply logic, credit charging, document resolution, or interrupt handling; it just drains the exact same generator `POST /applications/{id}/apply` already drives, to whatever natural stopping point it reaches (`done`, `interrupt`, `error`, `cancelled`). After draining, re-read the just-created `ApplicationAttempt` (latest for that `application_id`) and map its terminal DB status onto the item (`submitted`→`done`, `awaiting_review`/`awaiting_handoff`/`awaiting_email`→`awaiting_review`, `failed`/`cancelled`→ same). If no attempt row was ever created (an early exit like "no apply_url" slipping through, or a `TierResolutionError`), capture the last SSE event's message as `item.error` and mark `failed`.
  Checks `_QUEUE_CANCEL_EVENTS[queue_id]` between items (not mid-attempt — the in-flight one always finishes naturally, same "cooperative, next checkpoint" discipline `radar.py`/`orchestrator_service.py` already use for their own cancel buttons); on cancel, marks every remaining `queued` item `cancelled` and stops.
  `finally`: sets `ApplyQueue.status` to `cancelled` (if cancel was requested) or `completed` (nothing left `queued`) or `paused` (shouldn't normally happen here — `paused` is reserved for the restart-reconciliation path below), clears both registries for this `queue_id`.
- `request_cancel_queue(queue_id) -> bool` — sets the event, same shape as `application_service.request_cancel`.
- `resume_apply_queue_driver(queue_id, user_id, session_factory)` — for a `paused` queue: just calls `start_apply_queue_driver` again: the loop's own re-query-for-"queued" logic naturally picks up wherever it left off.
- `reconcile_stale_apply_queues(session_factory)` — boot-time, called from `main.py` **right after** the existing `reconcile_stale_attempts(...)` (order matters: that pass has already flipped any orphaned `in_progress`/`awaiting_*` `ApplicationAttempt` to `failed` by the time this runs). Any `ApplyQueue` still `running` (its driver task died with the old process) gets set to `paused`; any of its items still `running` gets its status re-derived from its now-reconciled attempt (almost always `failed`, "interrupted by a server restart"). Honest and consistent with `reconcile_stale_attempts`'s own existing discipline — no attempt to magically resume mid-drive state, just a clean, resumable pause point. A "Resume queue" action in the UI continues it.

### API surface

New `api/src/applicient_api/routers/apply_queue.py` (kept separate from the already-521-line `routers/applications.py`), registered in `main.py` alongside the other routers:

- `POST /applications/apply-queue` — body `{persona_id, application_ids: [uuid, ...]}` (board order) → `create_apply_queue` + `start_apply_queue_driver`. Returns `{queue, items, excluded}` — `excluded` is what lets the confirm dialog say *why* 2 of the 8 selected jobs won't run.
- `GET /applications/apply-queue/active?persona_id=` — the current user's `queued`/`running`/`paused` queue for that persona, or `null`. Backs reconnect-on-page-load.
- `GET /applications/apply-queue/{queue_id}` — full current state (queue + items, each item's `application_id` joined to `Job.title`/`company_name_raw` for display without N follow-up requests).
- `POST /applications/apply-queue/{queue_id}/cancel` — `request_cancel_queue`; if no live task is registered (process restarted), falls straight to marking remaining `queued` items `cancelled` and the queue `cancelled`, same two-branch shape `cancel_attempt` already uses for the single-attempt case.
- `POST /applications/apply-queue/{queue_id}/resume` — only valid when `status == "paused"`.

No changes to `require_credits`/`rate_limit` on the existing `/apply` route — the driver calls `start_application_attempt` directly (same bypass `orchestrator_tools.py`'s `run_application_agent` tool already uses today), so the per-item credit check happens via the driver's own pre-flight `insufficient_credits_message` call instead.

### Frontend

- `web/src/lib/api.ts` — types `ApplyQueue`, `ApplyQueueItem` (mirroring the backend shapes above, items carrying `job_title`/`company_name` for display), functions `createApplyQueue`, `getActiveApplyQueue`, `getApplyQueue`, `cancelApplyQueue`, `resumeApplyQueue`.
- `web/src/app/console/pipeline/page.tsx`:
  - New `selectedIds: Set<string>` state on the board (same pattern as Job Inbox's own bulk-select, `inbox/page.tsx`) — a checkbox on each card's top-left corner (`stopPropagation` so it doesn't also open the detail panel), and a selection toolbar next to the existing header buttons ("N selected · Run agent · Clear") that appears once non-empty.
  - New `web/src/components/bulk-apply-dialog.tsx` — on "Run agent" with a selection: a client-side pre-filter using data the board already has loaded (`autonomy_level`, whether the underlying job has an `apply_url`) to show likely-excluded jobs immediately with no round trip, plus a credit estimate (`N_eligible × feature cost` from the already-existing `/billing/feature-costs` fetch, compared against the sidebar's live balance) — then "Start queue" calls `POST /applications/apply-queue`, which re-validates authoritatively and returns the real `excluded` list, and immediately opens the live queue view.
  - New `web/src/components/apply-queue-panel.tsx` — ordered list of items with live status badges (queued/running/awaiting review — clickable straight into the existing `ApplicationDetailPanel` for that application/done/failed/skipped/cancelled), a "Stop queue" button, a "Resume queue" button when `paused`. Polls `getApplyQueue(id)` every 2s while `queued`/`running` — same interval `pollApplicationAttemptEvents` already established for the single-attempt reconnect path.
  - A `useEffect` on mount calls `getActiveApplyQueue(personaId)`; if one exists, shows a compact persistent banner in the page header ("Applying: 3/8 · view queue") even before the panel is opened, and opens the panel automatically — same reconnect-on-load discipline as the existing per-application `reconnectedForRef` effect.

### What this deliberately does NOT touch

`application_service.py`'s single-attempt code (`start_application_attempt`, `resume_application_attempt`, `request_cancel`, `_drive_graph`, the `interrupt_on` gate itself) — the queue driver calls it as a black box and changes nothing about it. The per-application "Run agent" button, live-browser view, and review/approve flow in `ApplicationDetailPanel` keep working exactly as they do today, queue or no queue.

## Critical files

- `api/src/applicient_api/models/pipeline.py` — new `ApplyQueue`, `ApplyQueueItem`
- New migration for `apply_queues`/`apply_queue_items`
- New `agents/src/applicient_agents/apply_queue_service.py` — the driver (reuses `application_service.start_application_attempt` directly)
- New `api/src/applicient_api/routers/apply_queue.py` — the 5 endpoints above; registered in `main.py`
- `api/src/applicient_api/main.py` — add `reconcile_stale_apply_queues(get_session_factory())` right after the existing `reconcile_stale_attempts(...)` call
- `web/src/lib/api.ts` — new types + client functions
- `web/src/app/console/pipeline/page.tsx` — multi-select board state, selection toolbar
- New `web/src/components/bulk-apply-dialog.tsx`, `web/src/components/apply-queue-panel.tsx`

## Verification

1. Select 3 applications on the board (mix in one `l0_manual` one) → "Run agent" → confirm the dialog shows 2 eligible / 1 excluded with a reason, plus a credit estimate.
2. Start the queue; confirm via direct DB check that only one `ApplicationAttempt` is ever `in_progress` at a time across the queue's items; confirm an L2 item pausing at `awaiting_review` doesn't block the next item from starting.
3. Close the Pipeline tab entirely mid-queue; reopen later; confirm progress advanced while the tab was closed (proves server-side durability, not just tab-open resilience).
4. Drain a test user's balance to cover exactly 1 of 3 queued items; confirm item 1 succeeds and charges, items 2-3 land as `skipped — insufficient credits`, and the queue stops cleanly rather than erroring loudly.
5. Restart the API mid-queue; confirm `reconcile_stale_apply_queues` marks the queue `paused` (not lost) and the in-flight item `failed`; confirm "Resume queue" continues correctly from the next still-queued item.
6. Click "Stop queue" mid-run; confirm the active item finishes naturally, no further items start, queue settles to `cancelled` with the rest marked `cancelled`.
7. Confirm the existing single "Run agent" button, cancel, and review flow on `ApplicationDetailPanel` are completely unchanged in behavior.
