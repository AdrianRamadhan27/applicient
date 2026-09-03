"""Phase 11 (v2 plan) — speech-to-text and text-to-speech for interview
practice. Not routed through resolve_tier/ModelProfile (that whole
abstraction is chat-completion-shaped only — no tier/stage_overrides
concept has ever meant "audio in/out") but still reuses the SAME
already-configured, encrypted `ProviderConnection` credentials
(models/llm.py) admins set up for chat/embeddings, rather than a new
standalone env var — confirmed live that this app's actual model
catalog and its default provider are both already OpenRouter-shaped
(`providers/openrouter.py`'s own docstring: "ships as the default
provider... one key runs the whole product"), and OpenRouter's own
catalog (checked live: `GET /api/v1/models?output_modalities=transcription`
/`speech`) genuinely lists real, priced transcription and speech
models today, OpenAI's own included — so one already-configured
OpenRouter connection covers both this app's chat models AND
interview-practice audio, no second integration needed for most
deployments. Direct OpenAI is supported too (Adrian asked for both).

Confidence gap, disclosed rather than assumed complete: OpenRouter's
audio endpoints are assumed to mirror OpenAI's own
`/audio/transcriptions` / `/audio/speech` request shape exactly, the
same way its chat/completions endpoint does — consistent with every
other OpenAI-compatible surface OpenRouter exposes, but not yet
confirmed against a real authenticated call the way the model listing
above was. A wrong assumption here fails loudly (a real HTTP error
from a live provider), not silently.
"""

from __future__ import annotations

import re
import struct
import uuid
from collections.abc import AsyncGenerator
from typing import NamedTuple

import httpx
from sqlalchemy.orm import Session

from applicient_api.models.llm import AudioSettings, ModelCatalogEntry, ProviderConnection
from applicient_api.security import decrypt_api_key

# Same fixed defaults tier_resolution.py uses for the only two
# providers this module talks to.
_BASE_URLS = {
    "openrouter": "https://openrouter.ai/api/v1",
    "openai": "https://api.openai.com/v1",
}

# Provider preference order — OpenRouter first (this app's own default
# provider, and its Deepgram Aura-2 catalog entry alone has ~90 distinct
# named voices, useful for giving FGD/LGD's several simulated speakers
# genuinely different-sounding voices), OpenAI direct as the fallback
# if only that one is configured.
_PROVIDER_PREFERENCE = ("openrouter", "openai")

_DEFAULT_TRANSCRIBE_MODEL = {"openrouter": "openai/whisper-1", "openai": "whisper-1"}
_DEFAULT_SPEECH_MODEL = {"openrouter": "deepgram/aura-2", "openai": "tts-1"}
_DEFAULT_VOICE = {"openrouter": "aura-2-luna-en", "openai": "alloy"}
# FGD/LGD's "everyone who isn't the moderator" voice — a deliberately
# different-sounding real voice from _DEFAULT_VOICE above (checked
# against each provider's own real voice list: both are confirmed
# real ids, not guessed), so a deployment that hasn't configured Audio
# Settings at all still gets two audibly distinct voices out of the
# box rather than one person reading every part.
_DEFAULT_SECONDARY_VOICE = {"openrouter": "aura-2-apollo-en", "openai": "onyx"}


class InterviewMediaError(Exception):
    pass


def _find_connection(db: Session, provider: str) -> ProviderConnection | None:
    # Deployment-wide, not filtered by whichever admin configured it —
    # same "not really per-user" treatment resolve_tier's own
    # active_model_profile gives ModelProfile (tier_resolution.py:97-111).
    return (
        db.query(ProviderConnection)
        .filter_by(provider=provider)
        .order_by(ProviderConnection.updated_at.desc())
        .first()
    )


def _resolve_connection(db: Session) -> ProviderConnection:
    for provider in _PROVIDER_PREFERENCE:
        conn = _find_connection(db, provider)
        if conn is not None:
            return conn
    raise InterviewMediaError(
        "no OpenAI or OpenRouter provider connection is configured — "
        "an admin must add one in Models & Providers before interview practice can run"
    )


def _base_url(conn: ProviderConnection) -> str:
    return conn.base_url or _BASE_URLS.get(conn.provider, _BASE_URLS["openrouter"])


