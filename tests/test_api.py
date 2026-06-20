"""Core invariants.

* health is free and works.
* a protected data route is either a 402 challenge (metering on) or returns data
  (dev mode, metering off) - never a 500.
* the derived signal is deterministic.
"""
from fastapi.testclient import TestClient

from app.data import derive_signal
from app.main import app


def test_health_is_free():
    with TestClient(app) as client:
        assert client.get("/health").json() == {"ok": True}


def test_protected_route_challenges_or_serves():
    with TestClient(app) as client:
        r = client.get("/v1/assets/BTC")
        assert r.status_code in (200, 402)
        if r.status_code == 402:
            assert "PAYMENT-REQUIRED" in r.headers or "accept" in r.text.lower()
        else:
            assert r.json()["asset"]["symbol"] == "BTC"


def test_unknown_asset_is_404_not_500():
    with TestClient(app) as client:
        r = client.get("/v1/assets/NOTREAL")
        # 404 when reachable unmetered; 402 if metering intercepts first.
        assert r.status_code in (404, 402)


def test_signal_is_deterministic():
    asset = {"symbol": "ETH", "market_cap_rank": 2, "category": "smart-contract"}
    assert derive_signal(asset) == derive_signal(asset)
    assert derive_signal(asset)["tier"] == "core"
