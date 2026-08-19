"""Loading .env here, once, at package import time, means every entry
point (scripts, alembic, the future FastAPI app) gets it automatically
through `import applicient_api...` — no per-module duplication."""

from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[3] / ".env")
