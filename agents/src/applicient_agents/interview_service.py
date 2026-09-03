"""Phase 11 (v2 plan) — drives interview/FGD/LGD practice sessions.

Deliberately simpler than orchestrator_service.py/application_service.py's
own asyncio.wait-race-multiple-tasks streaming loops: those exist to
surface a long-running, many-tool-call, potentially multi-minute
internal run live, tool call by tool call, and to support cancelling
one mid-flight. One interview turn is bounded — transcribe, at most a
couple of tool calls, synthesize — so this drives the agent with a
single `ainvoke` per turn and emits coarse stage markers around the
three outer steps (transcribing / thinking / synthesizing) instead.
No cancel-mid-turn support in this first pass — a real, disclosed
simplification, not an oversight; add the same _CANCEL_EVENTS
discipline the other two services already use if a turn ever needs to
be interruptible.

Uses the SAME shared AsyncPostgresSaver checkpointer orchestrator_service.py
already opens once at API startup (get_checkpointer()) — thread ids are
already globally unique (str(uuid.uuid4())), so one instance safely
isolates every conversation *and* every interview session by thread_id
alone; no reason to open a second Postgres-backed checkpointer just for
this feature."""

from __future__ import annotations

import base64
import json
import re
import uuid
from asyncio import to_thread
from collections.abc import AsyncGenerator
from datetime import datetime, timezone

from langchain_core.messages import AIMessage
from sqlalchemy.orm import Session, sessionmaker

from applicient_agents.interview_agent import build_interview_agent
from applicient_agents.interview_tools import build_interview_tools
from applicient_agents.orchestrator_service import get_checkpointer

from applicient_api import interview_media
from applicient_api.interview_feedback_engine import run_interview_feedback
from applicient_api.models.agents import AgentRun, RunEvent
from applicient_api.models.discovery import Job
from applicient_api.models.interview import InterviewSession
from applicient_api.models.llm import LlmCall, ModelCatalogEntry, ModelProfile, ProviderConnection
from applicient_api.models.profile import EvidenceItem, Persona, Profile
from applicient_api.object_storage import put_object
from applicient_api.tier_resolution import TierResolutionError, resolve_tier


class InterviewServiceError(Exception):
    pass


def _error_event(message: str) -> dict:
    return {"event": "error", "data": json.dumps({"message": message})}


def _stage(stage: str, status: str, message: str, **detail) -> dict:
    return {"stage": stage, "status": status, "message": message, **detail}


def _supports_web_search(db: Session) -> bool:
    """Best-effort: true when an OpenRouter connection exists at all in
    this deployment. This deployment's own stated default shape is one
    provider running everything ("one key runs the whole product",
    providers/openrouter.py) — for that common case this is exactly
    right; a deployment mixing several *different* providers across
    tiers could in principle have this agent's own resolved model NOT
    be the OpenRouter one even though a connection exists elsewhere,
    in which case the web-search tool's own try/except just returns a
    graceful "unavailable" string rather than crashing the turn either
    way, so an imprecise `True` here is never worse than a wasted
    attempt."""

    return db.query(ProviderConnection.id).filter_by(provider="openrouter").first() is not None


def _session_context_block(db: Session, session: InterviewSession) -> str:
    """Everything the agent needs to know about who it's talking to and
    what to ground questions in — built once, baked into the very
    first task message, same "static context goes in the prompt"
    reasoning application_service.py's own _candidate_info_block
    already follows (not a tool, since it never changes mid-session)."""

    lines: list[str] = [f"Practice type: {session.practice_type}"]
    if session.category:
        lines.append(f"Category focus: {session.category}")
    if session.seniority:
        lines.append(f"Target seniority: {session.seniority}")

    if session.job_id:
        job = db.get(Job, session.job_id)
        if job is not None:
            lines.append(f"Target role: {job.title} at {job.company_name_raw}")
            if job.requirements:
                lines.append(f"Job requirements:\n{job.requirements[:2000]}")
            if job.responsibilities:
                lines.append(f"Job responsibilities:\n{job.responsibilities[:2000]}")
    else:
        if session.role_title:
            lines.append(f"Target role: {session.role_title}")
        if session.company_name:
            lines.append(f"Target company: {session.company_name}")

    persona = db.get(Persona, session.persona_id)
    if persona is not None:
        profile = db.get(Profile, persona.profile_id)
        if profile is not None:
            items = db.query(EvidenceItem).filter_by(profile_id=profile.id).limit(40).all()
            if items:
                lines.append("Candidate's real evidence bank (ground experience-based questions in these, never invent one):")
                for item in items:
                    employer = f" @ {item.employer}" if item.employer else ""
                    lines.append(f"- [{item.category}] {item.title or ''}{employer}: {item.text[:300]}")

    return "\n".join(lines)


