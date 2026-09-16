"""Quanta - an agent hands over a URL, pays a tenth of a cent, and gets back a
structured verdict on whether that website is broken.

No account, no API key: the verified payer address from the x402 payment IS the
principal for rate limiting, idempotency and the audit log.

Paid (x402-metered): GET /v1/check, /v1/tls, /v1/headers
Free:                GET /, /health, /demo, /bot, /internal/usage, /docs, /mcp

Two surfaces, one payment gate: the routes below are gated by the SDK's ASGI
middleware; the MCP tools at /mcp are gated by app/payments.py. Both use the same
x402ResourceServer instance, so the price cannot differ between them.

Run:  uvicorn app.main:app --port 4021
"""
from __future__ import annotations

import logging
import time
from collections import deque
from contextlib import asynccontextmanager
from typing import Any, Callable

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from sqlalchemy import text
from starlette.routing import Route
from starlette.types import Receive, Scope, Send

from . import idempotency, ratelimit, usage
from .checks import verdict
from .checks.fetch import USER_AGENT, host_of
from .config import settings
from .db import SessionLocal, init_db
from .x402_setup import EVM_NETWORK, SVM_NETWORK, build_middleware, get_resource_server

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
log = logging.getLogger("quanta")

# route key -> what the payer is buying. This also drives the x402 payment
# requirements, so the description in the 402 challenge is this string.
# NOTE: the x402 route matcher supports `*`, `:param` and `[param]`, not `{param}`.
PROTECTED_ROUTES = {
    "GET /v1/check": "Full check of one URL: reachability, TLS, security headers, raw-HTML basics.",
    "GET /v1/tls": "Certificate facts for one host: validity, days left, issuer, hostname match.",
    "GET /v1/headers": "Status, timings and the four security headers for one URL.",
}

FREE_ROUTES = ["/", "/health", "/demo", "/bot", "/internal/usage", "/docs", "/mcp"]

# --------------------------------------------------------------------------
# MCP over HTTP
# --------------------------------------------------------------------------
from mcp_server.server import mcp as _mcp  # noqa: E402  (after logging setup)

_mcp.streamable_http_app()          # creates the session manager
_mcp_session_manager = _mcp.session_manager


class _McpEndpoint:
    """ASGI endpoint for the MCP streamable-HTTP transport.

    One deliberate leniency: the transport rejects a request unless its Accept
    header names application/json explicitly, so `Accept: */*` - what curl and
    plenty of HTTP clients send - gets a 406 even though */* does accept JSON.
    We treat a missing or wildcard Accept as "both", which is what RFC 9110
    content negotiation already means, and pass everything else through
    untouched.
    """

    _WANTED = b"application/json, text/event-stream"

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        headers = [(k, v) for k, v in scope.get("headers", [])]
        accept = next((v for k, v in headers if k == b"accept"), None)
        if accept is None or b"*/*" in accept:
            headers = [(k, v) for k, v in headers if k != b"accept"]
            headers.append((b"accept", self._WANTED))
            scope = {**scope, "headers": headers}
        await _mcp_session_manager.handle_request(scope, receive, send)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    async with _mcp_session_manager.run():
        log.info("Quanta ready: db initialised, MCP mounted at /mcp.")
        yield


app = FastAPI(
    title="Quanta",
    version="0.2.0",
    description="Pay-per-call website checks for autonomous AI agents. x402-metered, MCP-native.",
    lifespan=lifespan,
)

app.router.routes.append(
    Route("/mcp", endpoint=_McpEndpoint(), methods=["GET", "POST", "DELETE"])
)

_mw_cls, _mw_kwargs = build_middleware(PROTECTED_ROUTES)
METERED = _mw_cls is not None
if METERED:
    app.add_middleware(_mw_cls, **_mw_kwargs)


