# Applicient

An agentic job-application system. Finds openings across portals, ATS boards, company career sites and social posts; scores them against your qualifications; drafts a tailored CV it can prove is truthful; helps you apply; and tracks the pipeline from your inbox.

Built on [LangChain deepagents](https://github.com/langchain-ai/deepagents). Provider-agnostic — runs on Anthropic, OpenAI, Gemini, OpenRouter, or a local model, switchable at runtime.

**Status:** M0 complete — local CV ingest, evidence verification, model routing, and cost ledger are runnable; discovery starts in M1.

- [Product requirements](docs/PRD.md)
- [Implementation index](docs/IMPLEMENTATION.md)
- [M0 implementation checklist](docs/M0_IMPLEMENTATION.md)
- [M1 implementation checklist](docs/M1_IMPLEMENTATION.md)

## Setup

Docker Compose includes Postgres with pgvector, Redis, MinIO, the API, and the web app. Docker is the only required local dependency. From a fresh clone:

```bash
docker compose up --build
```

Then open [http://localhost:3000](http://localhost:3000). The API is available at [http://localhost:8000](http://localhost:8000), and the MinIO console is at [http://localhost:9001](http://localhost:9001).

The first build downloads the pinned Python and Node dependencies; no separate `uv`, `pnpm`, Postgres, Redis, or MinIO installation is required. The API container runs migrations and seeds the demo user automatically.

For local overrides, copy `.env.example` to `.env` before starting. This is optional for the default setup. In particular, set your own `SECRET_KEY` for anything beyond local development; provider API keys are added through the Models & Providers screen.

To run in the background:

```bash
docker compose up --build -d
docker compose logs -f api web
```

Open `/models` first to add, test, and catalog a provider, save the `deep` and `embedding` tier bindings, then use `/profile` to upload and confirm a CV. The `/cost` page shows the metered calls. See [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) for current status.

## License

MIT — see [LICENSE](LICENSE).