def _extract_reply(result: dict) -> str:
    messages = result.get("messages", [])
    for message in reversed(messages):
        if isinstance(message, AIMessage) and message.content:
            return str(message.content)
    return ""


async def _run_agent_turn(
    session_factory: sessionmaker,
    *,
    practice_type: str,
    thread_id: str,
    run_id: uuid.UUID,
    user_id: uuid.UUID,
    human_message: str,
    emit,
) -> AsyncGenerator[dict, None]:
    """Shared by the opening turn (session creation) and every later
    turn — resolves the model, builds a fresh agent (cheap; same
    "rebuild every turn" choice orchestrator_service.py makes, real
    state lives in the checkpointer/thread_id, not in the Python
    object), drives one turn, and yields the resulting reply text via
    a `{"__reply__": ...}` sentinel dict the caller strips before it
    ever reaches an SSE client (a plain async generator can't both
    yield SSE dicts and return a value).

    Takes plain `practice_type`/`thread_id` strings, not the
    InterviewSession row itself — callers load that row in their own
    short-lived `with session_factory() as db:` block, and any commit
    inside this function's own turn (e.g. _new_run's) expires every
    attribute on an object loaded by a DIFFERENT, already-closed
    session; passing the object across that boundary and reading an
    attribute off it later raises exactly that (hit live, verified)."""

    yield emit("stage", _stage("agent", "started", "Thinking"))
    with session_factory() as db:
        try:
            model = resolve_tier(
                db, user_id=user_id, tier="balanced", stage="interview-practice",
                agent_run_id=run_id, session_factory=session_factory,
            )
        except TierResolutionError as exc:
            yield emit("error", {"message": f"model routing not configured: {exc}"})
            return
        web_search = _supports_web_search(db)

    end_signal: dict = {}
    tools = build_interview_tools(model=model, supports_web_search=web_search, end_signal=end_signal)
    checkpointer = get_checkpointer()
    if checkpointer is None:
        yield emit("error", {"message": "interview-practice checkpointer not initialized — the API did not start up correctly"})
        return
    agent = build_interview_agent(
        model=model, tools=tools, checkpointer=checkpointer, practice_type=practice_type,
    )
    config = {"configurable": {"thread_id": thread_id}}
    result = await agent.ainvoke({"messages": [("user", human_message)]}, config=config)
    reply_text = _extract_reply(result)
    yield emit("stage", _stage("agent", "done", reply_text or "(no reply)"))
    yield {"__reply__": reply_text}  # sentinel, stripped by the caller before it ever reaches an SSE client
    # Second sentinel, same convention — whether the agent called
    # end_interview this turn (interview_tools.py's own end_signal
    # closure). Checked by the caller AFTER this turn's reply/audio
    # are fully done, so the candidate actually hears the closing
    # remark before scoring takes over.
    yield {"__end_requested__": bool(end_signal.get("requested"))}


def _new_run(db, *, user_id: uuid.UUID, persona_id: uuid.UUID, session_id: uuid.UUID) -> AgentRun:
    run = AgentRun(
        user_id=user_id, run_type="interview-practice", status="running",
        persona_id=persona_id, interview_session_id=session_id, started_at=datetime.now(timezone.utc),
    )
    db.add(run)
    db.commit()
    return run


