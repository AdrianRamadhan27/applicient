# Applicient — M5 Implementation Checklist

Working checklist for M5 — Radar & Inbox. Check items off as they're done; update the **Status** line at each step when something changes. See [PRD.md](PRD.md) for the requirements (F8 email intelligence, F10 scheduling) and decisions this is built from.

**Status:** Built and live-verified against a real Gmail account, real Postgres, and the real deployed containers. Real auth (email+password signup/login, replacing the hardcoded demo-user lookup every prior milestone used) shipped as a prerequisite — nothing in F8/F10 makes sense per-user without it. Two deliberate architecture deviations from the original PRD design were made mid-build, both at Adrian's explicit direction (see §5 and the Log): F8.2's "only read a manually-labeled Gmail folder" was replaced with a keyword-prefiltered full-inbox scan, and the fixed 13-value `ApplicationState` enum (F7.2) became fully user-customizable pipeline stages — a scope addition beyond M5's own brief, done here because the trigger for it (an "illegal transition" bug in real classified email data) surfaced during this milestone's own live testing. F10.4 (budget-cap enforcement) is the one requirement deliberately not built this pass. See the Log for exact dates and the real infra bugs hit along the way (Gmail API not enabled on the GCP project, missing OAuth scopes, missing env passthroughs in `docker-compose.yml`).

**Housekeeping note:** [IMPLEMENTATION.md](IMPLEMENTATION.md)'s status table is stale as of this writing — it still lists M4 "Planned" and M5 "Not started." Both are substantially complete; fixing the index is part of this milestone's own close-out, not deferred.

---

## Scope

M5 closes PRD F8 (email intelligence and notifications) and F10 (scheduling and the standing radar). F10's `SavedSearch`/`Source`/radar-run machinery already existed from M1/M2 — what M5 adds is the actual **scheduler** that fires it unattended, plus everything Gmail-shaped: OAuth connection, ingestion (push + poll), classification, matching, state-transition proposals, notifications, and `.ics` export.

**Explicitly out of scope, deferred to a later milestone:** F9 (already-applied ledger CSV/JSON import) — M6's job per the roadmap, though F9.3 (manual mark-as-applied) shipped back in M4 as a side effect of the Pipeline board. Email/Telegram/Discord notification channels — `Notification.channel` supports the values, only `in_app` is actually sent. A dedicated Live Browser-style rich review screen for email review — the review queue is a flat list with approve/reject, not a purpose-built UI.

## 1. Real auth (prerequisite, not in the original M5 brief)

- [x] `routers/auth.py` — `POST /auth/signup`, `POST /auth/login`, `GET /auth/me`. Bcrypt password hashing (`auth.py`), 7-day bearer JWTs, no refresh token, no server-side revocation list (logout is client-side token drop only).
- [x] Every router migrated off the old hardcoded demo-user lookup onto `Depends(current_user_id)` reading the real bearer token.
- [x] `web/src/app/login`, `web/src/app/signup` — real pages, not stubs.
- [x] `signup()` provisions a new user's default pipeline stages (see §6) as part of account creation, not a separate onboarding step.

## 2. Scheduler (F10)

