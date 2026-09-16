"""Test rig.

Two things make this suite worth having:

  * metering is ON. Every test runs with X402_ENABLED=true against a stub
    facilitator, so "the route returned 402" is an assertion, not a tolerance.
    The old suite asserted `status_code in (200, 402)`, which passed whether or
    not payment was ever enforced.
  * no network. The stub facilitator answers get_supported/verify/settle in
    process, so the tests do not depend on x402.org being up. Everything else -
    the resource server, the payment requirements, the EVM scheme, the encoding
    of the payload - is the real SDK.
"""
from __future__ import annotations

import os
import tempfile

import pytest

# Env must be set before app.config imports Settings.
_TMP_DB = os.path.join(tempfile.mkdtemp(prefix="quanta-test-"), "test.db")
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_TMP_DB}"
os.environ["X402_ENABLED"] = "true"
os.environ["X402_EVM_ADDRESS"] = "0x1111111111111111111111111111111111111111"
os.environ["X402_PRICE"] = "$0.001"
os.environ["X402_ENABLE_SVM"] = "false"
os.environ["MCP_EXTRA_HOSTS"] = "testserver"
os.environ["RATE_CAPACITY"] = "60"
os.environ["RATE_REFILL_PER_S"] = "1"

from x402.http.utils import safe_base64_encode  # noqa: E402
from x402.schemas import (  # noqa: E402
    PaymentPayload,
    SettleResponse,
    SupportedKind,
    SupportedResponse,
    VerifyResponse,
)

EVM_NETWORK = "eip155:84532"
PAYER = "0xA11CE00000000000000000000000000000000001"
TX_HASH = "0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface"


class StubFacilitator:
    """Stands in for the x402.org facilitator. Answers the three calls the SDK
    makes, records them, and can be told to reject."""

    def __init__(self) -> None:
        self.verify_calls: list = []
        self.settle_calls: list = []
        self.reject_verify: str | None = None
        self.reject_settle: str | None = None

    def get_supported(self) -> SupportedResponse:
        return SupportedResponse(
            kinds=[SupportedKind(x402_version=2, scheme="exact", network=EVM_NETWORK)]
        )

    async def verify(self, payload, requirements) -> VerifyResponse:
        self.verify_calls.append((payload, requirements))
        if self.reject_verify:
            return VerifyResponse(is_valid=False, invalid_reason=self.reject_verify,
                                  invalid_message="stub facilitator rejected this payment")
        return VerifyResponse(is_valid=True, payer=PAYER)

    async def settle(self, payload, requirements) -> SettleResponse:
        self.settle_calls.append((payload, requirements))
        if self.reject_settle:
            return SettleResponse(success=False, error_reason=self.reject_settle,
                                  transaction="", network=EVM_NETWORK, payer=PAYER)
        return SettleResponse(success=True, transaction=TX_HASH,
                              network=EVM_NETWORK, payer=PAYER, amount="1000")


@pytest.fixture(scope="session")
def facilitator() -> StubFacilitator:
    from app import x402_setup

    stub = StubFacilitator()
    x402_setup.set_facilitator_client(stub)
    return stub


@pytest.fixture(scope="session")
def client(facilitator):
    """TestClient with metering ON and the stub facilitator wired in."""
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def reset_facilitator(facilitator):
    facilitator.reject_verify = None
    facilitator.reject_settle = None
    facilitator.verify_calls.clear()
    facilitator.settle_calls.clear()
    yield facilitator


def payment_header(price_override: str | None = None) -> str:
    """Sync wrapper - pytest runs on a thread that has no event loop."""
    import asyncio

    return asyncio.run(_build_payment_header(price_override))


async def _build_payment_header(price_override: str | None = None) -> str:
    """A well-formed payment payload for the price this service advertises.

    The signature inside is not a real EIP-3009 authorization - the stub
    facilitator is what decides valid/invalid here. What this exercises is our
    code path: decode -> find_matching_requirements -> verify -> settle.
    """
    from app.payments import payment_requirements

    requirements = (await payment_requirements())[0]
    if price_override is not None:
        requirements = requirements.model_copy(update={"amount": price_override})
    payload = PaymentPayload(
        x402_version=2,
        accepted=requirements,
        payload={"signature": "0x" + "ab" * 32,
                 "authorization": {"from": PAYER, "to": requirements.pay_to,
                                   "value": requirements.amount}},
    )
    return safe_base64_encode(payload.model_dump_json(by_alias=True, exclude_none=True))