def _make_emit(session_factory: sessionmaker, *, user_id: uuid.UUID, run_id: uuid.UUID):
    event_seq = 0

    def emit(event_type: str, data: dict) -> dict:
        nonlocal event_seq
        event_seq += 1
        with session_factory() as db:
            db.add(RunEvent(user_id=user_id, agent_run_id=run_id, seq=event_seq, event_type=event_type, data=data))
            db.commit()
        return {"event": event_type, "data": json.dumps(data)}

    return emit


def _emit_ephemeral(event_type: str, data: dict) -> dict:
    """Same SSE-frame shape `emit` produces, but never written to
    RunEvent — used only for audio_chunk (dozens of tiny frames per
    turn; the single persisted audio_end event already carries the
    final audio_filename, which is all replay/reconnect ever needs, so
    persisting every chunk individually would just be DB bloat for no
    real benefit)."""

    return {"event": event_type, "data": json.dumps(data)}


async def _finish_run(session_factory: sessionmaker, *, run_id: uuid.UUID, status: str) -> None:
    with session_factory() as db:
        run = db.get(AgentRun, run_id)
        if run is not None:
            run.status = status
            run.finished_at = datetime.now(timezone.utc)
            db.commit()


# Hit live: FGD/LGD's multi-speaker replies (moderator + several
# simulated participants in one turn) can run past 2000+ characters,
# and openrouter+deepgram/aura-2 rejects a synthesis request that long
# outright (confirmed live: "413 Provider returned 413" — a real
# provider-side input-size limit, not a transient failure retrying
# would fix). Interview mode's single-question replies never come
# close to this, so the truncation below only ever actually bites for
# FGD/LGD. The full, untruncated text is always what's shown on
# screen and what feedback scoring reads back from the transcript —
# only the AUDIO is ever shortened.
_MAX_TTS_CHARS = 1800


def _truncate_for_speech(text: str) -> str:
    if len(text) <= _MAX_TTS_CHARS:
        return text
    cut = text[:_MAX_TTS_CHARS]
    # Prefer ending on a real sentence boundary over a mid-word cutoff
    # when one exists reasonably close to the limit.
    last_boundary = max(cut.rfind(". "), cut.rfind("\n"), cut.rfind("! "), cut.rfind("? "))
    if last_boundary > _MAX_TTS_CHARS * 0.5:
        cut = cut[: last_boundary + 1]
    return cut.rstrip() + " (continued below — read on for the rest)"


# FGD/LGD needs at least two distinct voices to sound like a real
# group discussion (raised directly by Adrian) rather than one person
# reading every part — interview_agent.py's own FGD_LGD_SYSTEM_PROMPT
# already formats every turn as "Speaker: text" lines (chat-cards.tsx's
# AgentReplyText already parses this same format for on-screen
# labeling), this is the same parse, run server-side so each speaker's
# lines can be synthesized separately with a different voice.
_SPEAKER_LINE_RE = re.compile(r"^([^:]{1,40}):\s(.*)$")


def _split_speaker_segments(text: str, practice_type: str) -> list[tuple[str | None, str]]:
    """Returns [(speaker_or_None, segment_text), ...] — one segment
    covering the WHOLE reply for plain interview mode (nothing to
    split, one voice), or one segment per "Speaker: text" line for
    fgd/lgd. A line with no recognizable "Speaker:" prefix is folded
    into the previous segment (the model occasionally wraps one
    speaker's point across two lines) rather than treated as its own
    unattributed segment."""

    if practice_type not in ("fgd", "lgd"):
        return [(None, text)]

    segments: list[tuple[str | None, str]] = []
    for raw_line in text.split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        m = _SPEAKER_LINE_RE.match(line)
        if m:
            segments.append((m.group(1).strip(), m.group(2).strip()))
        elif segments:
            speaker, prev_text = segments[-1]
            segments[-1] = (speaker, f"{prev_text} {line}")
        else:
            segments.append((None, line))
    return segments or [(None, text)]


def _role_for_speaker(speaker: str | None) -> str:
    """"moderator" gets the primary voice (also used for plain 1-on-1
    interview mode's single speaker, speaker=None); every simulated
    FGD/LGD participant who ISN'T the moderator gets the secondary
    voice — matched by substring, not exact equality, since the model
    is free to phrase it as "Moderator" or "The moderator" etc."""

    if speaker is None or "moderator" in speaker.lower():
        return "moderator"
    return "discusser"


