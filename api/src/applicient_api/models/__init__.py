"""Import every model module here so Base.metadata sees all tables —
this is what Alembic autogenerate diffs against."""

from applicient_api.db import Base  # noqa: F401
from applicient_api.models import (  # noqa: F401
    agents,
    billing,
    credentials,
    discovery,
    documents,
    email,
    gmail,
    llm,
    notifications,
    pipeline,
    profile,
    scoring,
)

__all__ = ["Base"]
