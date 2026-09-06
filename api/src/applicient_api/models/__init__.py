"""Import every model module here so Base.metadata sees all tables —
this is what Alembic autogenerate diffs against."""

from applicient_api.db import Base  # noqa: F401
from applicient_api.models import (  # noqa: F401
    agents,
    billing,
    calendar,
    credentials,
    discovery,
    documents,
    email,
    gmail,
    interview,
    llm,
    notifications,
    pipeline,
    profile,
    scoring,
    site_content,
)

__all__ = ["Base"]
