import os
import sys
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import engine_from_config
from sqlalchemy import pool

from alembic import context

# Make the src/ layout package importable without installing it.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

# Importing applicient_api runs its __init__.py, which loads .env from
# the repo root — same file every other entry point loads, once,
# centrally. Must happen before reading DATABASE_URL below.
from applicient_api.models import Base  # noqa: E402

config = context.config

if os.environ.get("DATABASE_URL"):
    config.set_main_option("sqlalchemy.url", os.environ["DATABASE_URL"])

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def include_object(object, name, type_, reflected, compare_to):
    # M7 — langgraph-checkpoint-postgres (agents/orchestrator_service.py's
    # AsyncPostgresSaver.setup()) owns and migrates its own
    # `checkpoint*` tables directly, entirely outside this app's
    # SQLAlchemy models/Alembic history. Without this, autogenerate/
    # `alembic check` sees them as "extra" tables not in `Base.metadata`
    # and proposes dropping them — a real, otherwise-permanent false
    # positive from two schema-owning systems sharing one database, not
    # an actual drift in anything this app itself manages.
    if type_ == "table" and name.startswith("checkpoint"):
        return False
    return True


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_object=include_object,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, include_object=include_object)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