def _log_audio_cost(
    session_factory: sessionmaker,
    *,
    user_id: uuid.UUID,
    agent_run_id: uuid.UUID,
    stage: str,
    provider: str,
    model_id: str,
    cost_usd: float,
    cost_known: bool,
) -> None:
    """One LlmCall row for a raw (non-LangChain) audio API call —
    metering.py's own CostLedgerCallbackHandler only ever fires from
    inside a real LangChain model invocation, which neither STT nor
    TTS are here (plain httpx calls against /audio/transcriptions and
    /audio/speech), so this writes the row directly instead.
    input_tokens/output_tokens are deliberately left at 0 rather than
    stuffed with a stand-in "seconds" or "characters" count —
    cost/page.tsx's own dashboard sums every row's tokens into one
    shared total, and a fabricated non-token number would silently
    corrupt that total for every OTHER (real, token-priced) call
    alongside it; `stage` ("interview-practice-stt"/"-tts") is what
    tells these rows apart in the UI, and cost_usd — computed for
    real, see interview_media.py's transcribe()/estimate_speech_cost()
    — is the number that actually matters on a cost dashboard."""

    with session_factory() as db:
        db.add(
            LlmCall(
                user_id=user_id,
                agent_run_id=agent_run_id,
                stage=stage,
                provider=provider,
                model_id=model_id,
                cost_usd=cost_usd,
                cost_known=cost_known,
                status="ok",
                created_at=datetime.now(timezone.utc),
            )
        )
        db.commit()


async def _synthesize_stream_and_store(
    session_factory: sessionmaker,
    *,
    session_id: uuid.UUID,
    text: str,
    practice_type: str,
    emit,
    user_id: uuid.UUID,
    run_id: uuid.UUID,
) -> AsyncGenerator[dict, None]:
    """Streams synthesized speech to the client as raw PCM chunks
    (audio_start, audio_chunk*, audio_end, repeated once per speaker
    segment — see _split_speaker_segments/_role_for_speaker above)
    instead of the old "wait for the whole clip, then hand back one
    filename" shape — interview_media.synthesize_stream's own
    docstring has the live-measured numbers, but the short version:
    the provider already sends this chunked, first bytes in ~1-1.5s,
    so the client can start playing well before the full reply is
    done synthesizing rather than waiting out the whole thing (raised
    directly by Adrian). Plain interview mode is just one segment
    (speaker=None); FGD/LGD is one segment per "Speaker: text" line,
    each synthesized with a different voice depending on whether it's
    the moderator or another simulated participant — also raised
    directly by Adrian, group discussion practice sounding like one
    person reading every part isn't a realistic FGD/LGD.

    Every chunk from every segment is ALSO collected into one combined
    buffer and, once the whole turn's synthesis ends, wrapped into a
    single WAV file and stored — so the exact same multi-voice clip
    that just played live is still replayable later (the ▶ replay
    button, the results screen) via a plain one-shot fetch.

    Ends by yielding a `{"__audio_filename__": ...}` sentinel (None on
    total failure, mirroring _run_agent_turn's own `__reply__`
    sentinel convention) — the caller strips it before it reaches an
    SSE client. A failure on any ONE segment — including mid-stream,
    after some of ITS chunks already played — degrades that segment to
    text-only and moves on to the next one rather than raising: the
    reply_text this session already has is real and worth keeping
    regardless of whether audio came with it (same accessibility
    reasoning the plan's own frontend design commits to: the question
    is always shown as real text, never audio-only)."""

    truncated_text = _truncate_for_speech(text)
    segments = _split_speaker_segments(truncated_text, practice_type)

    pcm_buffer = bytearray()
    combined_sample_rate: int | None = None
    combined_channels: int | None = None

    for speaker, segment_text in segments:
        if not segment_text.strip():
            continue
        role = _role_for_speaker(speaker)
        try:
            with session_factory() as db:
                stream = await interview_media.synthesize_stream(
                    db, text=segment_text, secondary=(role == "discusser"),
                )
        except interview_media.InterviewMediaError as exc:
            yield emit("stage", _stage("synthesizing", "done", f"Audio unavailable for one part — text only ({exc})"))
            continue

        yield emit("audio_start", {"sample_rate": stream.sample_rate, "channels": stream.channels, "speaker": speaker, "role": role})
        combined_sample_rate = combined_sample_rate or stream.sample_rate
        combined_channels = combined_channels or stream.channels
        try:
            async for chunk in stream.chunks:
                pcm_buffer.extend(chunk)
                yield _emit_ephemeral("audio_chunk", {"data": base64.b64encode(chunk).decode("ascii")})
        except interview_media.InterviewMediaError as exc:
            # Whatever chunks from THIS segment already reached the
            # client keep playing client-side regardless — not
            # re-raised, this segment degrades to text-only and the
            # loop moves on to whichever segments come after it.
            yield emit("stage", _stage("synthesizing", "done", f"Audio stream interrupted for one part — text only from here ({exc})"))
            yield emit("audio_end", {})
            continue

        with session_factory() as db:
            cost_usd, cost_known = interview_media.estimate_speech_cost(
                db, provider=stream.provider, model_id=stream.model_id,
                provider_connection_id=stream.provider_connection_id, char_count=len(segment_text),
            )
        _log_audio_cost(
            session_factory, user_id=user_id, agent_run_id=run_id, stage="interview-practice-tts",
            provider=stream.provider, model_id=stream.model_id, cost_usd=cost_usd, cost_known=cost_known,
        )
        yield emit("audio_end", {})

    if combined_sample_rate is None or combined_channels is None:
        yield {"__audio_filename__": None}
        return

    wav_bytes = interview_media.wrap_pcm_as_wav(bytes(pcm_buffer), sample_rate=combined_sample_rate, channels=combined_channels)
    filename = f"{uuid.uuid4()}.wav"
    key = f"interview-audio/{session_id}/{filename}"
    await to_thread(put_object, key, wav_bytes, "audio/wav")
    yield {"__audio_filename__": filename}