def _find_catalog_entry(db: Session, *, provider_connection_id, model_id: str) -> ModelCatalogEntry | None:
    """The specific catalog row a just-completed call actually used —
    same "most recently refreshed" tiebreak connections.py's own
    upsert already relies on being unique per (connection, model_id)."""

    return (
        db.query(ModelCatalogEntry)
        .filter_by(provider_connection_id=provider_connection_id, model_id=model_id)
        .order_by(ModelCatalogEntry.fetched_at.desc())
        .first()
    )


# Models & Providers' Audio section (Phase 11 v2 plan follow-up) lets
# an admin pin a specific catalog entry for each direction; when
# they haven't (or the row/entry they picked no longer resolves — a
# deleted connection, an un-refreshed catalog), these two fall back to
# the hardcoded defaults above exactly as before, so a zero-config
# deployment keeps working unchanged.
def _resolve_transcribe_target(db: Session) -> tuple[ProviderConnection, str]:
    settings = db.query(AudioSettings).first()
    if settings is not None and settings.transcribe_catalog_entry_id is not None:
        entry = db.get(ModelCatalogEntry, settings.transcribe_catalog_entry_id)
        if entry is not None:
            conn = db.get(ProviderConnection, entry.provider_connection_id)
            if conn is not None:
                return conn, entry.model_id
    conn = _resolve_connection(db)
    return conn, _DEFAULT_TRANSCRIBE_MODEL.get(conn.provider, _DEFAULT_TRANSCRIBE_MODEL["openrouter"])


def _resolve_speech_target(db: Session, *, secondary: bool = False) -> tuple[ProviderConnection, str, str | None]:
    """`secondary=True` resolves the FGD/LGD "everyone but the
    moderator" voice instead of the primary moderator/interviewer
    one — same model/provider either way (Audio Settings only ever
    configures one speech model), just a different voice string."""

    settings = db.query(AudioSettings).first()
    if settings is not None and settings.speech_catalog_entry_id is not None:
        entry = db.get(ModelCatalogEntry, settings.speech_catalog_entry_id)
        if entry is not None:
            conn = db.get(ProviderConnection, entry.provider_connection_id)
            if conn is not None:
                configured = settings.speech_voice_secondary if secondary else settings.speech_voice
                # Falls back to the CATALOG's own second listed voice
                # (not the first, when picking the secondary one and a
                # second option exists) rather than reusing the exact
                # same voice as the primary — still better than one
                # voice for the whole discussion even with zero admin
                # configuration.
                fallback_index = 1 if secondary and entry.voices and len(entry.voices) > 1 else 0
                voice = configured or (entry.voices[fallback_index] if entry.voices else None)
                return conn, entry.model_id, voice
    conn = _resolve_connection(db)
    model = _DEFAULT_SPEECH_MODEL.get(conn.provider, _DEFAULT_SPEECH_MODEL["openrouter"])
    defaults = _DEFAULT_SECONDARY_VOICE if secondary else _DEFAULT_VOICE
    voice = defaults.get(conn.provider, defaults["openrouter"])
    return conn, model, voice


class TranscriptionResult(NamedTuple):
    text: str
    cost_usd: float
    cost_known: bool
    provider: str
    model_id: str


async def _post_transcription(client: httpx.AsyncClient, *, url, api_key, model, response_format, filename, audio_bytes, content_type):
    return await client.post(
        url,
        headers={"Authorization": f"Bearer {api_key}"},
        data={"model": model, "response_format": response_format},
        files={"file": (filename, audio_bytes, content_type or "audio/webm")},
    )


