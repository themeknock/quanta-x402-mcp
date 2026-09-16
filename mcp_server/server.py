"""Quanta MCP server - the same website checks, exposed as MCP tools so an
autonomous agent can discover and call them natively.

x402-over-MCP, done properly. MCP has no ASGI middleware to gate tools, so the
payment arrives as a tool argument. Every paid tool runs the same four steps:

    1. no payment            -> return the x402 challenge (built by the SDK from
                                the SAME resource server the HTTP middleware uses)
    2. payment present       -> VERIFY it with the facilitator (app/payments.py).
                                Presence is not proof. A bogus string is refused.
    3. verified              -> per-payer rate limit, then run the check
    4. check ran             -> SETTLE, then write the audit row

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

from app import payments, ratelimit, usage
from app.checks import verdict
from app.checks.fetch import host_of
from app.config import settings
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
    "check_url": "Full check of one URL: reachability, TLS, security headers, raw-HTML basics.",
    "check_tls": "Certificate facts for one host: validity, days left, issuer, hostname match.",
    "check_headers": "Status, timings and the four security headers for one URL.",
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
                  started: float, target: str) -> dict[str, Any]:
    """Settle the payment, write the audit row, stamp the settlement on the body."""
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
    body.setdefault("_meta", {})
    body["_meta"] = {**body["_meta"], "metered": True, "network": verified.network,
                     "amount": verified.amount, "tx_ref": tx_ref,
                     "duration_ms": duration_ms}
    return body


@mcp.tool()
async def check_url(url: str, payment: str | None = None) -> dict:
    """Check one website: is it reachable, is its certificate sound, does it send
    the security headers, and what does its raw HTML say. Costs one x402 payment.
    JavaScript is NOT rendered, so html.checked is always "raw_html_only"."""
    started = time.perf_counter()
    verified, refusal = await _gate("check_url", payment)
    if refusal is not None:
        return refusal
    _, body = await verdict.run_check(url, metered=True, network=verified.network)
    return await _finish("check_url", verified, body, started, host_of(url))


@mcp.tool()
async def check_tls(host: str, payment: str | None = None) -> dict:
    """Certificate facts for one hostname: does it verify, how many days until it
    expires, who issued it, does it actually cover this hostname."""
    started = time.perf_counter()
    verified, refusal = await _gate("check_tls", payment)
    if refusal is not None:
        return refusal
    _, body = await verdict.run_tls(host, metered=True, network=verified.network)
    return await _finish("check_tls", verified, body, started, host)


@mcp.tool()
async def check_headers(url: str, payment: str | None = None) -> dict:
    """Status, timings and the four security headers (HSTS, CSP, X-Frame-Options,
    X-Content-Type-Options) for one URL."""
    started = time.perf_counter()
    verified, refusal = await _gate("check_headers", payment)
    if refusal is not None:
        return refusal
    _, body = await verdict.run_headers(url, metered=True, network=verified.network)
    return await _finish("check_headers", verified, body, started, host_of(url))


def streamable_http_app():
    """Starlette app for the streamable-HTTP transport (also creates the session
    manager that app/main.py runs inside its lifespan)."""
    return mcp.streamable_http_app()


if __name__ == "__main__":
    anyio.run(init_db)
    mcp.run()  # stdio transport