async def start_interview_session(
    session_factory: sessionmaker, *, session_id: uuid.UUID, user_id: uuid.UUID
) -> AsyncGenerator[dict, None]:
    """Kicks off the session's opening turn — the agent's first
    question — right after the row is created (routers/interview_sessions.py)."""

    with session_factory() as db:
        session_row = db.query(InterviewSession).filter_by(id=session_id, user_id=user_id).one_or_none()
        if session_row is None:
            yield _error_event("interview session not found")
            return
        persona_id = session_row.persona_id
        practice_type = session_row.practice_type
        thread_id = session_row.thread_id
        context = _session_context_block(db, session_row)
        run = _new_run(db, user_id=user_id, persona_id=persona_id, session_id=session_id)
        run_id = run.id

    emit = _make_emit(session_factory, user_id=user_id, run_id=run_id)
    opening_message = (
        f"{context}\n\nBegin the session now — your first turn, per your system prompt's own format "
        "for this practice_type."
    )

    reply_text = ""
    end_requested = False
    try:
        async for evt in _run_agent_turn(
            session_factory, practice_type=practice_type, thread_id=thread_id, run_id=run_id, user_id=user_id,
            human_message=opening_message, emit=emit,
        ):
            if "__reply__" in evt:
                reply_text = evt["__reply__"]
                continue
            if "__end_requested__" in evt:
                end_requested = evt["__end_requested__"]
                continue
            yield evt
        if not reply_text:
            await _finish_run(session_factory, run_id=run_id, status="failed")
            yield emit("error", {"message": "the agent returned no opening question"})
            return

        yield emit("stage", _stage("synthesizing", "started", "Synthesizing question audio"))
        audio_filename = None
        async for evt in _synthesize_stream_and_store(
            session_factory, session_id=session_id, text=reply_text, practice_type=practice_type,
            emit=emit, user_id=user_id, run_id=run_id,
        ):
            if "__audio_filename__" in evt:
                audio_filename = evt["__audio_filename__"]
                continue
            yield evt
        if audio_filename is not None:
            yield emit("stage", _stage("synthesizing", "done", "Ready"))
        await _finish_run(session_factory, run_id=run_id, status="completed")
        yield emit("done", {"reply_text": reply_text, "audio_filename": audio_filename})
        if end_requested:
            async for evt in _end_session_after_turn(session_factory, session_id=session_id, user_id=user_id, emit=emit):
                yield evt
    except Exception as exc:
        await _finish_run(session_factory, run_id=run_id, status="failed")
        yield emit("error", {"message": str(exc)[:500] or type(exc).__name__})


