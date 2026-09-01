"""M1 §3 — the radar-run orchestrator: expand each role title, fan out
to every source the saved search selects, normalize+dedup each
result, isolate per-source failures so one broken source never kills
the run, and stream progress the same way cv.py streams CV parsing —
each event ties to a real code boundary, and the per-source outcome is
persisted as an AgentStep so the trace survives after the stream
closes.

Precondition checks (confirmed profile, active persona, saved-search
ownership) happen in the route handler before streaming starts, same
reasoning as cv.py: a bad/unauthorized ID should get a real HTTP
error, not a 200 with an error event baked into the stream. This
generator assumes they already hold.

Query expansion and adapter search are both `await`ed directly, not
`to_thread`'ed uniformly: `SourceAdapter.search()` is genuinely
`async def` (httpx.AsyncClient-based, like the M1 §2 adapters), so
awaiting it doesn't block the loop — only the query-expansion LLM call
is a blocking LangChain `.invoke()`, and that one specifically goes
through `to_thread`, same fix as cv.py's SSE bug.

Both of those are bounded-concurrent, not sequential, within a source
(raised directly by Adrian: "inference time is a metric we have to
tackle by doing concurrent runs" — see [[feedback_parallelize_inference]]
in memory) — every role title's query expansion runs at once
(`asyncio.gather`, each worker opening its own DB session via
`session_factory`, since `resolve_tier`'s reads aren't safe to share
across threads), and every (role_title, query) pair's `adapter.search()`
call runs with bounded concurrency (`_SEARCH_CONCURRENCY`, deliberately
smaller than the scoring cap — see its own comment on why). What's
deliberately NOT parallelized: `normalize_and_upsert` itself, which
always runs strictly sequentially in this one coroutine after a batch
of concurrent fetches completes — its canonical_key lookup is a
check-then-insert, and two concurrent writers racing on the same key
could each insert a duplicate canonical Job. Fetch concurrently, write
serially — not "everything concurrently."

After every selected source has run, jobs touched this run that are
still missing `description_embedding` are embedded in bounded batches
(job_embedding.py) through the `embedding` tier — same to_thread
treatment as query expansion, same "don't discard what's already real"
discipline if the tier isn't configured. Ghost/staleness signals
(repost_count, ghost_job_score/reasons) are computed inline by
normalization.py itself, not here — see its module docstring.

Every `adapter.search()` call is wrapped in `run_with_live_logs`
(live_logs.py), which streams a "log" SSE event for every real Python
`logging` line the adapter (or a library it calls, like JobSpy)
produces while it runs — raised directly by Adrian after a JobSpy
run stalled for minutes with the actual diagnostic detail
(Glassdoor/ZipRecruiter errors) sitting only in the server's own log
file, invisible from the GUI.

Finally, every touched job not already scored for the run's exact
(persona, profile_revision) pair gets the two-stage fit-scoring pass
(scoring_service.py: fast-tier prefilter, then balanced-tier full
rubric for whatever survives it) — bounded per run
(`_MAX_JOBS_TO_SCORE_PER_RUN`), same "cap it, don't let one run
explode" discipline as query expansion and embedding batching, and
run with bounded concurrency (`_SCORING_CONCURRENCY`) for the same
reason as query expansion/search above — `scoring_service.score_job`
owns its whole session internally (opened via `session_factory`,
never shared) specifically so this is safe to do.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from asyncio import to_thread
from datetime import datetime, timezone
from typing import Any, AsyncGenerator

from sqlalchemy.orm import sessionmaker

from applicient_api import schemas
from applicient_api.job_embedding import embed_jobs
from applicient_api.live_logs import run_with_live_logs
from applicient_api.models.agents import AgentRun, AgentStep, RunEvent
from applicient_api.models.discovery import Job, SavedSearch, Source, SourceRun
from applicient_api.models.llm import LlmCall
from applicient_api.models.profile import Persona, Profile
from applicient_api.models.scoring import PrefilterResult
from applicient_api.normalization import normalize_and_upsert
from applicient_api.query_expansion import expand_role_title
from applicient_api.scoring_service import score_job
from applicient_api.source_connections import resolved_config
from applicient_api.tier_resolution import TierResolutionError, active_model_profile, resolve_embedding_tier, resolve_tier
from applicient_sources import get_adapter

# M1 §5 — bounded on purpose, same reasoning as the query-expansion
# budget and job-embedding batching: two real LLM calls per job (fast
# prefilter + balanced rubric for survivors) adds up fast across a
# real backlog (Adrian's own saved search had 51 already-discovered
# jobs the first time this ran). Unscored jobs beyond the cap are
# simply picked up on a later run — same structural checkpointing as
# embedding, not a hard limit on ever scoring them.
_MAX_JOBS_TO_SCORE_PER_RUN = 20

# Bounded, not unbounded — enough to genuinely parallelize (8 jobs
# sequentially took several minutes; concurrently, wall-clock time is
# roughly bounded by the slowest single job instead of the sum of all
# of them) without hammering a free-tier provider's own rate limits
# hard enough to trigger 429s.
_SCORING_CONCURRENCY = 4

# Deliberately smaller than _SCORING_CONCURRENCY: search calls hit a
# real third-party source (Greenhouse/RemoteOK/JobSpy/...), each with
# its own rate limits, and each SourceAdapter.search() call builds a
# fresh, independent rate limiter internally (confirmed by reading
# every adapter — no shared state across calls), so N concurrent calls
# effectively means N independent rate-limit budgets active at once,
# not N/one-shared-budget. Kept conservative so this doesn't
# effectively multiply a source's real request rate past what it
# actually tolerates.
_SEARCH_CONCURRENCY = 3


def _event(event_type: str, **data: Any) -> dict:
    return {"event": event_type, "data": json.dumps(data, default=str)}


# Cancel button — cooperative, not `Task.cancel()`. This generator's
# execution is driven by whatever internal task EventSourceResponse
# uses to iterate it; a cancel action lives in a completely different
# HTTP request and has no direct handle on that task, only the run's
# id. A plain in-memory registry mapping id -> a flag the generator
# itself checks at safe points (between sources, between scoring
# batches — never mid-flight inside one LLM call) is simpler and
# safer than reaching into asyncio internals to force it, and doesn't
# survive a server restart, an accepted limitation matching this
# codebase's already-stated lack of full run resumability.
_CANCEL_EVENTS: dict[uuid.UUID, asyncio.Event] = {}


class _RunCancelled(Exception):
    pass


# Raised directly by Adrian: a 4-role-title saved search was hitting
# up to 4 query variants EACH (query_expansion.py's old fixed
# per-title cap), so up to 16 total searches against a source with no
# server-side filtering (RemoteOK) — one full listing refetch per
# variant. This caps the WHOLE saved search's total query count, not
# just any one title's, splitting a fixed budget across every role
# title instead: 1 title still gets up to 4 (there's slack in the
# budget), 3 titles get 2 each (6 total), 6+ titles get 1 each — no
# expansion at all, since there's no room left once every title needs
# at least its own literal query.
_TOTAL_QUERY_BUDGET = 6
_MAX_PER_TITLE = 4  # never exceeded even when only one role title leaves room to


def _max_queries_per_title(num_role_titles: int) -> int:
    if num_role_titles <= 0:
        return _MAX_PER_TITLE
    return max(1, min(_MAX_PER_TITLE, _TOTAL_QUERY_BUDGET // num_role_titles))


async def run_radar_search(
    saved_search_id: uuid.UUID, user_id: uuid.UUID, session_factory: sessionmaker
) -> AsyncGenerator[dict, None]:
    with session_factory() as db:
        saved_search = db.get(SavedSearch, saved_search_id)
        persona = db.get(Persona, saved_search.persona_id)
        # Every persona owns its own Profile exclusively now
        # (Persona.profile_id, unique=True) — resolved via the
        # persona already in hand, not "the" user's profile (there
        # can be several, one per persona).
        profile = db.get(Profile, persona.profile_id)
        active_profile = active_model_profile(db)

        run = AgentRun(
            user_id=user_id,
            run_type="radar",
            status="running",
            saved_search_id=saved_search.id,
            persona_id=persona.id,
            profile_revision=profile.revision,
            model_profile_id=active_profile.id if active_profile else None,
            started_at=datetime.now(timezone.utc),
        )
        db.add(run)
        db.commit()
        cancel_event = _CANCEL_EVENTS.setdefault(run.id, asyncio.Event())

        # Guards every yield point below (including the source and
        # scoring loops) against a client disconnect mid-run — a
        # closed tab, backgrounded browser, laptop sleep, or dropped
        # network tears this generator down via GeneratorExit (or the
        # driving task via CancelledError), neither of which a plain
        # `except Exception` below ever catches (both are
        # BaseException, not Exception). Confirmed live: exactly this
        # happened to a real run, left stuck at status="running"
        # forever with no further events and nothing left to make
        # progress — the in-flight per-job scoring tasks kept running
        # detached in the background and did finish (writing their
        # own real FitScore/LlmCall rows through score_job's own
        # session), but nothing was left to reach the normal
        # `run.status = "completed"` line at the bottom. `finally`
        # runs on every exit path — normal return, a real exception,
        # or a cancellation — so this is the one place that can
        # reliably close out `run.status` no matter how the generator
        # actually ends.
        try:
            # Every event this generator yields is also written down as a
            # RunEvent row before it's yielded — durable, not best-effort —
            # so a client that reconnects later (or never saw the live
            # stream at all, e.g. a page reload mid-run) can replay
            # everything from `seq > since_seq` instead of only ever seeing
            # whatever the DB's final-state columns happened to hold at
            # the moment it asked. `event_seq` only needs to be a plain
            # local counter, not read back from the DB, because every
            # yield in this function happens sequentially in this one
            # coroutine — the concurrent workers below do real work
            # concurrently but never yield/emit directly themselves.
            event_seq = 0

            def _emit(event_type: str, **data: Any) -> dict:
                nonlocal event_seq
                event_seq += 1
                db.add(RunEvent(user_id=user_id, agent_run_id=run.id, seq=event_seq, event_type=event_type, data=data))
                db.commit()
                return _event(event_type, **data)

            yield _emit("run_started", agent_run_id=str(run.id))

            max_queries_per_title = _max_queries_per_title(len(saved_search.role_titles))

            sources_by_id = {
                s.id: s
                for s in db.query(Source).filter(Source.user_id == user_id, Source.id.in_(saved_search.source_ids)).all()
            }
            source_run_ids: list[uuid.UUID] = []
            touched_job_ids: set[uuid.UUID] = set()

            for source_id in saved_search.source_ids:
                # Checked between sources, not mid-flight inside one —
                # cancelling doesn't abort a search call already under
                # way, it just stops starting new ones.
                if cancel_event.is_set():
                    raise _RunCancelled()

                source = sources_by_id.get(source_id)
                t0 = datetime.now(timezone.utc)

                if source is None:
                    # Referenced by the saved search but deleted since —
                    # surfaced, not silently dropped from the run.
                    yield _emit("source_error", source_id=str(source_id), message="source no longer exists")
                    continue

                source_run = SourceRun(
                    user_id=user_id,
                    saved_search_id=saved_search.id,
                    agent_run_id=run.id,
                    source_id=source.id,
                    status="running",
                    started_at=t0,
                )
                db.add(source_run)
                db.commit()
                source_run_ids.append(source_run.id)
                yield _emit(
                    "source_started", source_run_id=str(source_run.id), source_name=source.name, adapter_key=source.adapter_key
                )

                skip_reason = None
                if not source.enabled:
                    skip_reason = "source is disabled"
                elif source.circuit_breaker_tripped:
                    skip_reason = "circuit breaker is tripped for this source"
                if skip_reason:
                    source_run.status = "failed"
                    source_run.finished_at = datetime.now(timezone.utc)
                    source_run.errors = [{"message": skip_reason, "at": source_run.finished_at.isoformat()}]
                    db.commit()
                    yield _emit("source_done", source_run_id=str(source_run.id), status="failed", message=skip_reason)
                    continue

                # Initialized before the try block, not inside it: the
                # except handler below reports whatever partial progress
                # was made even if the failure happens before a single
                # posting is processed (e.g. get_adapter/resolved_config
                # itself raises) — referencing these from except while
                # they were only assigned inside try would be a NameError
                # on that exact path.
                expanded_queries: dict[str, list[str]] = {}
                seen = new_count = deduped_count = 0
                # M2 §6 — per-company breakdown for a scan-list source
                # covering many companies at once; {company_name: {seen, new, deduped}}.
                company_breakdown: dict[str, dict[str, int]] = {}
                try:
                    adapter = get_adapter(source.adapter_key)
                    config = resolved_config(source.config)

                    # generic_scraper (M4 §9) is the one adapter that needs
                    # an LLM at all — every other adapter.search() call is a
                    # deterministic HTTP/JSON parse with nothing to route.
                    # Resolved once per source here (not per role title/
                    # query below): unlike query expansion's per-title
                    # variants, the same career page doesn't need a fresh
                    # model pull for every title it gets filtered against.
                    scrape_model = None
                    if adapter.needs_llm:
                        try:
                            scrape_model = resolve_tier(
                                db, user_id=user_id, tier="fast", stage="radar-generic-scrape",
                                agent_run_id=run.id, source_run_id=source_run.id, session_factory=session_factory,
                            )
                        except TierResolutionError as exc:
                            yield _emit(
                                "log", source_run_id=str(source_run.id),
                                message=f"{source.name}: fast tier not configured, cannot scrape this run ({exc})",
                            )

                    # A credit-metered source (SocialFetch today) bills a
                    # real amount per search call regardless of how many
                    # jobs come back — found live: query expansion turned
                    # one role title into up to 4 separately-billed
                    # searches, on top of a since-fixed timeout/retry bug
                    # that multiplied it further (see http_policy.py).
                    # Forcing a budget of 1 here means exactly one real,
                    # literal-title search per role title per run for
                    # these sources, same as the existing "no budget left"
                    # path below, just source-driven instead of
                    # title-count-driven.
                    source_max_queries_per_title = 1 if adapter.credit_metered else max_queries_per_title

                    # Every role title's expansion is an independent LLM
                    # call — run them all concurrently instead of one at a
                    # time (raised directly by Adrian: "inference time is a
                    # metric we have to tackle by doing concurrent runs").
                    # Each worker opens its own DB session via
                    # session_factory (resolve_tier's ModelProfile/
                    # ModelCatalogEntry reads aren't safe to run from
                    # multiple threads against the same shared `db`), same
                    # pattern as scoring_service.score_job.
                    async def _expand_one(role_title: str) -> tuple[str, list[str], str | None]:
                        if source_max_queries_per_title <= 1:
                            # No point resolving a model just to be told
                            # there's no budget for variants — either the
                            # whole-search cap already decided this title
                            # gets only its own literal text, or this
                            # source is credit-metered and gets forced to
                            # 1 regardless of the cap.
                            queries, fallback_reason = expand_role_title(None, role_title, source_max_queries_per_title)  # type: ignore[arg-type]
                            return role_title, queries, fallback_reason

                        def _sync() -> tuple[list[str], str | None]:
                            with session_factory() as local_db:
                                try:
                                    chat_model = resolve_tier(
                                        local_db,
                                        user_id=user_id,
                                        tier="fast",
                                        stage="radar-query-expansion",
                                        agent_run_id=run.id,
                                        source_run_id=source_run.id,
                                        session_factory=session_factory,
                                    )
                                except TierResolutionError as exc:
                                    return [role_title], f"fast tier not configured: {exc}"
                                return expand_role_title(chat_model, role_title, source_max_queries_per_title)

                        queries, fallback_reason = await to_thread(_sync)
                        return role_title, queries, fallback_reason

                    expansion_results = await asyncio.gather(
                        *[_expand_one(role_title) for role_title in saved_search.role_titles]
                    )

                    for role_title, queries, fallback_reason in expansion_results:
                        expanded_queries[role_title] = queries
                        if fallback_reason:
                            yield _emit(
                                "query_expansion_fallback",
                                source_run_id=str(source_run.id),
                                role_title=role_title,
                                reason=fallback_reason,
                            )

                    # Every (role_title, query) pair is fetched independently
                    # too — bounded-concurrent, not sequential (same "tackle
                    # inference/network time with concurrency" directive).
                    # Deliberately NOT parallelized past this point:
                    # normalize_and_upsert's canonical_key lookup is a
                    # check-then-insert ("does a Job with this key already
                    # exist?") — two concurrent writers racing on the same
                    # key could each see "no" and both insert, creating a
                    # duplicate canonical Job. Fetching concurrently and
                    # then normalizing every result strictly sequentially
                    # afterward (in this one coroutine, never from a thread)
                    # gets the real network-bound speedup while keeping that
                    # race impossible by construction, not by luck.
                    search_semaphore = asyncio.Semaphore(_SEARCH_CONCURRENCY)

                    async def _search_one(role_title: str, query: str):
                        async with search_semaphore:
                            collected_logs: list[str] = []
                            postings = None
                            search_call = (
                                adapter.search(query, saved_search.filters or {}, config, model=scrape_model)
                                if adapter.needs_llm
                                else adapter.search(query, saved_search.filters or {}, config)
                            )
                            async for kind, payload in run_with_live_logs(search_call):
                                if kind == "log":
                                    collected_logs.append(payload)
                                else:
                                    postings = payload
                            assert postings is not None  # run_with_live_logs always yields a result or raises
                            return role_title, query, postings, collected_logs

                    # An unhandled exception from any task propagates when
                    # that task is awaited below (asyncio.as_completed
                    # doesn't swallow it) — preserves the original
                    # "one auth/config failure stops the whole source"
                    # behavior confirmed live with a bad JSearch key, just
                    # across concurrent fetches now instead of sequential
                    # ones.
                    search_tasks = [
                        asyncio.create_task(_search_one(role_title, query))
                        for role_title, queries, _ in expansion_results
                        for query in queries
                    ]
                    for coro in asyncio.as_completed(search_tasks):
                        _role_title, _query, postings, collected_logs = await coro
                        for log_message in collected_logs:
                            yield _emit("log", source_run_id=str(source_run.id), message=log_message)
                        seen += len(postings)
                        for posting in postings:
                            job, is_new = normalize_and_upsert(
                                db, user_id=user_id, source=source, posting=posting, now=datetime.now(timezone.utc)
                            )
                            touched_job_ids.add(job.id)
                            company_stats = company_breakdown.setdefault(
                                posting.company_name, {"seen": 0, "new": 0, "deduped": 0}
                            )
                            company_stats["seen"] += 1
                            if is_new:
                                new_count += 1
                                company_stats["new"] += 1
                            else:
                                deduped_count += 1
                                company_stats["deduped"] += 1
                        db.commit()

                    source_run.status = "completed"
                    source_run.finished_at = datetime.now(timezone.utc)
                    source_run.expanded_queries = expanded_queries
                    source_run.postings_seen = seen
                    source_run.postings_new = new_count
                    source_run.postings_deduped = deduped_count
                    source_run.company_breakdown = company_breakdown
                    source_run.cost_usd = sum(
                        float(c.cost_usd) for c in db.query(LlmCall).filter_by(source_run_id=source_run.id).all()
                    )
                    db.commit()
                    db.add(
                        AgentStep(
                            agent_run_id=run.id,
                            step_type="source_run",
                            input_summary={"source": source.name, "role_titles": saved_search.role_titles},
                            output_summary={"seen": seen, "new": new_count, "deduped": deduped_count},
                            started_at=t0,
                            finished_at=datetime.now(timezone.utc),
                        )
                    )
                    db.commit()
                    yield _emit(
                        "source_done",
                        source_run_id=str(source_run.id),
                        status="completed",
                        seen=seen,
                        new=new_count,
                        deduped=deduped_count,
                        company_breakdown=company_breakdown,
                    )
                except Exception as exc:
                    db.rollback()
                    failed = db.get(SourceRun, source_run.id)
                    if failed is not None:
                        failed.status = "failed"
                        failed.finished_at = datetime.now(timezone.utc)
                        failed.errors = [{"message": str(exc)[:500], "at": failed.finished_at.isoformat()}]
                        # Whatever ran before the failure (a role title's
                        # query expansion, or postings already normalized
                        # from an earlier query variant) is real progress
                        # and real spend — persisting it here is what keeps
                        # a failed SourceRun's telemetry honest instead of
                        # silently reporting zero (F13.6's discipline
                        # extended to "partial success," not just "unpriced
                        # model"). `db` was already rolled back above, but
                        # LlmCall rows are written through their own
                        # independent session inside the callback handler
                        # (see metering.py) and were already committed
                        # there, so they're still visible here.
                        failed.expanded_queries = expanded_queries
                        failed.postings_seen = seen
                        failed.postings_new = new_count
                        failed.postings_deduped = deduped_count
                        failed.company_breakdown = company_breakdown
                        failed.cost_usd = sum(
                            float(c.cost_usd) for c in db.query(LlmCall).filter_by(source_run_id=failed.id).all()
                        )
                        db.commit()
                    yield _emit(
                        "source_done",
                        source_run_id=str(source_run.id),
                        status="failed",
                        message=str(exc)[:300],
                        seen=seen,
                        new=new_count,
                        deduped=deduped_count,
                    )

            if touched_job_ids:
                t0 = datetime.now(timezone.utc)
                jobs_to_embed = (
                    db.query(Job)
                    .filter(Job.id.in_(touched_job_ids), Job.description_embedding.is_(None))
                    .all()
                )
                if jobs_to_embed:
                    yield _emit("embedding_started", count=len(jobs_to_embed))
                    try:
                        embeddings_client, embeddings_provider = await to_thread(resolve_embedding_tier, db, user_id=user_id)
                        embedded_count, batch_errors = await to_thread(
                            embed_jobs,
                            db,
                            embeddings_client,
                            jobs_to_embed,
                            user_id=user_id,
                            session_factory=session_factory,
                            provider=embeddings_provider,
                            stage="radar-job-embedding",
                            agent_run_id=run.id,
                        )
                        db.commit()
                        db.add(
                            AgentStep(
                                agent_run_id=run.id,
                                step_type="embedding",
                                input_summary={"jobs": len(jobs_to_embed)},
                                output_summary={"embedded": embedded_count, "errors": batch_errors},
                                started_at=t0,
                                finished_at=datetime.now(timezone.utc),
                            )
                        )
                        db.commit()
                        yield _emit("embedding_done", embedded=embedded_count, errors=batch_errors)
                    except TierResolutionError as exc:
                        # Same discipline as query expansion: an
                        # unconfigured/broken embedding tier must not
                        # discard the jobs already normalized this run —
                        # they stay real, just unembedded until a later
                        # run picks them up (structural checkpointing, see
                        # job_embedding.py's module docstring).
                        yield _emit("embedding_done", embedded=0, errors=[f"embedding tier not configured: {exc}"])

                t0 = datetime.now(timezone.utc)
                jobs_touched = db.query(Job).filter(Job.id.in_(touched_job_ids)).all()
                # Skip jobs already scored for this exact (persona,
                # profile_revision, persona_revision) triple — M1 §5 wants
                # a new score appended "when the profile or persona
                # changes," which implies the inverse too: a rerun against
                # an unchanged profile AND unchanged preferences shouldn't
                # re-pay for the same score. persona_revision added M2 §3 —
                # it bumps whenever this persona's Preference is edited
                # (routers/preferences.py), which now feeds scoring too.
                already_scored_ids = {
                    row[0]
                    for row in db.query(PrefilterResult.job_id).filter(
                        PrefilterResult.job_id.in_([j.id for j in jobs_touched]),
                        PrefilterResult.persona_id == persona.id,
                        PrefilterResult.profile_revision == profile.revision,
                        PrefilterResult.persona_revision == persona.revision,
                    )
                }
                jobs_to_score = [j for j in jobs_touched if j.id not in already_scored_ids][:_MAX_JOBS_TO_SCORE_PER_RUN]

                if jobs_to_score:
                    yield _emit("scoring_started", count=len(jobs_to_score))
                    kept = dropped = review = score_errors = 0

                    # Bounded concurrency, not sequential — raised directly
                    # by Adrian after watching 8 jobs score one at a time,
                    # several minutes total, with no reason two independent
                    # jobs' LLM calls needed to wait on each other.
                    # score_job() opens its own DB session per call (see
                    # its own docstring for why sharing `db` across threads
                    # here would be unsafe), which is what makes running
                    # several concurrently actually correct, not just fast.
                    semaphore = asyncio.Semaphore(_SCORING_CONCURRENCY)

                    async def _score_one(job: Job):
                        async with semaphore:
                            try:
                                result = await to_thread(
                                    score_job,
                                    session_factory,
                                    job_id=job.id,
                                    persona_id=persona.id,
                                    profile_id=profile.id,
                                    user_id=user_id,
                                    agent_run_id=run.id,
                                )
                                return "ok", job, result
                            except Exception as exc:
                                return "error", job, str(exc)[:300]

                    tasks = [asyncio.create_task(_score_one(job)) for job in jobs_to_score]
                    for coro in asyncio.as_completed(tasks):
                        kind, job, payload = await coro
                        # Checked between completed jobs, not mid-flight
                        # inside one — the jobs already in progress when
                        # cancel was requested still finish (they're
                        # independent tasks with their own DB session,
                        # same as a disconnect leaves running); this just
                        # stops processing further results and starting
                        # anything new.
                        if cancel_event.is_set():
                            raise _RunCancelled()
                        if kind == "error":
                            score_errors += 1
                            yield _emit("job_scoring_error", job_id=str(job.id), title=job.title, message=payload)
                            continue
                        result = payload
                        if result.decision == "drop":
                            dropped += 1
                        elif result.decision == "review":
                            review += 1
                        else:
                            kept += 1
                        yield _emit(
                            "job_scored",
                            job_id=str(result.job_id),
                            title=result.job_title,
                            decision=result.decision,
                            recommendation=result.recommendation,
                            overall_score=result.overall_score,
                        )

                    db.add(
                        AgentStep(
                            agent_run_id=run.id,
                            step_type="scoring",
                            input_summary={"jobs": len(jobs_to_score)},
                            output_summary={"kept": kept, "dropped": dropped, "review": review, "errors": score_errors},
                            started_at=t0,
                            finished_at=datetime.now(timezone.utc),
                        )
                    )
                    db.commit()
                    yield _emit("scoring_done", kept=kept, dropped=dropped, review=review, errors=score_errors)

            run.status = "completed"
            run.finished_at = datetime.now(timezone.utc)
            run.total_cost_usd = sum(float(c.cost_usd) for c in db.query(LlmCall).filter_by(agent_run_id=run.id).all())
            db.commit()

            source_runs = db.query(SourceRun).filter(SourceRun.id.in_(source_run_ids)).all()
            result = schemas.RadarRunResult(
                agent_run_id=run.id,
                status=run.status,
                source_runs=[schemas.SourceRunOut.model_validate(sr) for sr in source_runs],
                cost_usd=float(run.total_cost_usd),
            )
            # mode="json" so every field (UUIDs, Decimal cost) is already
            # a plain JSON-safe type before it goes into `data` — `_emit`
            # stores that dict directly on the JSONB column, and the SSE
            # frame's own json.dumps(data, default=str) is just a second,
            # redundant-but-harmless safety net over the same values.
            yield _emit("done", **result.model_dump(mode="json"))
        except _RunCancelled:
            # A deliberate user-initiated cancel (POST /agent-runs/{id}/cancel),
            # noticed at the next checkpoint — distinct from the generic
            # "failed" the `finally` below assigns for an unexpected
            # disconnect, so the UI can tell "you stopped this" from
            # "this broke."
            run.status = "cancelled"
            run.finished_at = datetime.now(timezone.utc)
            run.total_cost_usd = sum(float(c.cost_usd) for c in db.query(LlmCall).filter_by(agent_run_id=run.id).all())
            db.commit()
            yield _emit("run_cancelled", agent_run_id=str(run.id))
        finally:
            # Only fires if the run never reached the normal
            # "completed" assignment above (or the cancelled one just
            # above) — a real exception already handled per-source/
            # per-job doesn't reach here with status still "running",
            # so this is specifically the disconnect case. Best-effort:
            # if even this fails (e.g. the session is already unusable
            # by the time cleanup runs), there's nothing further to do
            # but avoid masking whatever caused the original exit.
            if run.status == "running":
                try:
                    run.status = "failed"
                    run.finished_at = datetime.now(timezone.utc)
                    run.total_cost_usd = sum(
                        float(c.cost_usd) for c in db.query(LlmCall).filter_by(agent_run_id=run.id).all()
                    )
                    db.commit()
                except Exception:
                    db.rollback()
            _CANCEL_EVENTS.pop(run.id, None)
