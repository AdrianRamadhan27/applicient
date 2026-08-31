"""M7 — the top-level conversational orchestrator: drives a candidate
from "no plan yet" through Radar (discovery) -> grouping -> Composer
(tailoring) -> Pipeline (application execution), across one long-lived
chat conversation, informed by that known-good sequence without being
scripted to it.

Real `subagents=` dispatch (deepagents' own `task` tool) for the two
genuinely bounded, "run to completion and hand back a summary" stages
— discovery and tailoring — so a multi-minute internal back-and-forth
never becomes permanent context on every future turn of a conversation
meant to persist for days (unlike application_agent.py's single flat
agent, which never needed to worry about that: one attempt is
resolved same-session, not across weeks). Application execution is
deliberately NOT a subagent — see application_service.py's own
`start_application_attempt`, which already has an independent
lifecycle (its own checkpointer, its own interrupts meant to be
resolved through the existing Pipeline/Live Browser UI, possibly days
later). Nesting that compiled graph as a `task` dispatch would either
freeze this whole conversation on a pending submit-approval, or need a
second copy of Pipeline's own interrupt-resolution UI built inside
this chat. `run_application_agent` (orchestrator_tools.py) is a plain
tool instead: it drains the attempt only to its first pause or
completion and returns a short status, exactly like a human checking
in on a long-running job.

Note on deepagents' auto-added default `general-purpose` subagent: the
installed version (0.7.7) selects which "harness profile" gets used —
and therefore whether that default subagent exists at all — from the
bound model itself (`_harness_profile_for_model`), not from a
`create_deep_agent(...)` kwarg a caller can set directly. There is no
supported way to suppress it here without fighting an internal,
per-model mechanism this codebase has no business overriding. Left in
place deliberately: harmless extra surface given `discovery-agent`/
`tailoring-agent` already have clear, specific descriptions the model
has no real reason to route around.
"""

from __future__ import annotations

from langchain_core.language_models.chat_models import BaseChatModel
from langgraph.checkpoint.base import BaseCheckpointSaver

from deepagents import create_deep_agent

ORCHESTRATOR_SYSTEM_PROMPT = """You are the Assistant: a real, autonomous agent that drives a \
candidate through this app's own pipeline — Radar (discovery), grouping best-matched jobs, \
Composer (tailoring a CV and, if wanted, a cover letter), and Pipeline (running the \
application-agent) — in one ongoing conversation, across as many turns and as many days as it \
takes. You are not a scripted wizard: decide what to do next yourself, but stay informed by the \
sequence below rather than inventing an unrelated approach.

Default guided sequence — a working plan, not a script:
1. Call get_preferences. For any field that's empty, ask about it in plain chat, one topic at a \
   time — an empty field means "never asked," not "deliberately left blank." Save answers with \
   update_preferences as you get them. You may also just ask "what kind of job are you looking \
   for?" directly if the human would rather describe it in their own words than fill out fields.
2. Call ensure_saved_search with real role titles (from preferences or the conversation) once you \
   have enough to search on.
3. Call run_discovery. Progress streams live as it runs — you don't need to narrate every event \
   yourself, just report the real summary once it returns.
4. Your discovery-agent will have reported real job_id values with its summary — propose, in \
   plain chat, which of those best-matched jobs to pursue together. Get the human's explicit \
   confirmation on the actual jobs before delegating to your tailoring-agent — this is the first \
   real commitment in the pipeline, never assume.
5. Delegate to your tailoring-agent: give it the confirmed job_ids, a group name, and whether a \
   cover letter was requested (off by default, same as in Composer). Report whether the result \
   came back verified; a document that failed verification after 2 attempts is a real blocker to \
   surface plainly, not something to silently retry a third time (the underlying service hard-caps \
   at 2).
6. Call create_application_for_job for each job you're actually applying to, then \
   run_application_agent. The moment that tool returns anything other than a clean finish, stop — \
   tell the human plainly where to go (the Pipeline page, or its Live Browser view for a login/ \
   captcha handoff) to resolve it themselves. You do not, and cannot, resolve that pause yourself. \
   Use check_application_attempt_status on a later turn if asked how it's going — never re-run \
   run_application_agent just to check.

Rules that apply throughout, not just at one step:
- You are always allowed to skip, reorder, or revisit a step whose real state already covers it — \
  check before redoing work (e.g. preferences already set, a saved search already active).
- Call ask_user at most once per response, and only for a genuinely blocking, ambiguous decision, \
  or to confirm before a real-cost step (tailoring, running the application agent) actually starts. \
  Ordinary clarifying questions are just your normal reply — wait for the human's next message, \
  don't use ask_user for those.
- Never invent a job, a salary figure, a company fact, or a document outcome that no real tool \
  call actually returned to you.
- Delegate the discovery and tailoring stages to your discovery-agent and tailoring-agent \
  subagents rather than trying to call their underlying tools yourself — they exist so a long \
  internal back-and-forth for one stage doesn't become permanent context on every future turn of \
  this conversation."""

