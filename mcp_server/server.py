"""Quanta MCP server - the same structured data, exposed as MCP tools so an
autonomous agent can discover and call it natively.

x402-over-MCP (per-tool gating): each tool is monetized. When metering is on and
the caller supplies no payment proof, the tool returns the x402 challenge (the
accepted rails + price) instead of the data, so the agent can pay and retry. This
is the same 402 contract as the HTTP API, expressed through the MCP tool result.

Run standalone (stdio, for Claude Desktop / MCP Inspector):
    python -m mcp_server.server

Serve over HTTP (for remote agents):
    see `streamable_http_app()` at the bottom + README.
"""
from __future__ import annotations

import anyio
from mcp.server.fastmcp import FastMCP

from app import data
from app.config import settings
from app.data import seed_if_empty
from app.db import init_db

mcp = FastMCP("Quanta")


def _challenge(resource: str, symbol: str = "") -> dict:
    """The x402 payment requirements, returned when an unpaid tool is called."""
    return {
        "x402": "payment_required",
        "resource": resource,
        "symbol": symbol,
        "accepts": [
            {"scheme": "exact", "network": "eip155:84532",
             "pay_to": settings.x402_evm_address, "price": settings.x402_price},
            {"scheme": "exact", "network": "solana:devnet",
             "pay_to": settings.x402_svm_address, "price": settings.x402_price},
        ],
        "hint": "Pay with an x402 client, then call again with payment=<X-PAYMENT proof>.",
    }


@mcp.tool()
async def list_assets(payment: str | None = None) -> dict:
    """List the structured asset universe. Monetized via x402 (one paid call)."""
    if settings.x402_enabled and not payment:
        return _challenge("list_assets")
    assets = await data.list_assets()
    await data.log_usage("mcp:list_assets", paid=bool(payment))
    return {"count": len(assets), "assets": assets}


@mcp.tool()
async def get_asset(symbol: str, payment: str | None = None) -> dict:
    """Full structured record for one asset by ticker symbol (e.g. 'ETH')."""
    if settings.x402_enabled and not payment:
        return _challenge("get_asset", symbol)
    asset = await data.get_asset(symbol)
    if not asset:
        return {"error": f"unknown asset '{symbol}'"}
    await data.log_usage("mcp:get_asset", symbol=symbol.upper(), paid=bool(payment))
    return {"asset": asset}


@mcp.tool()
async def get_signal(symbol: str, payment: str | None = None) -> dict:
    """Derived signal (tier + bias) for one asset by ticker symbol."""
    if settings.x402_enabled and not payment:
        return _challenge("get_signal", symbol)
    asset = await data.get_asset(symbol)
    if not asset:
        return {"error": f"unknown asset '{symbol}'"}
    await data.log_usage("mcp:get_signal", symbol=symbol.upper(), paid=bool(payment))
    return {"signal": data.derive_signal(asset)}


async def _bootstrap() -> None:
    await init_db()
    await seed_if_empty()


# ASGI app for remote agents (mount behind the same host as the HTTP API).
def streamable_http_app():
    return mcp.streamable_http_app()


if __name__ == "__main__":
    anyio.run(_bootstrap)
    mcp.run()  # stdio transport
