"""Real, non-fabricated currency localization for pre-checkout price
display (Adrian, direct: "cost of purchase of subscriptions or credits
show in the currency of wherever the user is... also convert prices on
our own pages"). Two real external lookups, both free and keyless,
confirmed live during this build:

- Geo-IP: ipwho.is — resolves the request's real IP to a country code.
- FX rate: open.er-api.com — real, live IDR->target rates, updated
  daily.

Both are best-effort. The FX rate table is cached process-wide (same
IDR->X rates for every visitor, and these free sources update at most
daily) — the geo-IP lookup is NOT cached per-IP, it's cheap and varies
per visitor. Any failure anywhere in the chain (geo-IP unreachable, a
private/loopback/unresolvable IP, an unrecognized or Dodo-unsupported
currency, the FX API unreachable) returns None — callers fall back to
the real IDR price, never a guessed number, same "never invent" rule
this codebase already applies to exchange rates (see page.tsx's own
JSON-LD priceCurrency comment)."""

from __future__ import annotations

import time
import typing

import httpx
from dodopayments.types.currency import Currency
from fastapi import Request

_GEO_TIMEOUT = 3.0
_FX_TIMEOUT = 5.0
_FX_CACHE_TTL_SECONDS = 6 * 60 * 60  # 6h — these free sources update at most daily anyway

SUPPORTED_DODO_CURRENCIES: frozenset[str] = frozenset(typing.get_args(Currency))

_fx_cache: dict[str, float] | None = None
_fx_cache_at: float = 0.0

# ISO 3166-1 alpha-2 -> ISO 4217 — static reference data (which
# currency a country actually uses), not something that changes at
# request time. Not exhaustive of every territory on Earth, but covers
# every country ipwho.is can realistically report for a real visitor.
_COUNTRY_CURRENCY: dict[str, str] = {
    "US": "USD", "GB": "GBP", "CA": "CAD", "AU": "AUD", "NZ": "NZD",
    "ID": "IDR", "SG": "SGD", "MY": "MYR", "PH": "PHP", "VN": "VND",
    "TH": "THB", "MM": "MMK", "KH": "KHR", "LA": "LAK", "BN": "BND",
    "IN": "INR", "PK": "PKR", "BD": "BDT", "LK": "LKR", "NP": "NPR",
    "CN": "CNY", "HK": "HKD", "TW": "TWD", "MO": "MOP",
    "JP": "JPY", "KR": "KRW",
    "AE": "AED", "SA": "SAR", "QA": "QAR", "KW": "KWD", "BH": "BHD",
    "OM": "OMR", "JO": "JOD", "IL": "ILS", "TR": "TRY", "IQ": "IQD",
    "IR": "IRR", "LB": "LBP", "EG": "EGP",
    "ZA": "ZAR", "NG": "NGN", "KE": "KES", "TZ": "TZS", "UG": "UGX",
    "GH": "GHS", "ET": "ETB", "MA": "MAD", "DZ": "DZD", "TN": "TND",
    "BR": "BRL", "MX": "MXN", "AR": "ARS", "CL": "CLP", "CO": "COP",
    "PE": "PEN", "VE": "VES", "EC": "USD", "UY": "UYU", "PY": "PYG",
    "BO": "BOB", "CR": "CRC", "PA": "PAB", "GT": "GTQ", "HN": "HNL",
    "NI": "NIO", "SV": "USD", "DO": "DOP", "JM": "JMD", "TT": "TTD",
    "BS": "BSD", "BB": "BBD", "GY": "GYD",
    "CH": "CHF", "NO": "NOK", "SE": "SEK", "DK": "DKK", "IS": "ISK",
    "PL": "PLN", "CZ": "CZK", "HU": "HUF", "RO": "RON", "BG": "BGN",
    "HR": "EUR", "RS": "RSD", "UA": "UAH", "RU": "RUB", "BY": "BYN",
    "GE": "GEL", "AM": "AMD", "AZ": "AZN", "KZ": "KZT", "UZ": "UZS",
    "KG": "KGS",
    # Eurozone
    "AT": "EUR", "BE": "EUR", "CY": "EUR", "EE": "EUR", "FI": "EUR",
    "FR": "EUR", "DE": "EUR", "GR": "EUR", "IE": "EUR", "IT": "EUR",
    "LV": "EUR", "LT": "EUR", "LU": "EUR", "MT": "EUR", "NL": "EUR",
    "PT": "EUR", "SK": "EUR", "SI": "EUR", "ES": "EUR", "AD": "EUR",
    "MC": "EUR", "SM": "EUR", "VA": "EUR", "PS": "ILS",
}


