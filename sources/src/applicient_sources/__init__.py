"""M1 §2 — adapter registry. Adding a source is one file implementing
SourceAdapter and one line here — mirrors api/src/applicient_api/providers/__init__.py's
pattern for LLM provider adapters."""

from applicient_sources.base import ConnectionTestResult, RawPosting, SourceAdapter
from applicient_sources.greenhouse import GreenhouseAdapter
from applicient_sources.jobspy_source import JobSpyAdapter
from applicient_sources.jsearch import JSearchAdapter
from applicient_sources.lever import LeverAdapter
from applicient_sources.remoteok import RemoteOKAdapter
from applicient_sources.socialfetch import SocialFetchAdapter

ADAPTERS: dict[str, SourceAdapter] = {
    "greenhouse": GreenhouseAdapter(),
    "jsearch": JSearchAdapter(),
    "lever": LeverAdapter(),
    "remoteok": RemoteOKAdapter(),
    "jobspy": JobSpyAdapter(),
    "socialfetch": SocialFetchAdapter(),
}


def get_adapter(adapter_key: str) -> SourceAdapter:
    try:
        return ADAPTERS[adapter_key]
    except KeyError:
        raise ValueError(f"no source adapter registered for {adapter_key!r} — known: {sorted(ADAPTERS)}") from None


def main() -> None:
    print("applicient-sources:", sorted(ADAPTERS))


__all__ = ["ADAPTERS", "get_adapter", "SourceAdapter", "RawPosting", "ConnectionTestResult"]
