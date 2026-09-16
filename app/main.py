"""Quanta - pay-per-call structured data for autonomous AI agents.

HTTP surface. The data routes under /v1/* are metered by x402 (the agent pays a
USDC micropayment per call, on Base Sepolia). Everything else - root, health, the
usage log, and the MCP endpoint itself - is free, so the service is operable,
observable and discoverable.

Two surfaces, one payment gate: the routes below are gated by the SDK's ASGI
middleware; the MCP tools at /mcp are gated by app/payments.py. Both use the same
x402ResourceServer instance, so the price cannot differ between them.

Run:  uvicorn app.main:app --port 4021
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from starlette.routing import Route
from starlette.types import Receive, Scope, Send

from . import usage
from .config import settings
from .data import derive_signal, get_asset, list_assets, seed_if_empty
from .db import init_db
from .x402_setup import EVM_NETWORK, SVM_NETWORK, build_middleware

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
log = logging.getLogger("quanta")

# route key -> human description (also drives the x402 payment requirements).
# NOTE: the x402 route matcher supports `*`, `:param`, and `[param]` - NOT the
# `{param}` FastAPI uses. So path params are written `:symbol` here; the FastAPI
# decorators below still use `{symbol}`.
PROTECTED_ROUTES = {
    "GET /v1/assets": "List the structured asset universe.",
    "GET /v1/assets/:symbol": "Full structured record for one asset.",
    "GET /v1/signals/:symbol": "Derived signal for one asset.",
}

FREE_ROUTES = ["/", "/health", "/internal/usage", "/docs", "/mcp"]

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
    await seed_if_empty()
    async with _mcp_session_manager.run():
        log.info("Quanta ready: db initialised, MCP mounted at /mcp.")
        yield


app = FastAPI(
    title="Quanta",
    version="0.2.0",
    description="Pay-per-call structured data for autonomous AI agents. x402-metered, MCP-native.",
    lifespan=lifespan,
)

app.router.routes.append(
    Route("/mcp", endpoint=_McpEndpoint(), methods=["GET", "POST", "DELETE"])
)

# Attach x402 metering. Returns (None, None) -> dev mode (unmetered) if the SDK
# isn't installed, so the app always boots.
_mw_cls, _mw_kwargs = build_middleware(PROTECTED_ROUTES)
METERED = _mw_cls is not None
if METERED:
    app.add_middleware(_mw_cls, **_mw_kwargs)


def _rails() -> list[str]:
    if not METERED:
        return []
    return [EVM_NETWORK] + ([SVM_NETWORK] if settings.x402_enable_svm else [])


def _meta() -> dict:
    return {
        "source": "sample snapshot dataset",
        "metered": METERED,
        "rails": _rails(),
    }


@app.get("/")
async def root() -> dict:
    return {
        "service": "Quanta",
        "metered_via_x402": METERED,
        "paid_routes": list(PROTECTED_ROUTES),
        "free_routes": FREE_ROUTES,
        "mcp": {"endpoint": "/mcp", "transport": "streamable-http",
                "tools": ["list_assets", "get_asset", "get_signal"]},
    }


@app.get("/health")
async def health() -> dict:
    return {"ok": True}


@app.get("/v1/assets")
async def v1_list_assets() -> dict:
    assets = await list_assets()
    await usage.log_usage("http", "/v1/assets", paid=METERED)
    return {"count": len(assets), "assets": assets, "_meta": _meta()}


@app.get("/v1/assets/{symbol}")
async def v1_get_asset(symbol: str) -> dict:
    asset = await get_asset(symbol)
    if not asset:
        raise HTTPException(status_code=404, detail=f"unknown asset '{symbol}'")
    await usage.log_usage("http", "/v1/assets/{symbol}", paid=METERED)
    return {"asset": asset, "_meta": _meta()}


@app.get("/v1/signals/{symbol}")
async def v1_get_signal(symbol: str) -> dict:
    asset = await get_asset(symbol)
    if not asset:
        raise HTTPException(status_code=404, detail=f"unknown asset '{symbol}'")
    await usage.log_usage("http", "/v1/signals/{symbol}", paid=METERED)
    return {"signal": derive_signal(asset), "_meta": _meta()}


@app.get("/internal/usage")
async def usage_log(limit: int = 25) -> dict:
    """Free, operator-facing audit trail. Payer addresses are shortened."""
    return {"recent": await usage.recent_usage(limit)}