_DISCOVERY_SUBAGENT_PROMPT = """You are the discovery-agent: given real role titles and this \
persona's real preferences, make sure a usable saved search exists (ensure_saved_search), run a \
real discovery pass (run_discovery), and report back the best-matched jobs (list_top_jobs) — job \
titles, companies, locations, scores, and their real job_id values. Never invent a job that isn't \
in a real tool's output. Optionally call discover_companies first if the orchestrator asked you to \
find new companies to add as sources, rather than just searching what's already configured. Return \
a compact summary — the orchestrator only needs your final answer, not your internal reasoning."""

_TAILORING_SUBAGENT_PROMPT = """You are the tailoring-agent: given a group name, a list of \
already-human-confirmed job_id values, and whether a cover letter was requested, call \
create_job_group first, then tailor_cv on the group it returns, and generate_cover_letter_tool too \
only if one was actually requested. Report back whether each document came back verified — a \
document that failed verification after 2 attempts is a real outcome to report plainly, never \
something to silently retry further (the underlying service already hard-caps at 2 attempts). \
Return a compact summary, including the job_group_id and any document_id you produced — the \
orchestrator only needs your final answer, not your internal reasoning."""


def build_orchestrator_agent(
    *,
    model: BaseChatModel,
    discovery_model: BaseChatModel,
    tailoring_model: BaseChatModel,
    tools: list,
    checkpointer: BaseCheckpointSaver,
):
    """`tools` is the FULL tool list from `build_orchestrator_tools`.
    `tools=` below is deliberately a narrow subset, not the full list
    — `subagents=`'s own `tools` overrides are ADDITIVE scoping for
    calls made via `task` dispatch, not a restriction on the top-level
    agent's own tool access, so passing the full list here would give
    the top-level agent direct access to run_discovery/tailor_cv
    anyway, defeating the entire point of isolating those stages'
    context into their own subagents."""

    tools_by_name = {getattr(t, "name", None): t for t in tools}

    def _subset(*names: str) -> list:
        return [tools_by_name[name] for name in names if name in tools_by_name]

    return create_deep_agent(
        model=model,
        tools=_subset(
            "get_preferences", "update_preferences",
            "create_application_for_job", "run_application_agent", "check_application_attempt_status",
            "ask_user",
        ),
        system_prompt=ORCHESTRATOR_SYSTEM_PROMPT,
        subagents=[
            {
                "name": "discovery-agent",
                "description": (
                    "Runs job discovery for this persona: ensures a saved search exists, runs it, "
                    "and reports back the best-matched jobs found. Call this instead of the "
                    "discovery tools directly."
                ),
                "system_prompt": _DISCOVERY_SUBAGENT_PROMPT,
                "tools": _subset("discover_companies", "ensure_saved_search", "run_discovery", "list_top_jobs"),
                "model": discovery_model,
            },
            {
                "name": "tailoring-agent",
                "description": (
                    "Tailors a CV (and, if asked, a cover letter) for an already-confirmed job "
                    "group, and reports whether the result was verified. Call this instead of the "
                    "tailoring tools directly."
                ),
                "system_prompt": _TAILORING_SUBAGENT_PROMPT,
                "tools": _subset("create_job_group", "tailor_cv", "generate_cover_letter_tool"),
                "model": tailoring_model,
            },
        ],
        interrupt_on={"ask_user": {"allowed_decisions": ["respond"]}},
        checkpointer=checkpointer,
    )
