# Applicient — M1 Implementation Checklist

Working checklist for the M1 Walking Skeleton milestone. Check items off as they're done; update the **Status** line at each step when something changes. See [PRD.md](PRD.md) for the requirements and decisions this is built from.

**Status:** M1 not started. The checklist is ready.

---

## Scope

M1 is the first thin vertical slice after the foundation: a saved role search fans out to one ATS source and one aggregator, produces canonical jobs with preserved source lineage, deduplicates them, runs cheap prefiltering followed by the full structured fit rubric, and displays an auditable ranked Inbox with per-run cost.

**M1 source choice:** start with a Greenhouse board/API adapter as the ATS source and a JSearch adapter as the aggregator. Both are behind the same source-adapter contract, so replacing either source does not change normalization, deduplication, scoring, or the UI. Keep all source credentials/configuration in the database-backed source configuration; never put them in agent code or committed environment files.

**M1 exit bar:** a user with a confirmed profile can enter target roles, run the search, see raw-source telemetry and canonical jobs, get ranked structured scores with evidence spans in Job Inbox, see the run's LLM/embedding cost in Cost & Usage, rerun without duplicate jobs, and repeat the run after changing the active provider/model profile from the Models screen.

## 1. Contracts and schema delta

- [ ] Audit the existing PRD §9 models and first migration against the M1 data contract before adding code; record every required schema change rather than hiding it in service logic.
- [ ] Define the source contract: `search(query, filters) -> list[RawPosting]`, `fetch_detail(url) -> RawPosting`, declared capabilities, auth requirements, rate-limit configuration, and a stable adapter key. Validate adapter output with Pydantic before persistence.
- [ ] Define `RawPosting` with source URL, external requisition ID, title, company, location, remote policy, seniority, employment type, salary fields, posted date, requirements, responsibilities, benefits, apply URL, and the untouched provider payload.
- [ ] Add the minimum schema delta for canonical deduplication and scoring history: a normalized/canonical job key, safe uniqueness constraints for source requisition IDs, score version/prefilter state, and any run/source linkage needed for cost attribution. Preserve all existing rows during migration.
- [ ] Hand-review the migration, test upgrade/downgrade on the real Postgres container, and keep `alembic check` at zero drift. Add deterministic fixtures for both adapters, duplicate postings, salary-missing postings, and representative profile/persona data.

## 2. Source adapters

- [ ] Implement the Greenhouse ATS adapter with configured board/company scope, pagination, detail fetch, external requisition IDs, canonical ATS apply URLs, request timeouts, retry/backoff, and fixture-backed tests.
- [ ] Implement the JSearch aggregator adapter with API-key configuration, query/filter translation, pagination, provider request identifiers, and fixture-backed tests. A missing or invalid aggregator key must fail that source run clearly without failing the whole radar run.
- [ ] Add a shared HTTP client policy for Tier 1 sources: per-source rate limits, bounded retries, jitter, timeout, response-size guard, and circuit-breaker updates for repeated 403/429 responses. Do not add browser scraping to M1.
- [ ] Record a `SourceRun` for every source attempt, including started/finished timestamps, postings seen/new/deduped, structured errors, and source-attributed cost. One failed source must leave the other source's results usable.
- [ ] Add adapter contract tests that run without network access, plus one opt-in live smoke test per configured source. Redact API keys and raw authorization headers from errors, traces, and persisted telemetry.

## 3. Saved search and radar run

- [ ] Add the minimal saved-search API and UI: name, one or more target role titles, persona binding, selected sources, optional location/remote/seniority filters, and active state. Keep cron scheduling out of M1; manual run is the vertical-slice trigger.
- [ ] Expand each role title into source-appropriate query variants using a structured fast/balanced-tier call, with deterministic fallback variants when the model call fails. Persist the expanded queries in the run trace.
- [ ] Implement a resumable radar-run service that creates an `AgentRun`, fans out the selected adapters, isolates source errors, persists progress, and exposes run status through the existing SSE/Run Console path.
- [ ] Make reruns idempotent: the same source posting updates its sighting and canonical job instead of creating a second job; a partial run can resume from completed source/query work without restarting the whole run.
- [ ] Enforce the confirmed-profile/persona precondition before scoring, snapshot the active model profile and profile revision on the run, and stop cleanly with an actionable error when either is missing.

## 4. Normalization, lineage and deduplication

- [ ] Normalize every `RawPosting` into the canonical `Job` shape. Normalize Unicode/case/whitespace for comparison only; retain the original display values and raw payload. Normalize dates to timezone-aware UTC and preserve unknown values as null.
- [ ] Parse salary only when the source states it, preserve the source currency and range, and leave salary null when absent or ambiguous. The UI must say “not stated”; no market estimate or inferred band is allowed.
- [ ] Upsert `Company` and canonical `Job` rows while preserving every `JobSighting`. Store first-seen/last-seen timestamps and source posted dates so repost and stale-job signals can be explained later.
- [ ] Implement the required deduplication order: exact source/ATS requisition ID first, normalized company+title+location key second, and embedding cosine similarity over the job body third. Make the threshold/configuration explicit and test false-positive/false-negative cases.
- [ ] Embed job descriptions through the configured `embedding` tier in bounded batches with retry/backoff and checkpointing. A throttled embedding call pauses/resumes the run; it must not discard already normalized jobs or sightings.
- [ ] Prefer the company's ATS sighting as `apply_url` when the same job is also present through the aggregator, while keeping every source URL visible in the job detail and score breakdown.
- [ ] Compute the M1-visible ghost/staleness signals from first sighting age, repost count, posted-date resets, and boilerplate indicators; surface them as red flags with reasons rather than silently filtering jobs. Defer external company enrichment and hiring-velocity research to a later milestone.