# --------------------------------------------------------------------------
# Payment plumbing for the HTTP routes
# --------------------------------------------------------------------------
async def _record_settlement(ctx: Any) -> None:
    """After-settle hook: stamp the tx hash onto the audit row the route wrote."""
    await usage.mark_settled(
        _nonce_of(ctx.payment_payload),
        tx_ref=ctx.result.transaction or "",
        payer=ctx.result.payer or "",
        network=str(ctx.result.network or ""),
    )


_server = get_resource_server()
if _server is not None:
    _server.on_after_settle(_record_settlement)


def _authorization(payload: Any) -> dict:
    data = getattr(payload, "payload", None) or {}
    auth = data.get("authorization") if isinstance(data, dict) else None
    return auth if isinstance(auth, dict) else {}


def _nonce_of(payload: Any) -> str:
    return str(_authorization(payload).get("nonce") or "")


def _payer_of(request: Request) -> str:
    """The payer address the middleware already verified. No header, no guess."""
    return str(_authorization(getattr(request.state, "payment_payload", None)).get("from") or "")


def _network_of(request: Request) -> str:
    requirements = getattr(request.state, "payment_requirements", None)
    return str(getattr(requirements, "network", "") or "")


def _rails() -> list[str]:
    if not METERED:
        return []
    return [EVM_NETWORK] + ([SVM_NETWORK] if settings.x402_enable_svm else [])


async def _serve_paid(
    request: Request,
    route: str,
    params: dict[str, Any],
    run: Callable[[bool, str, bool], Any],
    idempotency_key: str | None,
    target_host: str,
) -> JSONResponse:
    """Rate limit -> idempotency -> the check -> audit row.

    Order matters. The rate limit runs before the work AND before settlement:
    the SDK cancels settlement on any 4xx/5xx, so a refused caller does not pay.
    """
    started = time.perf_counter()
    payer = _payer_of(request)
    network = _network_of(request)
    nonce = _nonce_of(getattr(request.state, "payment_payload", None))

    allowed, retry_after = await ratelimit.take(payer)
    if not allowed:
        return JSONResponse({"error": "rate_limited", "retry_after_s": retry_after},
                            status_code=429)

    req_hash = idempotency.request_hash(route, params)
    cached = await idempotency.lookup(payer, idempotency_key or "", route, req_hash)
    if cached.is_conflict:
        return JSONResponse({"error": "idempotency_key_reused_with_different_request"},
                            status_code=409)
    if cached.is_hit:
        body = dict(cached.body or {})
        body.setdefault("_meta", {})
        body["_meta"] = {**body["_meta"], "idempotent_replay": True}
        await usage.log_usage("http", route, target_host=target_host, network=network,
                              payer=payer, amount=settings.x402_price, paid=False,
                              idempotent_replay=True, payment_nonce=nonce,
                              duration_ms=int((time.perf_counter() - started) * 1000),
                              verdict_hash=usage.body_hash(body))
        return JSONResponse(body, status_code=cached.status_code)

    status, body = await run(METERED, network, False)

    if status == 200 and idempotency_key:
        await idempotency.remember(payer, idempotency_key, route, req_hash, body, status)

    await usage.log_usage("http", route, target_host=target_host, network=network,
                          payer=payer, amount=settings.x402_price, paid=False,
                          payment_nonce=nonce if status == 200 else "",
                          duration_ms=int((time.perf_counter() - started) * 1000),
                          verdict_hash=usage.body_hash(body))
    return JSONResponse(body, status_code=status)


# --------------------------------------------------------------------------
# Free routes
# --------------------------------------------------------------------------
@app.get("/")
async def root() -> dict:
    return {
        "service": "Quanta",
        "what_it_does": ("Give it a URL, pay $0.001, get a structured verdict on whether "
                         "that website is broken. No account, no API key."),
        "metered_via_x402": METERED,
        "rails": _rails(),
        "paid_routes": list(PROTECTED_ROUTES),
        "free_routes": FREE_ROUTES,
        "mcp": {"endpoint": "/mcp", "transport": "streamable-http",
                "tools": ["check_url", "check_tls", "check_headers"]},
        "limits": {"renders_javascript": False, "html_checked": "raw_html_only",
                   "settlement": "Base Sepolia testnet"},
    }


