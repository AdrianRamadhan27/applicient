# Applicient

An agentic job-application system. Finds openings across portals, ATS boards, company career sites and social posts; scores them against your qualifications; drafts a tailored CV it can prove is truthful; helps you apply; and tracks the pipeline from your inbox.

Built on [LangChain deepagents](https://github.com/langchain-ai/deepagents). Provider-agnostic — runs on Anthropic, OpenAI, Gemini, OpenRouter, or a local model, switchable at runtime.

**Status:** M0 complete — local CV ingest, evidence verification, model routing, and cost ledger are runnable; discovery starts in M1.

- [Product requirements](docs/PRD.md)
- [Implementation index](docs/IMPLEMENTATION.md)
- [M0 implementation checklist](docs/M0_IMPLEMENTATION.md)
- [M1 implementation checklist](docs/M1_IMPLEMENTATION.md)

## Setup

Start the local infrastructure, migrate and seed the database, then run the API and web app:

```bash
cp .env.example .env
# Set SECRET_KEY to a Fernet key; provider keys are added in the GUI.
docker compose up -d
cd api && uv run alembic upgrade head && uv run python -m applicient_api.seed
uv run uvicorn applicient_api.main:app --reload
```

In a second terminal:

```bash
cd web && pnpm install && pnpm dev
```

Open `/models` first to add, test, and catalog a provider, save the `deep` and `embedding` tier bindings, then use `/profile` to upload and confirm a CV. The `/cost` page shows the metered calls. See [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) for current status.

## License

MIT — see [LICENSE](LICENSE).
