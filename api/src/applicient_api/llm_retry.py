"""One retry, for two known-transient failure shapes around a
structured-output `.invoke()` call — shared by scoring_engine.py,
tailoring_engine.py, and claim_verifier.py rather than three copies of
the same retry logic drifting apart.

1. A free/cheap reasoning-capable model occasionally spends its whole
   completion budget on internal reasoning and never emits the actual
   structured answer — confirmed live: `nvidia/nemotron-3.5-lightning:free`
   (the fast tier) returned `content=''` with no `parsed` or `refusal`
   field after 3,270 real completion tokens, which langchain_openai
   surfaces as a plain `ValueError` with this exact message (checked
   against its own source, chat_models/base.py). Nondeterministic model
   flakiness, not a real conversation error — retrying immediately
   after often succeeds since nothing about the prompt changed.

2. A real network failure reaching the provider (confirmed live during
   a radar run — "network error when scoring") — `openai.APIConnectionError`/
   `APITimeoutError` are the openai SDK's own types for this, not a
   model or prompt problem, and a transient blip is often gone a moment
   later.

Retried once, not looped indefinitely: a caller that fails twice in a
row gets no result and the caller decides what "no result" means for
it (scoring: no PrefilterResult/FitScore row this run, naturally
retried on a later run; tailoring/verification: the whole pipeline
call fails, surfaced as an error same as any other failure).
"""

from __future__ import annotations

from openai import APIConnectionError, APITimeoutError

_EMPTY_STRUCTURED_OUTPUT_MARKER = "does not have a 'parsed' field nor a 'refusal' field"


def invoke_structured_with_retry(structured, messages):
    try:
        return structured.invoke(messages)
    except ValueError as e:
        if _EMPTY_STRUCTURED_OUTPUT_MARKER not in str(e):
            raise
        return structured.invoke(messages)
    except (APIConnectionError, APITimeoutError):
        return structured.invoke(messages)