@app.get("/health")
async def health() -> JSONResponse:
    try:
        async with SessionLocal() as s:
            await s.execute(text("SELECT 1"))
    except Exception as exc:
        log.warning("health: database unreachable (%s)", exc)
        return JSONResponse({"ok": False, "db": False}, status_code=503)
    return JSONResponse({"ok": True, "db": True})


_demo_hits: deque[float] = deque(maxlen=512)
DEMO_LIMIT_PER_MIN = 10


@app.get("/demo")
async def demo(request: Request, url: str = "") -> JSONResponse:
    """The same verdict /v1/check returns, free, for hosts we chose ourselves.

    Free and unmetered, so it is allowlisted: this endpoint cannot be pointed at
    someone else's site and used as an anonymous scanner.
    """
    now = time.monotonic()
    while _demo_hits and now - _demo_hits[0] > 60:
        _demo_hits.popleft()
    if len(_demo_hits) >= DEMO_LIMIT_PER_MIN:
        return JSONResponse({"error": "rate_limited", "retry_after_s": 60}, status_code=429)
    _demo_hits.append(now)

    allowed = settings.demo_hosts()
    target = url or f"https://{allowed[0]}"
    host = host_of(target)
    if host.lower() not in allowed:
        return JSONResponse(
            {"error": "demo_host_not_allowed", "allowed": allowed,
             "hint": "The free demo only checks hosts we own. Paid calls to /v1/check take any URL."},
            status_code=403)

    status, body = await verdict.run_check(target, metered=False)
    body.setdefault("_meta", {})["free_demo"] = True
    await usage.log_usage("http", "/demo", target_host=host, paid=False,
                          verdict_hash=usage.body_hash(body))
    return JSONResponse(body, status_code=status)


@app.get("/bot", response_class=PlainTextResponse)
async def bot() -> str:
    return f"""Quanta website checks

User-Agent: {USER_AGENT}

What it is
  Quanta fetches a single page when one of its users asks it to check that page.
  It is not a crawler: it follows no links, queues nothing, and never visits a
  URL nobody asked about. One request per call, at most {settings.check_max_redirects} redirect hops.

What it reads
  The response status, timings, the TLS certificate, four security headers, and
  the raw HTML (title, viewport, mixed content, asset counts). It does not run
  JavaScript. It stores the hostname it checked, never the full URL.

How to block it
  User-agent: QuantaCheck
  Disallow: /

Contact
  themeknock@gmail.com
"""


@app.get("/internal/usage")
async def usage_log(limit: int = 25) -> dict:
    """Free, operator-facing audit trail. Payer addresses are shortened."""
    return {"recent": await usage.recent_usage(limit)}


# --------------------------------------------------------------------------
# Paid routes
# --------------------------------------------------------------------------
@app.get("/v1/check")
async def v1_check(request: Request, url: str = "",
                   idempotency_key: str | None = Header(None, alias="Idempotency-Key")):
    return await _serve_paid(
        request, "/v1/check", {"url": url},
        lambda metered, network, replay: verdict.run_check(
            url, metered=metered, network=network, idempotent_replay=replay),
        idempotency_key, host_of(url))


@app.get("/v1/tls")
async def v1_tls(request: Request, host: str = "",
                 idempotency_key: str | None = Header(None, alias="Idempotency-Key")):
    return await _serve_paid(
        request, "/v1/tls", {"host": host},
        lambda metered, network, replay: verdict.run_tls(
            host, metered=metered, network=network, idempotent_replay=replay),
        idempotency_key, host)


@app.get("/v1/headers")
async def v1_headers(request: Request, url: str = "",
                     idempotency_key: str | None = Header(None, alias="Idempotency-Key")):
    return await _serve_paid(
        request, "/v1/headers", {"url": url},
        lambda metered, network, replay: verdict.run_headers(
            url, metered=metered, network=network, idempotent_replay=replay),
        idempotency_key, host_of(url))
