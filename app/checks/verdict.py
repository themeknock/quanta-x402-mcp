"""Assemble one check result, and score it.

The score is arithmetic, not opinion: every issue has a fixed weight, the weights
are in this file, and 100 minus the weights is the score. Nothing is rounded,
nothing is tuned per site, and the issue list always adds up to the number shown.

Weights: high 25, medium 12, low 8.
"""
from __future__ import annotations

from datetime import datetime, timezone

ENGINE = "quanta/0.2.0"

WEIGHTS = {"high": 25, "medium": 12, "low": 8}

# code -> (severity, note)
CATALOG: dict[str, tuple[str, str]] = {
    "HTTP_ERROR_STATUS": ("high", "the page did not return a success status"),
    "BOT_PROTECTION_SUSPECTED": ("medium", "the site refused this checker's user agent (403/429); it may serve fine to a browser, and we do not run one"),
    "MIXED_CONTENT": ("high", "https page loads sub-resources over http; browsers block them"),
    "TLS_INVALID": ("high", "the certificate did not verify in a normal TLS handshake"),
    "TLS_EXPIRES_SOON": ("high", "certificate expires in under 14 days"),
    "TLS_HOSTNAME_MISMATCH": ("high", "the certificate does not cover this hostname"),
    "TLS_EXPIRES_WITHIN_30_DAYS": ("medium", "certificate expires in under 30 days"),
    "NO_TITLE_IN_RAW_HTML": ("medium", "may be injected by JS; not checked in a browser"),
    "NO_VIEWPORT_IN_RAW_HTML": ("medium", "may be injected by JS; not checked in a browser"),
    "SLOW_TTFB": ("medium", "first byte took over 1500 ms"),
    "NO_HSTS": ("low", ""),
    "NO_CSP": ("low", ""),
    "NO_X_FRAME_OPTIONS": ("low", ""),
    "NO_X_CONTENT_TYPE_OPTIONS": ("low", ""),
    "REDIRECT_CHAIN_TRUNCATED": ("low", "more than the redirect budget; the chain was not followed to the end"),
}

SLOW_TTFB_MS = 1500


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def meta(*, metered: bool, network: str = "", idempotent_replay: bool = False) -> dict:
    return {"checked_at": now_iso(), "engine": ENGINE, "metered": metered,
            "network": network, "idempotent_replay": idempotent_replay}


def _issue(code: str) -> dict:
    severity, note = CATALOG[code]
    out = {"code": code, "severity": severity}
    if note:
        out["note"] = note
    return out


def grade_for(score: int) -> str:
    if score >= 90:
        return "A"
    if score >= 80:
        return "B"
    if score >= 70:
        return "C"
    if score >= 60:
        return "D"
    return "F"


def score(codes: list[str]) -> dict:
    """100 minus the weight of every issue found, floored at 0."""
    total = 100
    for code in codes:
        total -= WEIGHTS[CATALOG[code][0]]
    total = max(0, total)
    return {"score": total, "grade": grade_for(total),
            "issues": [_issue(code) for code in codes]}


def issues_for(http: dict, tls: dict, headers: dict, html: dict) -> list[str]:
    codes: list[str] = []

    status = http.get("status", 0)
    if status in (403, 429):
        # A refusal aimed at our user agent is a different fact from a broken
        # page, and saying so is the difference between a useful answer and a
        # wrong one. Verified on themeknock.net, 16 Sep 2026: 403 to
        # QuantaCheck, 200 to a browser user agent.
        codes.append("BOT_PROTECTION_SUSPECTED")
    elif status >= 400:
        codes.append("HTTP_ERROR_STATUS")
    if http.get("truncated"):
        codes.append("REDIRECT_CHAIN_TRUNCATED")
    if http.get("ttfb_ms", 0) > SLOW_TTFB_MS:
        codes.append("SLOW_TTFB")

    if tls:
        if tls.get("ok") is False and tls.get("days_left") is not None:
            codes.append("TLS_INVALID")
        if tls.get("san_match") is False and tls.get("days_left") is not None:
            codes.append("TLS_HOSTNAME_MISMATCH")
        days = tls.get("days_left")
        if isinstance(days, int):
            if days < 14:
                codes.append("TLS_EXPIRES_SOON")
            elif days < 30:
                codes.append("TLS_EXPIRES_WITHIN_30_DAYS")

    if html:
        if not html.get("title", {}).get("present"):
            codes.append("NO_TITLE_IN_RAW_HTML")
        if not html.get("viewport", {}).get("present"):
            codes.append("NO_VIEWPORT_IN_RAW_HTML")
        if html.get("mixed_content", {}).get("count", 0) > 0:
            codes.append("MIXED_CONTENT")

    if headers:
        if not headers.get("hsts"):
            codes.append("NO_HSTS")
        if not headers.get("csp"):
            codes.append("NO_CSP")
        if not headers.get("x_frame_options"):
            codes.append("NO_X_FRAME_OPTIONS")
        if not headers.get("x_content_type_options"):
            codes.append("NO_X_CONTENT_TYPE_OPTIONS")

    return codes