async def transcribe(db: Session, *, audio_bytes: bytes, filename: str, content_type: str) -> TranscriptionResult:
    """Speech -> text for one recorded turn.

    Requests `response_format=verbose_json` (a real, standard Whisper
    API parameter both providers support) specifically for the cost —
    confirmed live it unlocks two things over the plain default:
    OpenRouter echoes back its own authoritative real-time
    `usage.cost` for the call (trusted directly when present, no
    guessing), and — the portable fallback for OpenAI direct, which
    doesn't add that field — a real `duration` in seconds, priced
    against the catalog's own `price_per_minute` (ModelCatalogEntry's
    own docstring has the live-verified reasoning for why that unit is
    trustworthy here).

    NOT every STT model actually supports verbose_json, though — hit
    live: an admin-selected model (microsoft/mai-transcribe-1.5, via
    Audio Settings) 400s outright with "does not support
    response_format \"verbose_json\". Use \"json\" instead." Rather
    than let a whole turn's transcription fail over a cost-tracking
    nicety, that specific failure retries once with the plain default
    format — the transcript itself is unaffected either way, only the
    cost degrades to cost_known=False for models that don't support
    the richer one."""

    conn, model = _resolve_transcribe_target(db)
    api_key = decrypt_api_key(conn.api_key_encrypted)
    url = f"{_base_url(conn)}/audio/transcriptions"

    async with httpx.AsyncClient(timeout=60) as client:
        try:
            resp = await _post_transcription(
                client, url=url, api_key=api_key, model=model, response_format="verbose_json",
                filename=filename, audio_bytes=audio_bytes, content_type=content_type,
            )
            if resp.status_code == 400 and "response_format" in resp.text:
                resp = await _post_transcription(
                    client, url=url, api_key=api_key, model=model, response_format="json",
                    filename=filename, audio_bytes=audio_bytes, content_type=content_type,
                )
        except httpx.RequestError as exc:
            raise InterviewMediaError(f"could not reach {conn.provider} for transcription: {exc}") from exc

    if resp.status_code >= 400:
        raise InterviewMediaError(f"{conn.provider} transcription failed: {resp.status_code} {resp.text[:300]}")

    data = resp.json()
    text = data.get("text")
    if not text:
        raise InterviewMediaError(f"{conn.provider} transcription returned no text: {data}")

    usage = data.get("usage") or {}
    if "cost" in usage:
        cost_usd, cost_known = float(usage["cost"]), True
    else:
        duration_seconds = data.get("duration")
        with_entry = _find_catalog_entry(db, provider_connection_id=conn.id, model_id=model)
        if duration_seconds is not None and with_entry is not None and with_entry.price_per_minute is not None:
            cost_usd, cost_known = float(duration_seconds) / 60.0 * float(with_entry.price_per_minute), True
        else:
            cost_usd, cost_known = 0.0, False

    return TranscriptionResult(text=text, cost_usd=cost_usd, cost_known=cost_known, provider=conn.provider, model_id=model)


def estimate_speech_cost(
    db: Session, *, provider: str, model_id: str, provider_connection_id, char_count: int
) -> tuple[float, bool]:
    """TTS's own cost, computed from the catalog's price_per_character
    — unlike transcription, no provider response field was found to
    carry this authoritatively (checked live: OpenRouter's own
    `X-Generation-Id` header 404s against `/generation` for a TTS
    call, unlike a chat completion), so this is the only real signal
    available. `provider` is unused today but kept for symmetry/
    future per-provider branching, same shape as the transcribe side."""

    del provider  # not needed yet — see docstring
    entry = _find_catalog_entry(db, provider_connection_id=provider_connection_id, model_id=model_id)
    if entry is None or entry.price_per_character is None:
        return 0.0, False
    return char_count * float(entry.price_per_character), True


# Real behavior, checked live against openrouter+deepgram/aura-2 (a
# curl session, `output_modalities=speech`'s own error body for an
# invalid format): response_format is genuinely a closed enum per
# model — this model accepts exactly "mp3"/"pcm", nothing else (a
# "wav" request 400s outright) — and, more importantly, the response
# is ALREADY sent chunked (Transfer-Encoding: chunked, first bytes
# arriving in ~1-1.5s, the rest trickling in over several more seconds
# for a short reply) regardless of which format is requested — this
# module just wasn't reading it that way. "pcm" is requested
# specifically (not mp3) for two real, measured reasons: it's faster
# end-to-end (no server-side encoding step — same request/text timed
# ~2.8s total vs ~4.5s for mp3), and raw samples can be scheduled for
# gapless playback as they arrive without needing to understand a
# compressed frame format, which is what makes real client-side
# streaming playback tractable at all.
def _parse_pcm_format(content_type: str) -> tuple[int, int]:
    """Parses "audio/pcm;rate=24000;channels=1"-shaped content-types —
    never assumed, since a different provider/model could report a
    different rate. Falls back to 24kHz mono (every model this app
    defaults to reports exactly that) only if the header is missing
    the field entirely."""

    rate = re.search(r"rate=(\d+)", content_type)
    channels = re.search(r"channels=(\d+)", content_type)
    return (int(rate.group(1)) if rate else 24000, int(channels.group(1)) if channels else 1)