def get_client_ip(request: Request) -> str | None:
    """Real originating IP, not the reverse proxy's — Caddy's own
    `reverse_proxy` directive (this repo's Caddyfile) always sets
    X-Forwarded-For, and this deployment's only public entrypoint IS
    Caddy (api:8000 is published loopback-only — see docker-compose.yml's
    own comment on that port), so the header can be trusted here.
    Falls back to request.client.host for local/direct access (always
    127.0.0.1 in dev, which the geo lookup below correctly can't place
    — expected there, not a bug)."""

    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else None


async def _country_for_ip(ip: str) -> str | None:
    try:
        async with httpx.AsyncClient(timeout=_GEO_TIMEOUT) as client:
            resp = await client.get(f"https://ipwho.is/{ip}")
        data = resp.json()
        if not data.get("success"):
            return None
        country = data.get("country_code")
        return country.upper() if isinstance(country, str) else None
    except Exception:
        return None


async def _fx_rate_idr_to(target: str) -> float | None:
    """Cached process-wide, refreshed at most every _FX_CACHE_TTL_SECONDS
    — `await to_thread`-free (httpx.AsyncClient is already properly
    async, unlike the blocking `.invoke()` call interview_service.py
    had to fix elsewhere), so this never stalls the event loop the way
    that bug did."""

    global _fx_cache, _fx_cache_at
    now = time.monotonic()
    if _fx_cache is None or (now - _fx_cache_at) > _FX_CACHE_TTL_SECONDS:
        try:
            async with httpx.AsyncClient(timeout=_FX_TIMEOUT) as client:
                resp = await client.get("https://open.er-api.com/v6/latest/IDR")
            data = resp.json()
            if data.get("result") != "success":
                return _fx_cache.get(target) if _fx_cache else None
            _fx_cache = data.get("rates") or {}
            _fx_cache_at = now
        except Exception:
            # Serve the stale cache (if any) rather than nothing — a
            # transient outage shouldn't flip every visitor back to
            # "no conversion" if we fetched real rates a few hours ago.
            return _fx_cache.get(target) if _fx_cache else None
    return _fx_cache.get(target)


async def resolve_local_currency(request: Request) -> dict[str, str | float] | None:
    """Returns {"currency": "NOK", "rate": 0.00072} (multiply an IDR
    amount by `rate` to get that currency's amount) for a visitor whose
    IP resolves to a country with a currency Dodo Payments actually
    supports (SUPPORTED_DODO_CURRENCIES) and a real FX rate this
    process could fetch — None the moment ANY step in that chain
    doesn't cleanly resolve. Unlike an earlier version of this
    function, IDR itself is a valid result here (Adrian, direct: the
    page's own PRIMARY price is USD now, not IDR — see resolve_usd_rate
    below — so an Indonesian visitor still needs their own real "≈ Rp
    ..." estimate, the same as anyone else, rather than that case being
    silently skipped as "already the base currency")."""

    ip = get_client_ip(request)
    if not ip:
        return None
    country = await _country_for_ip(ip)
    if not country:
        return None
    currency = _COUNTRY_CURRENCY.get(country)
    if not currency or currency not in SUPPORTED_DODO_CURRENCIES:
        return None
    rate = await _fx_rate_idr_to(currency)
    if rate is None:
        return None
    return {"currency": currency, "rate": rate}


async def resolve_usd_rate() -> float | None:
    """Adrian, direct: "I want the main number displayed to be USD" —
    location-independent (every visitor sees the same USD price), so
    this is just the FX cache, no geo-IP involved. None means "the FX
    source is unreachable," in which case the caller falls back to
    showing the real Rp price as the primary number instead of
    guessing a USD figure."""

    return await _fx_rate_idr_to("USD")