# ---------------------------------------------------------------------------
# Running a check: one URL in, (http status, body) out.
# ---------------------------------------------------------------------------

BLOCK_REASONS = {"private_address", "loopback_address", "link_local_address",
                 "metadata_address", "multicast_address", "reserved_address",
                 "unspecified_address", "non_public_address"}


def _error_for(fetch) -> tuple[int, dict]:
    """Map a failed fetch to the HTTP status and body the API contract promises."""
    detail = fetch.detail
    if detail == "invalid_url" or detail == "no_host":
        return 400, {"error": "invalid_url"}
    if detail in BLOCK_REASONS:
        return 403, {"error": "target_blocked", "reason": detail}
    if detail == "dns_failed":
        return 502, {"error": "target_unreachable", "detail": "dns"}
    return 502, {"error": "target_unreachable", "detail": detail or "connect"}


def _http_block(fetch) -> dict:
    block = {"status": fetch.status, "final_url": fetch.final_url,
             "redirects": fetch.redirects, "ttfb_ms": fetch.ttfb_ms,
             "total_ms": fetch.total_ms, "bytes": fetch.bytes,
             "content_type": fetch.content_type}
    if fetch.truncated_redirects:
        block["truncated"] = True
    return block


async def run_check(url: str, *, metered: bool, network: str = "",
                    idempotent_replay: bool = False) -> tuple[int, dict]:
    """GET /v1/check - the full verdict."""
    from urllib.parse import urlsplit

    from . import fetch as fetcher
    from . import headers as header_check
    from . import html as html_check
    from . import tls as tls_check

    result = await fetcher.get(url)
    if not result.ok:
        return _error_for(result)

    final_host = urlsplit(result.final_url).hostname or result.target.host
    is_https = urlsplit(result.final_url).scheme == "https"
    tls_block = await tls_check.check(final_host) if is_https else {
        "ok": False, "checked": False, "note": "the final URL is not https, so there is no certificate to read"}

    http_block = _http_block(result)
    header_block = header_check.read(result.response_headers)
    html_block = html_check.parse(result.body, final_url=result.final_url,
                                  content_type=result.content_type,
                                  truncated=result.body_truncated)

    codes = issues_for(http_block, tls_block if is_https else {}, header_block, html_block)
    body = {
        "target": {"url": url, "host": result.target.host, "ip": result.target.ip},
        "http": http_block,
        "tls": tls_block,
        "headers": header_block,
        "html": html_block,
        "verdict": score(codes),
        "_meta": meta(metered=metered, network=network,
                      idempotent_replay=idempotent_replay),
    }
    return 200, body


async def run_tls(host: str, *, metered: bool, network: str = "",
                  idempotent_replay: bool = False) -> tuple[int, dict]:
    """GET /v1/tls - certificate facts for one host."""
    from . import tls as tls_check
    from .ssrf import resolve

    if not host or "/" in host or ":" in host.replace("[", "").replace("]", ""):
        return 400, {"error": "invalid_url"}
    target = await resolve(host, 443)
    if not target.ok:
        if target.reason == "dns_failed":
            return 502, {"error": "target_unreachable", "detail": "dns"}
        return 403, {"error": "target_blocked", "reason": target.reason}

    block = await tls_check.check(host)
    if block.get("error") in {"timeout", "no_certificate"} and block.get("days_left") is None:
        detail = "timeout" if block["error"] == "timeout" else "tls"
        return 502, {"error": "target_unreachable", "detail": detail}

    return 200, {"target": {"host": host, "ip": target.ip}, "tls": block,
                 "_meta": meta(metered=metered, network=network,
                               idempotent_replay=idempotent_replay)}


async def run_headers(url: str, *, metered: bool, network: str = "",
                      idempotent_replay: bool = False) -> tuple[int, dict]:
    """GET /v1/headers - status, timings and the four security headers."""
    from . import fetch as fetcher
    from . import headers as header_check

    result = await fetcher.get(url)
    if not result.ok:
        return _error_for(result)

    return 200, {
        "target": {"url": url, "host": result.target.host, "ip": result.target.ip},
        "http": _http_block(result),
        "headers": header_check.read(result.response_headers),
        "_meta": meta(metered=metered, network=network,
                      idempotent_replay=idempotent_replay),
    }