## 5. Two-stage fit scoring

- [ ] Define schema-validated `PrefilterResult` and `FitRubricResult` contracts. The full result must include recommendation, overall score, independent dimensions, hard requirements, skill match groups, evidence spans, gap closers, red flags, and the scoring/prompt version.
- [ ] Implement the cheap prefilter on the `fast` tier: keep/drop (or review) plus a one-line reason. Persist the result and never delete dropped postings; the user can inspect why a job did not reach the expensive pass.
- [ ] Implement the full rubric on the `balanced` tier for survivors, using only confirmed profile/persona data and retrieved evidence summaries. No agent, prompt, tool, or test may name a concrete model; resolve models through capability tiers.
- [ ] Score hard requirements, experience delta, matched/partial/missing skills, seniority, domain, location/work authorization, salary overlap, company stage, and language independently. Salary-not-stated is `unknown` and excluded from the weighted total, never treated as zero.
- [ ] Apply experience gaps as a ranking penalty, not a blocker. Apply hard blockers for configured authorization, certification, and excluded-location constraints; emit the blocker and force `skip` when one fires.
- [ ] Validate every evidence span against the stored job text, persist the structured score plus model/profile/revision/cost metadata, and append a new score when the profile or persona changes instead of silently overwriting history.
- [ ] Add scoring tests for schema failure/retry, unknown salary, experience stretch roles, hard blockers, evidence-span grounding, recommendation thresholds, and a deterministic mocked-provider run. Add an opt-in live-provider scoring smoke test.

## 6. Job Inbox and score audit UI

- [ ] Add read APIs for ranked jobs, latest score per persona, source sightings, score dimensions, evidence spans, gap closers, red flags, salary state, and apply links. Support recommendation, source, location, and score-band filters.
- [ ] Replace the `/radar` placeholder with a real saved-search/run screen showing sources, run progress, source errors, counts, and rerun controls. Keep loading, empty, partial-failure, and failed-run states explicit.
- [ ] Replace the `/inbox` placeholder with a real ranked feed. Each card shows recommendation, score, role/company, location/remote policy, salary or “not stated,” source lineage, top reasons, red flags, and the preferred apply URL.
- [ ] Add the score-breakdown drawer with every dimension, exact evidence spans, matched/partial/missing skills, hard blockers, gap closers, ghost-job reasoning, scoring revision, and cost. Do not present a bare number without its audit trail.
- [ ] Verify the Inbox uses API data only: no sample jobs in production rendering, clear API error states, accessible keyboard navigation, and responsive behavior consistent with the Terminal Ledger shell.

## 7. Cost & Usage v1 and provider breadth

- [ ] Extend cost aggregation to cover a radar `AgentRun`, each `SourceRun`, discovery/query expansion, embedding, prefilter, and full scoring. Show known versus unknown cost without converting unknown into zero.
- [ ] Add a v1 Cost & Usage API with time range, run, source, stage, tier, provider, and model breakdowns plus recent calls. Preserve the stamped pricing version and fallback/provider substitution on every ledger row.
- [ ] Replace the `/cost` placeholder with a real dashboard showing total spend, call/token counts, unknown-cost calls, run history, stage breakdown, and cost per newly discovered/scored job. Keep it useful with zero-cost local/free models.
- [ ] Add the remaining provider adapters named in PRD F12.3: OpenAI, Google AI Studio, Mistral, Ollama/vLLM, and generic `openai_compatible` with `base_url`. Each must support test connection, catalog refresh, normalized capabilities, and pricing-known/unknown behavior.
- [ ] Verify provider switching through the Models screen: change one tier binding, rerun the same saved search, and confirm the new run/calls identify the new provider/model while the agent and scoring code remain unchanged.

## 8. Reliability, observability and exit verification

- [ ] Stream radar progress and source/scoring steps through `AgentStep`/SSE, including subagent/stage names, status, errors, and accumulated cost; the Run Console must show a real run rather than a static placeholder.
- [ ] Add integration coverage against the real Postgres/Redis stack for adapter-result persistence, three-signal deduplication, score history, run failure isolation, idempotent reruns, and cost rollups. Keep external-provider tests opt-in and fixture tests deterministic.
- [ ] Run the full M1 acceptance path: confirmed profile → target roles → manual radar run → two source adapters → normalized jobs/sightings → dedup → prefilter → full rubric → ranked Inbox → score drawer → Cost & Usage.
- [ ] Verify the exit bar with a rerun and a provider change: no duplicate canonical jobs, source lineage retained, costs attributable to the run, and the same path completes after changing one model-tier binding in the GUI.
- [ ] **M1 done** when the PRD §14 exit criterion is demonstrated and recorded in the log: role list in, ranked scored jobs out, per-run cost visible, and the loop rerunnable on a different provider by changing one dropdown.

**Explicitly deferred from M1:** browser/portal scraping, social leads, company web research, already-applied imports, scheduling, Gmail/email intelligence, document tailoring, claim verification, application execution, bulk apply, and the full eval-suite CI gate. Those remain mapped to the later roadmap milestones in PRD §14.

---

## Log

Short entries only — what changed, what's next, anything worth remembering. Newest first.

- **2026-08-19** — M1 checklist split out from the shared implementation document. No M1 implementation has started yet; the exit bar remains the PRD §14 role-list → ranked Inbox → cost-visible → provider-switchable loop.
