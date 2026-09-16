"""HTTP surface, with metering ON.

The point of this file: a paid route must produce a real 402 carrying real
payment requirements, and the free routes must stay free and safe. Not
"402 or 200, either is fine".

Paid routes are exercised with a payment in test_paid_routes.py; here they are
only expected to refuse.
"""
from __future__ import annotations

import base64
import json

PAID_ROUTES = [
    "/v1/check?url=https://example.com",
    "/v1/tls?host=example.com",
    "/v1/headers?url=https://example.com",
]


def test_health_is_free_and_checks_the_database(client):
    body = client.get("/health").json()
    assert body == {"ok": True, "db": True}


def test_root_explains_itself_in_one_sentence(client):
    body = client.get("/").json()
    assert body["metered_via_x402"] is True
    assert "pay $0.001" in body["what_it_does"]
    assert body["mcp"]["endpoint"] == "/mcp"
    assert body["mcp"]["tools"] == ["check_url", "check_tls", "check_headers"]
    assert "GET /v1/check" in body["paid_routes"]
    # The limits are on the front page, not buried in a README.
    assert body["limits"]["renders_javascript"] is False
    assert body["limits"]["html_checked"] == "raw_html_only"


def test_paid_routes_all_challenge_when_unpaid(client):
    for route in PAID_ROUTES:
        r = client.get(route)
        assert r.status_code == 402, f"{route} returned {r.status_code}, not a payment challenge"


def test_challenge_carries_real_payment_requirements(client):
    r = client.get("/v1/check?url=https://example.com")
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
    assert "Full check of one URL" in challenge["resource"]["description"]


def test_an_unpaid_caller_cannot_use_the_service_as_a_scanner(client):
    # The gate runs before the handler, so an unpaid request never reaches the
    # fetch code - not even to find out whether a host exists.
    assert client.get("/v1/check?url=http://10.0.0.1/admin").status_code == 402


def test_free_routes_are_not_gated(client):
    assert client.get("/internal/usage").status_code == 200
    assert client.get("/").status_code == 200
    assert client.get("/bot").status_code == 200


def test_bot_page_says_how_to_block_it(client):
    text = client.get("/bot").text
    assert "QuantaCheck/0.2" in text
    assert "User-agent: QuantaCheck" in text
    assert "Disallow: /" in text
    assert "does not run" in text and "JavaScript" in text


def test_demo_only_checks_hosts_we_own(client):
    r = client.get("/demo?url=https://someone-elses-site.example")
    assert r.status_code == 403
    body = r.json()
    assert body["error"] == "demo_host_not_allowed"
    assert "themeknock.net" in body["allowed"]


def test_usage_log_redacts_payer():
    from app.usage import redact_payer

    assert redact_payer("0xA11CE00000000000000000000000000000000001") == "0xA11C...0001"
    assert redact_payer("") == ""


def test_usage_log_never_holds_a_full_url(client):
    rows = client.get("/internal/usage?limit=50").json()["recent"]
    for row in rows:
        assert "?" not in row["target_host"]
        assert "/" not in row["target_host"]
