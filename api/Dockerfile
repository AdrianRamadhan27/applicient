# syntax=docker/dockerfile:1
#
# Build context is the repo root (not api/) because api/pyproject.toml
# declares `applicient-sources` and `applicient-agents` as editable path
# dependencies at `../sources` and `../agents` — all these packages have
# to land in the image as siblings, same layout as local dev.
# `applicient-agents` itself declares `applicient-api` as an editable
# path dependency back at `../api` (a genuine mutual dependency, see
# M4_IMPLEMENTATION.md §10) — both sides resolve fine as long as both
# directories exist under /app before `uv sync` runs. renderers/latex_templates
# is a further sibling: latex_rendering.py resolves it via
# `Path(__file__).resolve().parents[3]`, i.e. three levels up from
# api/src/applicient_api/, which only lands on the right directory if
# this layout (api/, sources/, agents/, renderers/ all under /app) is
# preserved.
FROM python:3.12-slim AS base

ARG TARGETARCH
ENV TECTONIC_VERSION=0.16.9 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Tectonic has no Debian/Ubuntu package; installing the pinned static
# release binary directly (same version confirmed working via Homebrew
# in local dev: 0.16.9). musl build so it doesn't care which libc the
# base image ships.
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=aarch64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic@${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${arch}-unknown-linux-musl.tar.gz" \
      | tar -xz -C /usr/local/bin tectonic

COPY --from=ghcr.io/astral-sh/uv:0.9.6 /uv /uvx /usr/local/bin/

WORKDIR /app

COPY sources /app/sources
COPY agents /app/agents

# Install dependencies before copying the rest of the app so this layer
# only invalidates when pyproject.toml/uv.lock actually change.
COPY api/pyproject.toml api/uv.lock /app/api/
WORKDIR /app/api
RUN uv sync --frozen --no-install-project

COPY api /app/api
COPY renderers /app/renderers

RUN uv sync --frozen

ENV PATH="/app/api/.venv/bin:${PATH}"

EXPOSE 8000

HEALTHCHECK --interval=5s --timeout=5s --retries=10 --start-period=20s \
    CMD curl -f http://localhost:8000/health || exit 1

# Dependencies are installed during the image build, so startup does not
# need to resolve or reinstall anything. Migrations + demo-user seed run on
# every boot — both are idempotent (alembic no-ops if already at head,
# seed.py checks for the demo user by email first) so this stays safe to
# restart repeatedly.
CMD alembic upgrade head \
    && python -m applicient_api.seed \
    && uvicorn applicient_api.main:app --host 0.0.0.0 --port 8000
