# syntax=docker/dockerfile:1
#
# Self-contained build context (browser-worker/, not the repo root) —
# unlike api/Dockerfile and web/Dockerfile, this package deliberately
# has no sibling-package dependencies to bring along (see
# M4_IMPLEMENTATION.md §2: browser-worker is a pure Playwright/HTTP
# shell, no applicient-api/applicient-agents import).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    BROWSER_WORKER_NO_SANDBOX=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.9.6 /uv /uvx /usr/local/bin/

WORKDIR /app

# Install dependencies before copying the rest so this layer only
# invalidates when pyproject.toml/uv.lock actually change.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-install-project

COPY src ./src
RUN uv sync --frozen

# --with-deps installs the OS packages Chromium itself needs (fonts,
# codecs, etc.) via apt — the reason this stays on a Debian base
# instead of Alpine. Run after the project itself is installed (`uv
# run` otherwise tries to build/sync the project first, which fails
# without src/ present yet).
RUN uv run playwright install --with-deps chromium

ENV PATH="/app/.venv/bin:${PATH}"

EXPOSE 8100

HEALTHCHECK --interval=5s --timeout=5s --retries=10 --start-period=20s \
    CMD curl -f http://localhost:8100/health || exit 1

CMD ["browser-worker"]
