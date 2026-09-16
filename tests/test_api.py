"""HTTP surface, with metering ON.

The point of this file: a paid route must produce a real 402 carrying real
payment requirements. Not "402 or 200, either is fine".
"""
from __future__ import annotations

import base64
import json

PAID_ROUTES = ["/v1/assets", "/v1/assets/BTC", "/v1/signals/BTC"]


def test_health_is_free(client):
    assert client.get("/health").json() == {"ok": True}


def test_root_lists_both_surfaces(client):
    body = client.get("/").json()
    assert body["metered_via_x402"] is True
    assert body["mcp"]["endpoint"] == "/mcp"
    assert "GET /v1/assets" in body["paid_routes"]


def test_paid_routes_all_challenge_when_unpaid(client):
    for route in PAID_ROUTES:
        r = client.get(route)
        assert r.status_code == 402, f"{route} returned {r.status_code}, not a payment challenge"


def test_challenge_carries_real_payment_requirements(client):
    r = client.get("/v1/assets/BTC")
    assert r.status_code == 402
    header = r.headers.get("PAYMENT-REQUIRED")
    assert header, f"no PAYMENT-REQUIRED header; got {dict(r.headers)}"

    challenge = json.loads(base64.b64decode(header))
    accepts = challenge["accepts"]
    assert len(accepts) == 1, "SVM is off, so exactly one rail should be advertised"
    option = accepts[0]
    assert option["network"] == "eip155:84532"
    assert option["scheme"] == "exact"
    assert option["payTo"] == "0x1111111111111111111111111111111111111111"
    # $0.001 of USDC (6 decimals) = 1000 atomic units. The SDK computes this;
    # if the price is ever mistyped this assertion catches it.
    assert option["amount"] == "1000"


def test_free_routes_are_not_gated(client):
    assert client.get("/internal/usage").status_code == 200
    assert client.get("/").status_code == 200


def test_unknown_asset_still_challenges_before_the_404(client):
    # The gate runs before the handler: an unpaid caller cannot probe which
    # symbols exist.
    assert client.get("/v1/assets/NOTREAL").status_code == 402


def test_usage_log_redacts_payer(client):
    from app.usage import redact_payer

    assert redact_payer("0xA11CE00000000000000000000000000000000001") == "0xA11C...0001"
    assert redact_payer("") == ""


def test_signal_is_deterministic():
    from app.data import derive_signal

    asset = {"symbol": "ETH", "market_cap_rank": 2, "category": "smart-contract"}
    assert derive_signal(asset) == derive_signal(asset)
    assert derive_signal(asset)["tier"] == "core"