def wrap_pcm_as_wav(pcm_bytes: bytes, *, sample_rate: int, channels: int, bits_per_sample: int = 16) -> bytes:
    """A bare PCM stream has no header at all — nothing in it says what
    sample rate/channel count/bit depth to interpret it as, so it can't
    be handed to a plain <audio> element or stored as a file on its
    own. This wraps it in the standard 44-byte canonical WAV header
    (format code 1 = integer PCM) once a turn's full stream has been
    collected, purely so the ALREADY-PLAYED-live clip can still be
    stored for replay later (routers/interview_sessions.py's own
    GET .../audio/{filename}) — the live playback path itself
    (interview-practice/page.tsx) never touches this, it consumes raw
    chunks directly via the Web Audio API as they arrive."""

    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    data_size = len(pcm_bytes)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + data_size, b"WAVE",
        b"fmt ", 16, 1, channels, sample_rate, byte_rate, block_align, bits_per_sample,
        b"data", data_size,
    )
    return header + pcm_bytes


class SpeechStream(NamedTuple):
    sample_rate: int
    channels: int
    provider: str
    model_id: str
    provider_connection_id: uuid.UUID
    chunks: AsyncGenerator[bytes, None]


async def synthesize_stream(
    db: Session, *, text: str, voice: str | None = None, secondary: bool = False
) -> SpeechStream:
    """Text -> speech for one agent turn (or one FGD/LGD speaker's own
    segment — interview_service.py's own _synthesize_stream_and_store
    now synthesizes each speaker's lines separately, `secondary=True`
    for anyone who isn't the moderator, so a group discussion actually
    sounds like more than one person). Returns a SpeechStream rather
    than one block of bytes — the caller forwards each chunk to the
    client as it arrives instead of waiting for the whole clip, then
    wraps everything collected into a WAV file for storage once the
    stream ends. `provider`/`model_id`/`provider_connection_id` ride
    along so the caller can price the call afterward
    (estimate_speech_cost, once the real character count sent is
    known) without a second DB round-trip to re-resolve which
    connection/model this turn actually used. The httpx client/
    response are kept open for the chunk iterator's whole lifetime
    (closed in its own `finally`, not here) since this function
    returns before the caller has consumed a single chunk."""

    conn, model, default_voice = _resolve_speech_target(db, secondary=secondary)
    api_key = decrypt_api_key(conn.api_key_encrypted)
    # An explicit `voice` argument (none of this module's own callers
    # pass one today) still wins over both the admin's configured
    # default and the hardcoded fallback — same override precedence
    # this function already had before Audio Settings existed.
    defaults = _DEFAULT_SECONDARY_VOICE if secondary else _DEFAULT_VOICE
    resolved_voice = voice or default_voice or defaults.get(conn.provider, defaults["openrouter"])
    url = f"{_base_url(conn)}/audio/speech"
    body = {"model": model, "input": text, "voice": resolved_voice, "response_format": "pcm"}

    client = httpx.AsyncClient(timeout=60)
    try:
        resp = await client.send(
            client.build_request("POST", url, headers={"Authorization": f"Bearer {api_key}"}, json=body),
            stream=True,
        )
    except httpx.RequestError as exc:
        await client.aclose()
        raise InterviewMediaError(f"could not reach {conn.provider} for speech synthesis: {exc}") from exc

    if resp.status_code >= 400:
        error_body = (await resp.aread())[:300]
        await resp.aclose()
        await client.aclose()
        raise InterviewMediaError(f"{conn.provider} speech synthesis failed: {resp.status_code} {error_body}")

    sample_rate, channels = _parse_pcm_format(resp.headers.get("content-type", ""))

    async def _chunks() -> AsyncGenerator[bytes, None]:
        try:
            async for chunk in resp.aiter_bytes():
                if chunk:
                    yield chunk
        except httpx.HTTPError as exc:
            raise InterviewMediaError(f"{conn.provider} speech stream dropped mid-way: {exc}") from exc
        finally:
            await resp.aclose()
            await client.aclose()

    return SpeechStream(
        sample_rate=sample_rate, channels=channels, provider=conn.provider, model_id=model,
        provider_connection_id=conn.id, chunks=_chunks(),
    )