- [x] `scheduler.py` — in-process `AsyncIOScheduler` (APScheduler) embedded in the `api` service. Chosen over standing up a separate scheduler container since none existed yet in the running stack and every other "worker" responsibility in this codebase already runs in-process (radar.py, scoring_service.py, tailoring_service.py) — consistent with that pattern, not a new one.
- [x] F10.1 — cron-style schedules per saved search. `schedule_saved_search`/`unschedule_saved_search` add/remove an APScheduler job keyed by `saved-search:{id}`; `start_scheduler`'s own reconciliation pass re-adds a job per active, cron-having `SavedSearch` on every process start, since APScheduler's default jobstore has no cross-restart persistence of its own.
- [x] F10.2 — each scheduled run calls the same `run_radar_search` the manual "Run" button uses; "new since last run" is inherent to that path already (dedup against everything seen, per M1/M2), not a separate mechanism.
- [x] F10.3 — idempotent/resumable: inherited from the existing radar-run machinery (M1/M2), unchanged by this milestone.
- [ ] F10.4 — budget-cap enforcement. **Deliberately not built.** `Budget` rows exist in the schema but nothing reads them anywhere in this codebase; wiring real spend enforcement is scoped-out follow-up work, stated in `scheduler.py`'s own docstring rather than silently skipped.
- [x] F10.5 — daily digest (`_daily_digest`, cron at 08:00 UTC). Thresholded: a day with no new jobs, no strong matches, and no approaching deadlines writes zero notifications ("quiet days stay quiet"), not a content-free daily ping.
- [x] Gmail polling (`_poll_all_gmail_connections`, every 5 minutes) and watch renewal (`_renew_expiring_watches`, hourly, renews any Pub/Sub watch expiring within 24h) — both scheduler-owned, both part of F8.1's "two ingestion adapters" story (§3).
- [x] **Radar UI gap closed in this pass**: `schedule_cron` existed on the `SavedSearch` model and the scheduler read it, but neither `SavedSearchCreate`/`SavedSearchUpdate` (`schemas.py`) nor the Radar page's create/edit dialog exposed it — a saved search could only ever be run manually. Added `schedule_cron` to both schemas (with server-side `CronTrigger.from_crontab` validation, 422 on a bad expression), the router's create/update paths, `web/src/lib/api.ts`'s `createSavedSearch`/`updateSavedSearch`, and a real field + preset buttons (hourly / every 6h / daily 8am / weekdays 8am) + a raw-cron free-text input in `radar/page.tsx`'s saved-search dialog, plus a `scheduled: <cron>` / `manual only` badge on each saved-search row. Live-verified against the real deployed API: invalid cron → 422, valid cron persists and round-trips, clearing it via update works, no leftover test data.

## 3. Gmail connection and ingestion (F8.1)

