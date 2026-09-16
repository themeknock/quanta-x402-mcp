"""Real x402 payment verification for the MCP surface.

Why this file exists: the HTTP side is gated by the SDK's ASGI middleware, which
decodes the payment header, verifies it with the facilitator, runs the handler,
then settles. MCP has no middleware - the payment arrives as a tool argument. The
first version of this service gated MCP tools with `if not payment:`, which is a
presence check: `payment="x"` got the data for free. This module does the real
thing, through the SAME `x402ResourceServer` the middleware uses, so price, rails
and requirements cannot drift between the two surfaces.

Order of operations, deliberately matching the middleware:
    decode -> find matching requirements -> verify (facilitator)
    -> [caller runs rate limit / idempotency / the tool] -> settle (facilitator)

Verification and settlement are two steps for a reason: a caller who is over the
rate limit is refused *before* their money moves.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from .config import settings
from .x402_setup import get_resource_server, resource_configs

log = logging.getLogger("quanta.payments")

_initialized = False
# One lock per event loop: the app has one, the test suite spins up others, and
# an asyncio.Lock cannot be shared across loops.
_locks: dict[Any, asyncio.Lock] = {}


def _loop_lock() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    lock = _locks.get(loop)
    if lock is None:
        lock = _locks[loop] = asyncio.Lock()
    return lock


class FacilitatorUnavailable(RuntimeError):
    """The facilitator could not be reached, so we cannot price or verify."""


async def _ready() -> Any:
    """Return the initialized resource server, or None in unmetered dev mode.

    `initialize()` is a blocking HTTP call to the facilitator (it asks which
    scheme/network pairs it supports), so it runs in a thread and only once.
    """
    global _initialized
    server = get_resource_server()
    if server is None:
        return None
    if not _initialized:
        async with _loop_lock():
            if not _initialized:
                try:
                    await asyncio.to_thread(server.initialize)
                except Exception as exc:
                    raise FacilitatorUnavailable(str(exc)) from exc
                _initialized = True
    return server


def reset_for_tests() -> None:
    global _initialized
    _initialized = False


async def payment_requirements() -> list[Any]:
    """The accepted payment requirements, one per enabled rail, built by the SDK."""
    server = await _ready()
    if server is None:
        return []
    out: list[Any] = []
    for config in resource_configs():
        out.extend(server.build_payment_requirements(config))
    return out


async def mcp_challenge(route_key: str, resource: str = "") -> dict[str, Any]:
    """The x402 challenge an unpaid MCP tool call gets back.

    Same `accepts[]` the HTTP 402 carries, because it is built from the same
    server instance and the same ResourceConfig.
    """
    try:
        requirements = await payment_requirements()
    except FacilitatorUnavailable as exc:
        log.warning("cannot build challenge: facilitator unavailable (%s)", exc)
        return {"x402": "facilitator_unavailable", "reason": str(exc),
                "hint": "The payment facilitator is unreachable, so this tool cannot be priced right now."}
    return {
        "x402": "payment_required",
        "x402Version": 2,
        "resource": resource or route_key,
        "description": route_key,
        "accepts": [r.model_dump(by_alias=True, exclude_none=True) for r in requirements],
        "hint": ("Pay with an x402 client, then call this tool again with "
                 "payment=<base64 payment payload>."),
    }


@dataclass
class PaymentRefusal:
    """A payment that did not verify. The tool must not run."""

    reason: str
    message: str | None = None

    ok: bool = field(default=False, init=False)

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"x402": "payment_invalid", "reason": self.reason}
        if self.message:
            out["message"] = self.message
        return out


@dataclass
class VerifiedPayment:
    """A payment the facilitator confirmed. Settlement has NOT happened yet."""

    payer: str
    network: str
    amount: str
    payload: Any
    requirements: Any
    server: Any

    ok: bool = field(default=True, init=False)
    tx_ref: str = field(default="", init=False)

    async def settle(self) -> tuple[bool, str]:
        """Move the money. Returns (success, tx_ref_or_error_reason)."""
        try:
            result = await self.server.settle_payment(self.payload, self.requirements)
        except Exception as exc:  # facilitator down mid-flight
            log.warning("settlement raised: %s", exc)
            return False, f"settle_error:{exc}"
        if not result.success:
            return False, result.error_reason or "settle_failed"
        self.tx_ref = result.transaction or ""
        if result.payer:
            self.payer = result.payer
        return True, self.tx_ref


async def verify_mcp_payment(
    payment_b64: str, route_key: str
) -> VerifiedPayment | PaymentRefusal:
    """Decode and verify a payment payload handed to an MCP tool.

    Returns VerifiedPayment (caller must call .settle() after the tool succeeds)
    or PaymentRefusal. Never raises on caller input.
    """
    from x402.http.utils import decode_payment_signature_header

    try:
        server = await _ready()
    except FacilitatorUnavailable as exc:
        return PaymentRefusal("facilitator_unavailable", str(exc))

    if server is None:
        # Unmetered dev mode: there is nothing to verify against. Refuse rather
        # than pretend a payment was checked.
        return PaymentRefusal("metering_disabled",
                              "This instance runs unmetered (X402_ENABLED=false); payments are not accepted.")

    # 1. decode - exactly the way the SDK middleware decodes the
    #    `payment-signature` / `x-payment` header.
    try:
        payload = decode_payment_signature_header(payment_b64)
    except Exception as exc:
        return PaymentRefusal("malformed_payment_payload", str(exc))

    # 2. does the payload match something we actually sell?
    try:
        available = await payment_requirements()
    except FacilitatorUnavailable as exc:
        return PaymentRefusal("facilitator_unavailable", str(exc))
    requirements = server.find_matching_requirements(available, payload)
    if requirements is None:
        return PaymentRefusal(
            "no_matching_requirements",
            f"payload does not match any accepted rail/price for {route_key}",
        )

    # 3. verify with the facilitator. Presence is not proof; this is.
    try:
        verified = await server.verify_payment(payload, requirements)
    except Exception as exc:
        log.warning("verify raised: %s", exc)
        return PaymentRefusal("verify_error", str(exc))
    if not verified.is_valid:
        return PaymentRefusal(verified.invalid_reason or "invalid_payment",
                              verified.invalid_message)

    payer = verified.payer or ""
    return VerifiedPayment(
        payer=payer,
        network=str(requirements.network),
        amount=settings.x402_price,
        payload=payload,
        requirements=requirements,
        server=server,
    )
