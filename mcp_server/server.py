"""Quanta MCP server - the same capabilities, exposed as MCP tools so an
autonomous agent can discover and call them natively.

x402-over-MCP, done properly. MCP has no ASGI middleware to gate tools, so the
payment arrives as a tool argument. Every paid tool runs the same four steps:

    1. no payment            -> return the x402 challenge (built by the SDK from
                                the SAME resource server the HTTP middleware uses)
    2. payment present       -> VERIFY it with the facilitator (app/payments.py).
                                Presence is not proof. A bogus string is refused.
    3. verified              -> per-payer rate limit, then run the tool
    4. tool succeeded        -> SETTLE, then write the audit row

Transport is stateless streamable HTTP with JSON responses: no session to pin an
agent to one machine, and every request carries its own payment.

Run standalone (stdio, for Claude Desktop / MCP Inspector):
    python -m mcp_server.server

Over HTTP: mounted by app/main.py at /mcp.
"""
from __future__ import annotations

import time
from typing import Any

import anyio
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from app import data, payments, ratelimit, usage
from app.config import settings
from app.data import seed_if_empty
from app.db import init_db

# DNS-rebinding protection stays ON: every Host header that may reach /mcp has to
# be listed (PUBLIC_BASE_URL plus MCP_EXTRA_HOSTS). An unlisted host gets 421.
mcp = FastMCP(
    "Quanta",
    stateless_http=True,
    json_response=True,
    streamable_http_path="/",
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=settings.mcp_allowed_hosts(),
    ),
)

# tool name -> what the payer is buying (shown in the challenge).
TOOLS: dict[str, str] = {
    "list_assets": "List the structured asset universe.",
    "get_asset": "Full structured record for one asset.",
    "get_signal": "Derived signal for one asset.",
}


async def _gate(tool: str, payment: str | None) -> tuple[Any, dict[str, Any] | None]:
    """Returns (verified_payment, refusal_body). Exactly one of them is set."""
    if not payment:
        return None, await payments.mcp_challenge(TOOLS[tool], resource=f"mcp://quanta/{tool}")

    verified = await payments.verify_mcp_payment(payment, TOOLS[tool])
    if not verified.ok:
        return None, verified.as_dict()

    allowed, retry_after = await ratelimit.take(verified.payer)
    if not allowed:
        # Refused before settlement: over-limit callers do not pay.
        return None, {"error": "rate_limited", "retry_after_s": retry_after}

    return verified, None


async def _finish(tool: str, verified: Any, body: dict[str, Any],
                  started: float, target: str = "") -> dict[str, Any]:
    """Settle the payment, write the audit row, stamp _meta on the body."""
    settled, tx_ref = await verified.settle()
    duration_ms = int((time.perf_counter() - started) * 1000)
    await usage.log_usage(
        "mcp", tool, target_host=target, network=verified.network,
        payer=verified.payer, amount=verified.amount,
        tx_ref=tx_ref if settled else "", paid=settled,
        duration_ms=duration_ms, verdict_hash=usage.body_hash(body),
    )
    if not settled:
        return {"x402": "settlement_failed", "reason": tx_ref}
    body["_meta"] = {"metered": True, "network": verified.network,
                     "amount": verified.amount, "tx_ref": tx_ref,
                     "duration_ms": duration_ms}
    return body


@mcp.tool()
async def list_assets(payment: str | None = None) -> dict:
    """List the structured asset universe. Monetized via x402 (one paid call)."""
    started = time.perf_counter()
    verified, refusal = await _gate("list_assets", payment)
    if refusal is not None:
        return refusal
    assets = await data.list_assets()
    return await _finish("list_assets", verified, {"count": len(assets), "assets": assets}, started)


@mcp.tool()
async def get_asset(symbol: str, payment: str | None = None) -> dict:
    """Full structured record for one asset by ticker symbol (e.g. 'ETH')."""
    started = time.perf_counter()
    verified, refusal = await _gate("get_asset", payment)
    if refusal is not None:
        return refusal
    asset = await data.get_asset(symbol)
    if not asset:
        # The caller paid for a lookup we could not answer: settle anyway, the
        # work was done, and say so plainly.
        return await _finish("get_asset", verified, {"error": f"unknown asset '{symbol}'"}, started)
    return await _finish("get_asset", verified, {"asset": asset}, started)


@mcp.tool()
async def get_signal(symbol: str, payment: str | None = None) -> dict:
    """Derived signal (tier + bias) for one asset by ticker symbol."""
    started = time.perf_counter()
    verified, refusal = await _gate("get_signal", payment)
    if refusal is not None:
        return refusal
    asset = await data.get_asset(symbol)
    if not asset:
        return await _finish("get_signal", verified, {"error": f"unknown asset '{symbol}'"}, started)
    return await _finish("get_signal", verified, {"signal": data.derive_signal(asset)}, started)


async def _bootstrap() -> None:
    await init_db()
    await seed_if_empty()


def streamable_http_app():
    """Starlette app for the streamable-HTTP transport (also creates the session
    manager that app/main.py runs inside its lifespan)."""
    return mcp.streamable_http_app()


if __name__ == "__main__":
    anyio.run(_bootstrap)
    mcp.run()  # stdio transport
