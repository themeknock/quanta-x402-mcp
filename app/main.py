"""Quanta - pay-per-call structured data for autonomous AI agents.

HTTP surface. The data routes under /v1/* are metered by x402 (the agent pays a
USDC micropayment per call, on Base or Solana). Everything else (root, health,
the usage log) is free so the service is operable and observable.

Run:  uvicorn app.main:app --port 4021
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from .config import settings
from .data import (
    derive_signal,
    get_asset,
    list_assets,
    log_usage,
    recent_usage,
    seed_if_empty,
)
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


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    await seed_if_empty()
    log.info("Quanta ready: db initialised, sample data seeded.")
    yield


app = FastAPI(
    title="Quanta",
    version="0.1.0",
    description="Pay-per-call structured data for autonomous AI agents. x402-metered, MCP-native.",
    lifespan=lifespan,
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
        "free_routes": ["/", "/health", "/internal/usage", "/docs"],
    }


@app.get("/health")
async def health() -> dict:
    return {"ok": True}


@app.get("/v1/assets")
async def v1_list_assets() -> dict:
    assets = await list_assets()
    await log_usage("/v1/assets", paid=METERED)
    return {"count": len(assets), "assets": assets, "_meta": _meta()}


@app.get("/v1/assets/{symbol}")
async def v1_get_asset(symbol: str) -> dict:
    asset = await get_asset(symbol)
    if not asset:
        raise HTTPException(status_code=404, detail=f"unknown asset '{symbol}'")
    await log_usage("/v1/assets/{symbol}", symbol=symbol.upper(), paid=METERED)
    return {"asset": asset, "_meta": _meta()}


@app.get("/v1/signals/{symbol}")
async def v1_get_signal(symbol: str) -> dict:
    asset = await get_asset(symbol)
    if not asset:
        raise HTTPException(status_code=404, detail=f"unknown asset '{symbol}'")
    await log_usage("/v1/signals/{symbol}", symbol=symbol.upper(), paid=METERED)
    return {"signal": derive_signal(asset), "_meta": _meta()}


@app.get("/internal/usage")
async def usage() -> dict:
    """Free, operator-facing audit trail of every paid call."""
    return {"recent": await recent_usage()}
