"""The MCP payment gate.

The bug this file exists for: the first version gated tools with
`if settings.x402_enabled and not payment:` - a presence check. `payment="x"`
returned the data for free. These tests assert that a payment is verified with
the facilitator before a tool runs, and settled after.
"""
from __future__ import annotations

import json

import pytest

from tests.conftest import PAYER, TX_HASH, payment_header


def _rpc(client, method: str, params: dict | None = None, rid: int = 1):
    body = {"jsonrpc": "2.0", "id": rid, "method": method}
    if params is not None:
        body["params"] = params
    r = client.post("/mcp", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _tool(client, name: str, args: dict) -> dict:
    out = _rpc(client, "tools/call", {"name": name, "arguments": args})
    content = out["result"]["content"][0]["text"]
    return json.loads(content)


def test_mcp_endpoint_lists_three_tools(client):
    names = sorted(t["name"] for t in _rpc(client, "tools/list")["result"]["tools"])
    assert names == ["get_asset", "get_signal", "list_assets"]


def test_bogus_payment_is_refused(client, reset_facilitator):
    body = _tool(client, "get_asset", {"symbol": "BTC", "payment": "bogus"})
    assert body["x402"] == "payment_invalid"
    assert body["reason"] == "malformed_payment_payload"
    assert "asset" not in body
    # It never even reached the facilitator: the payload did not decode.
    assert reset_facilitator.verify_calls == []
    assert reset_facilitator.settle_calls == []


def test_presence_alone_buys_nothing_on_any_tool(client, reset_facilitator):
    for name, args in [("list_assets", {}), ("get_asset", {"symbol": "BTC"}),
                       ("get_signal", {"symbol": "BTC"})]:
        body = _tool(client, name, {**args, "payment": "x"})
        assert body["x402"] == "payment_invalid", f"{name} accepted a junk payment"
    assert reset_facilitator.settle_calls == []


def test_no_payment_returns_a_challenge_built_by_the_sdk(client, reset_facilitator):
    body = _tool(client, "get_asset", {"symbol": "BTC"})
    assert body["x402"] == "payment_required"
    assert len(body["accepts"]) == 1
    option = body["accepts"][0]
    # Same price and rail the HTTP 402 advertises - one source of truth.
    assert option["network"] == "eip155:84532"
    assert option["amount"] == "1000"
    assert option["payTo"] == "0x1111111111111111111111111111111111111111"


def test_a_payment_the_facilitator_rejects_is_refused(client, reset_facilitator):
    reset_facilitator.reject_verify = "insufficient_funds"
    header = payment_header()
    body = _tool(client, "get_asset", {"symbol": "BTC", "payment": header})
    assert body == {"x402": "payment_invalid", "reason": "insufficient_funds",
                    "message": "stub facilitator rejected this payment"}
    assert len(reset_facilitator.verify_calls) == 1
    assert reset_facilitator.settle_calls == [], "a rejected payment must never settle"


def test_a_payment_for_the_wrong_price_finds_no_matching_requirements(client, reset_facilitator):
    header = payment_header("1")  # 1 atomic unit, not 1000
    body = _tool(client, "get_asset", {"symbol": "BTC", "payment": header})
    assert body["x402"] == "payment_invalid"
    assert body["reason"] == "no_matching_requirements"
    assert reset_facilitator.verify_calls == []


def test_a_verified_payment_runs_the_tool_and_settles(client, reset_facilitator):
    header = payment_header()
    body = _tool(client, "get_asset", {"symbol": "BTC", "payment": header})
    assert body["asset"]["symbol"] == "BTC"
    assert body["_meta"]["metered"] is True
    assert body["_meta"]["tx_ref"] == TX_HASH
    assert len(reset_facilitator.verify_calls) == 1
    assert len(reset_facilitator.settle_calls) == 1, "verified payment must settle"

    # ... and it is in the audit log, with the payer shortened.
    recent = client.get("/internal/usage?limit=5").json()["recent"]
    row = next(r for r in recent if r["surface"] == "mcp" and r["route"] == "get_asset")
    assert row["paid"] is True
    assert row["tx_ref"] == TX_HASH
    assert row["payer"] == f"{PAYER[:6]}...{PAYER[-4:]}"
    assert row["network"] == "eip155:84532"


def test_settlement_failure_does_not_pretend_it_worked(client, reset_facilitator):
    reset_facilitator.reject_settle = "insufficient_allowance"
    header = payment_header()
    body = _tool(client, "list_assets", {"payment": header})
    assert body == {"x402": "settlement_failed", "reason": "insufficient_allowance"}
    row = next(r for r in client.get("/internal/usage?limit=5").json()["recent"]
               if r["route"] == "list_assets")
    assert row["paid"] is False
    assert row["tx_ref"] == ""


@pytest.mark.parametrize("tool", ["list_assets", "get_asset", "get_signal"])
def test_every_tool_is_gated(client, reset_facilitator, tool):
    args = {} if tool == "list_assets" else {"symbol": "BTC"}
    body = _tool(client, tool, args)
    assert body["x402"] == "payment_required"