async def submit_turn(
    session_factory: sessionmaker,
    *,
    session_id: uuid.UUID,
    user_id: uuid.UUID,
    audio_bytes: bytes,
    filename: str,
    content_type: str,
) -> AsyncGenerator[dict, None]:
    """One recorded answer -> the agent's next turn. Every turn is its
    own separate HTTP request (real human time passes recording an
    answer between turns) — this is the per-turn entry point,
    start_interview_session above is only ever called once, at
    creation."""

    with session_factory() as db:
        session_row = db.query(InterviewSession).filter_by(id=session_id, user_id=user_id).one_or_none()
        if session_row is None:
            yield _error_event("interview session not found")
            return
        if session_row.status != "in_progress":
            yield _error_event(f"this session is already {session_row.status}")
            return
        practice_type = session_row.practice_type
        thread_id = session_row.thread_id
        run = _new_run(db, user_id=user_id, persona_id=session_row.persona_id, session_id=session_id)
        run_id = run.id

    emit = _make_emit(session_factory, user_id=user_id, run_id=run_id)

    try:
        yield emit("stage", _stage("transcribing", "started", "Transcribing your answer"))
        with session_factory() as db:
            transcription = await interview_media.transcribe(
                db, audio_bytes=audio_bytes, filename=filename, content_type=content_type,
            )
        transcript = transcription.text
        _log_audio_cost(
            session_factory, user_id=user_id, agent_run_id=run_id, stage="interview-practice-stt",
            provider=transcription.provider, model_id=transcription.model_id,
            cost_usd=transcription.cost_usd, cost_known=transcription.cost_known,
        )
        yield emit("stage", _stage("transcribing", "done", transcript))
        # Persisted as its own durable event (not just implied by the
        # agent's reply) — same fix orchestrator_service.py already
        # applied for the exact same reason: without this, reloading a
        # session's history would only ever show the agent's half.
        yield emit("message", {"role": "user", "text": transcript})

        reply_text = ""
        end_requested = False
        async for evt in _run_agent_turn(
            session_factory, practice_type=practice_type, thread_id=thread_id, run_id=run_id, user_id=user_id,
            human_message=transcript, emit=emit,
        ):
            if "__reply__" in evt:
                reply_text = evt["__reply__"]
                continue
            if "__end_requested__" in evt:
                end_requested = evt["__end_requested__"]
                continue
            yield evt
        if not reply_text:
            await _finish_run(session_factory, run_id=run_id, status="failed")
            yield emit("error", {"message": "the agent returned no reply"})
            return

        yield emit("stage", _stage("synthesizing", "started", "Synthesizing response audio"))
        audio_filename = None
        async for evt in _synthesize_stream_and_store(
            session_factory, session_id=session_id, text=reply_text, practice_type=practice_type,
            emit=emit, user_id=user_id, run_id=run_id,
        ):
            if "__audio_filename__" in evt:
                audio_filename = evt["__audio_filename__"]
                continue
            yield evt
        if audio_filename is not None:
            yield emit("stage", _stage("synthesizing", "done", "Ready"))
        await _finish_run(session_factory, run_id=run_id, status="completed")
        yield emit("done", {"reply_text": reply_text, "audio_filename": audio_filename})
        if end_requested:
            async for evt in _end_session_after_turn(session_factory, session_id=session_id, user_id=user_id, emit=emit):
                yield evt
    except interview_media.InterviewMediaError as exc:
        # Still a hard failure here — unlike a synthesis failure
        # (degraded to text-only above), a transcription failure means
        # there's no transcript to feed the agent at all, nothing to
        # recover gracefully from.
        await _finish_run(session_factory, run_id=run_id, status="failed")
        yield emit("error", {"message": str(exc)})
    except Exception as exc:
        await _finish_run(session_factory, run_id=run_id, status="failed")
        yield emit("error", {"message": str(exc)[:500] or type(exc).__name__})