- [x] `gmail_service.py` — OAuth authorize URL, code exchange, `GMAIL_SCOPES = "openid email profile https://www.googleapis.com/auth/gmail.readonly"` (the `openid email profile` part was a real fix mid-build — Google's `userinfo` endpoint 401s a token carrying only `gmail.readonly`), watch start/renewal/stop via `users.watch()`.
- [x] `routers/gmail.py` — `/connect` (redirects to Google), `/callback` (unauthenticated by necessity; carries the signed-in user through the OAuth `state` param as a short-lived JWT, not a session cookie), `/connections` CRUD including the new `scan_window_days` PATCH.
- [x] Two ingestion adapters behind one interface, both real: `_poll_all_gmail_connections` (scheduler-driven, exercised continuously in local dev) and `routers/webhooks.py`'s `POST /webhooks/gmail` (Pub/Sub push, OIDC-bearer-token-verified against `GMAIL_PUSH_ENDPOINT_URL` — real verification, not payload-trusting; inert on localhost by nature, since Pub/Sub push requires a public HTTPS endpoint).
- [x] A latent bug caught before ever being exercised: `start_watch`'s original `labelIds: []` + `labelFilterAction: "include"` would have meant "watch for changes to these (zero) labels" — i.e. never fire. Fixed by omitting both params, so the watch covers the whole mailbox (still scope-bounded by the OAuth grant itself, which is read-only).
- [x] `GmailConnection.scan_window_days` (default 7, user-editable via 1/3/7/14/30-day dropdown in `credentials/page.tsx`) bounds every scan by recency (`newer_than:{days}d` in the Gmail search query) — replaced an earlier flat `maxResults` cap per explicit user direction ("i dont want it to be capped my max message but with like date... past 1, past 3, past 7 days").

## 4. Classification, matching, extraction, transitions (F8.3-F8.6)

- [x] `email_ingestion.py` — `_process_message` runs one ingested message through: LLM classification (confirmation / rejection / interview invite / assessment / offer / recruiter outreach / scheduling / information request / irrelevant), application matching (by company/role/thread/reference — unmatched messages land in the review queue rather than being dropped or guessed, per F8.4), extraction (date/time/timezone/meeting link/interviewer/deadline, F8.5), and a confidence-gated proposed transition (F8.6): high confidence applies via `pipeline_service.transition` directly, low confidence sets `review_needed=True` for `routers/email_messages.py`'s `confirm-transition` endpoint.
- [x] `EmailClassification.IRRELEVANT` short-circuits immediately (record + `processed_at`, no match/review-queue entry) — necessary once ingestion became keyword-broad enough to legitimately see unrelated inbox mail (promos, LinkedIn digests). Live-tested against real inbox noise and correctly classified/excluded.
- [x] `web/src/app/email-review/page.tsx` — the F8.4/F8.6 review queue UI: approve/reject a proposed transition, matched-application context shown inline.

## 5. Real architecture deviation: keyword prefilter, not label-gating (F8.2, revised)

The PRD's original F8.2 called for scoping Gmail access to a single user-created label (`Applicient`), enforced in code so the full inbox is never queried. That was built first, then explicitly rejected once live-tested: *"Hmm no, i want it to read any email that contains application keywords automatically — so via regex or what: classify the email -> then give to llm if it is about application."*

- [x] Replaced with `_KEYWORD_QUERY` in `email_ingestion.py` — a broad OR-list of application-related terms (plus `-in:spam -in:trash`) executed server-side by Gmail's own search, combined with `newer_than:{scan_window_days}d` (§3). This is a free, zero-LLM-cost prefilter: it determines which messages are even fetched, before the real (billed) LLM classification step runs on survivors. `label_name` on `GmailConnection` is now vestigial, documented as such rather than silently dead.
- [x] Cost implication discussed and resolved with Adrian directly: Gmail API calls are free/quota-based regardless of scan breadth; the LLM classification calls on survivors are the real, metered cost — unchanged by this design, since the keyword prefilter's whole purpose is keeping that survivor set small.

## 6. Real architecture deviation: customizable pipeline stages (beyond F7.2's original scope)

Not in M5's original brief. Surfaced directly from M5's own live testing: a real interview-invite email tried to move an application from `applied` straight to `interview`, and the hardcoded `ALLOWED_TRANSITIONS` graph (F7.2's fixed 13-state enum, modeling a human's own step-by-step flow) rejected it as an "illegal transition." A first fix (BFS multi-hop pathfinding, `find_transition_path`/`transition_via_path`) was built and worked, then was superseded when Adrian asked for something larger: *"Actually yeah I want the list of states of the application to be customizable by the user"* — reorder/rename/add/remove, with permissive (any-stage-to-any-stage) transitions rather than a full custom transition-graph editor, per his own explicit choice between the two.

- [x] New `PipelineStage` model/table — immutable `key` (what automation compares against) split from user-editable `display_name`, so renaming never touches anything automation depends on. Migration backfills every existing user with the original 13 states as their starting list.
- [x] `pipeline_stage_service.py` — full CRUD, `create_stage`'s slugify+dedupe key generation, `delete_stage`'s in-use block (`StageInUseError`, 409, names the exact count of applications still on that stage — this is what keeps `Application.state` from ever orphaning), `reorder_stages`.
- [x] `pipeline_service.transition()` rewritten from graph-reachability to flat membership against the target user's own live stage keys — any two of a user's stages now transition directly, no pathfinding needed. `ALLOWED_TRANSITIONS`/`find_transition_path`/`transition_via_path` removed entirely as a result — the multi-hop fix's job is now done by permissive transitions instead.
- [x] Three real provisioning call sites wired: `signup()`, `seed.py`'s demo user, and the migration's own backfill for pre-existing users.
- [x] `email_ingestion.py`'s classification→state mapping degrades gracefully if a well-known key (e.g. `applied`) has been deleted by the user: the proposed transition is nulled out rather than writing a review-queue entry structurally guaranteed to 409 on confirm.
- [x] `web/src/app/pipeline/page.tsx` — kanban renders one column per the user's real stages (no more "7 of 13 states get columns" quirk), a "Manage Stages" dialog (add/inline-rename/delete/reorder via up/down chevrons, no drag-and-drop library added — none exists anywhere in this codebase).
- [x] Live-verified end to end against the real deployed containers post-rebuild: demo user's 13 stages round-trip through the real API with the correct original keys.

## 7. Notifications and calendar export (F8.7/F8.8)

- [x] `notification_service.py` — `Notification.channel` always `in_app` this pass; email/Telegram/Discord deferred, schema already supports the values.
- [x] Notifications fire on: interview invitations, assessments/psychotests, approaching deadlines (`_approaching_deadline_messages`, 3-day lookahead, deduped by checking for an existing notification already pointed at that email — best-effort `dateutil` parsing of the LLM-extracted free-text deadline, silently skips anything unparseable rather than surfacing a false deadline), offers, and the daily digest (§2).
- [x] `web/src/app/notifications/page.tsx` — list, mark-read.
- [x] F8.8 — `.ics` generation (`ics_export.py`, `GET /email-messages/{id}/ics`), download-on-demand rather than an auto-attached external calendar sync (no such integration exists or was asked for).
- [x] F8.9 — never sends email on the user's behalf: trivially satisfied, no send-email tool or endpoint exists anywhere in this codebase.

## 8. Reliability and exit verification

- [x] Every live test against real data (the demo user's real applications, disposable signup-created test users, synthetic `EmailMessage`/`ApplicationEvent`/`Notification`/`PipelineStage` rows) was cleaned up immediately after, confirmed via follow-up queries.
- [x] Real infra bugs hit and fixed, not worked around: Gmail API not enabled on the GCP project (403 `SERVICE_DISABLED`, fixed via the activation URL Google's own error provided); missing `openid email profile` scopes (§3); `docker-compose.yml` silently missing `GMAIL_REDIRECT_URI`/`GMAIL_PUBSUB_TOPIC`/`FRONTEND_URL`/`DEMO_USER_PASSWORD` passthroughs to the `api` service, caught after `/gmail/connect` returned a raw `RuntimeError` traceback.
- [x] `tsc --noEmit` clean on every touched frontend file; Python syntax/import checks clean on every touched backend file.
- [x] Migration applied and verified against the real Postgres container (`scan_window_days`, `pipeline_stages` table + backfill) — confirmed exact expected row counts/keys for the demo user.
- [x] Full rebuild and redeploy of `api`/`web` Docker images, all 6 containers (`api`/`web`/`browser-worker`/`redis`/`postgres`/`minio`) confirmed healthy post-deploy, `/health` returns `{"status":"ok"}`.

---

## Log

Short entries only — what changed, what's next, anything worth remembering. Newest first.

- **2026-08-31** — Closed the one real functional gap left in F10: `schedule_cron` existed end-to-end on the backend (model, scheduler) but had no CRUD path or UI to ever set it. Added it to `SavedSearchCreate`/`Update` with server-side cron validation, wired it through `api.ts`, and added a real schedule field (presets + free-text cron) plus a per-row status badge to the Radar page's saved-search dialog. Live-verified against the real deployed API (invalid cron 422s, valid cron round-trips, clearing works, no leftover test data). Wrote this file — M5 had been substantially built across several real, explicit user-driven iterations (dummy-email testing → Gmail API/scope bugs → the F8.2 label-gating→keyword-prefilter reversal → the `scan_window_days` date-window request → the "illegal transition" bug → the resulting customizable-pipeline-stages feature) without ever getting its own checklist file, unlike every other milestone in this repo. `IMPLEMENTATION.md`'s status table was also stale (M4 "Planned"/M5 "Not started") and is being corrected alongside this.