def _build_transcript(db: Session, *, session_id: uuid.UUID, user_id: uuid.UUID) -> str:
    runs = (
        db.query(AgentRun)
        .filter_by(interview_session_id=session_id, user_id=user_id)
        .order_by(AgentRun.started_at)
        .all()
    )
    run_ids = [r.id for r in runs]
    if not run_ids:
        return ""
    events = (
        db.query(RunEvent)
        .filter(RunEvent.agent_run_id.in_(run_ids))
        .order_by(RunEvent.created_at, RunEvent.seq)
        .all()
    )
    lines: list[str] = []
    for event in events:
        if event.event_type == "message" and event.data.get("role") == "user":
            lines.append(f"Candidate: {event.data.get('text', '')}")
        elif event.event_type == "stage" and event.data.get("stage") == "agent" and event.data.get("status") == "done":
            lines.append(f"Interviewer: {event.data.get('message', '')}")
    return "\n\n".join(lines)


async def end_interview_session(
    session_factory: sessionmaker, *, session_id: uuid.UUID, user_id: uuid.UUID
) -> InterviewSession:
    """Scores the session from its real transcript and marks it
    completed — called either from the human clicking "End session"
    (routers/interview_sessions.py's own POST .../end), or
    automatically right after a turn in which the agent itself called
    end_interview (_end_session_after_turn below, only ever invoked
    once that turn's own "done" event — closing remark included — has
    already gone out)."""

    with session_factory() as db:
        session_row = db.query(InterviewSession).filter_by(id=session_id, user_id=user_id).one_or_none()
        if session_row is None:
            raise InterviewServiceError("interview session not found")
        if session_row.status != "in_progress":
            return session_row

        transcript = _build_transcript(db, session_id=session_id, user_id=user_id)
        if not transcript.strip():
            session_row.status = "cancelled"
            session_row.ended_at = datetime.now(timezone.utc)
            db.commit()
            db.refresh(session_row)
            return session_row

        try:
            model = resolve_tier(
                db, user_id=user_id, tier="balanced", stage="interview-practice-feedback",
                session_factory=session_factory,
            )
        except TierResolutionError as exc:
            raise InterviewServiceError(f"model routing not configured: {exc}") from exc

        feedback = run_interview_feedback(model, transcript=transcript, practice_type=session_row.practice_type)
        session_row.overall_score = feedback.overall_score
        session_row.feedback = feedback.model_dump()
        session_row.status = "completed"
        session_row.ended_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(session_row)
        return session_row


async def _end_session_after_turn(
    session_factory: sessionmaker, *, session_id: uuid.UUID, user_id: uuid.UUID, emit,
) -> AsyncGenerator[dict, None]:
    """The agent-initiated counterpart to a human clicking "End
    session" — same end_interview_session call underneath, wrapped
    with the SSE events the frontend needs to show a loading state
    while scoring runs (raised directly by Adrian: this can take a
    few real seconds, a real LLM call over the whole transcript) and
    then land straight on the results screen without a second round-
    trip. A scoring failure here is reported as an "error" event, not
    raised — the turn itself (and its "done" event) already succeeded
    by the time this runs, so this only ever degrades "the session
    also auto-scored" back to "the human can still press End session
    manually later", never the whole turn."""

    yield emit("stage", _stage("scoring", "started", "Wrapping up — scoring your session"))
    try:
        session_row = await end_interview_session(session_factory, session_id=session_id, user_id=user_id)
    except InterviewServiceError as exc:
        yield emit("error", {"message": f"the interview ended, but scoring failed: {exc}"})
        return
    yield emit(
        "session_ended",
        {
            "status": session_row.status,
            "overall_score": float(session_row.overall_score) if session_row.overall_score is not None else None,
            "feedback": session_row.feedback,
            "ended_at": session_row.ended_at.isoformat() if session_row.ended_at else None,
        },
    )
