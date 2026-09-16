"""A paying caller, end to end on the HTTP surface.

Covers the parts that only exist once a payment is real: the verdict shape the
contract promises, the audit row with a settlement hash on it, idempotent
replay, the 409 on a reused key, and the 429 that refuses a caller *before* the
money moves.
"""
from __future__ import annotations

import pytest

from tests.conftest import PAYER, TX_HASH, paid_headers


@pytest.fixture(autouse=True)
def _rig(reset_facilitator, canned_page, no_tls):
    from app import ratelimit

    import asyncio
    asyncio.run(ratelimit.reset(PAYER))
    yield


def test_a_paid_check_returns_the_contract_shape(client):
    r = client.get("/v1/check?url=https://northgate.example/", headers=paid_headers())
    assert r.status_code == 200
    body = r.json()

    assert body["target"] == {"url": "https://northgate.example/",
                              "host": "northgate.example", "ip": "93.184.216.34"}
    assert body["http"]["status"] == 200
    assert body["http"]["ttfb_ms"] == 91
    assert body["tls"]["days_left"] == 60
    assert body["headers"] == {"hsts": True, "csp": False,
                               "x_frame_options": False, "x_content_type_options": True}
    assert body["html"]["checked"] == "raw_html_only"
    assert body["html"]["title"]["text"] == "Northgate Home Services"
    # csp + x-frame-options missing = 8 + 8
    assert body["verdict"] == {"score": 84, "grade": "B", "issues": [
        {"code": "NO_CSP", "severity": "low"},
        {"code": "NO_X_FRAME_OPTIONS", "severity": "low"}]}
    assert body["_meta"]["metered"] is True
    assert body["_meta"]["network"] == "eip155:84532"
    assert body["_meta"]["idempotent_replay"] is False
    assert body["_meta"]["engine"] == "quanta/0.2.0"


def test_the_payment_settles_and_lands_in_the_audit_log(client, reset_facilitator):
    client.get("/v1/check?url=https://northgate.example/", headers=paid_headers())
    assert len(reset_facilitator.settle_calls) == 1

    row = client.get("/internal/usage?limit=1").json()["recent"][0]
    assert row["surface"] == "http"
    assert row["route"] == "/v1/check"
    assert row["target_host"] == "northgate.example"
    assert row["paid"] is True, "the after-settle hook should have stamped the row"
    assert row["tx_ref"] == TX_HASH
    assert row["payer"] == f"{PAYER[:6]}...{PAYER[-4:]}"


def test_headers_and_tls_routes_serve_their_slice(client):
    body = client.get("/v1/headers?url=https://northgate.example/",
                      headers=paid_headers()).json()
    assert set(body) == {"target", "http", "headers", "_meta"}
    assert body["headers"]["hsts"] is True

    body = client.get("/v1/tls?host=northgate.example", headers=paid_headers()).json()
    assert set(body) == {"target", "tls", "_meta"}
    assert body["tls"]["issuer"] == "Let's Encrypt"


def test_a_replay_returns_the_same_body_without_redoing_the_work(client, monkeypatch):
    from app.checks import fetch as fetch_module

    calls = {"n": 0}
    original = fetch_module.get

    async def counting(url):
        calls["n"] += 1
        return await original(url)

    monkeypatch.setattr(fetch_module, "get", counting)

    first = client.get("/v1/check?url=https://northgate.example/",
                       headers=paid_headers("key-1"))
    second = client.get("/v1/check?url=https://northgate.example/",
                        headers=paid_headers("key-1"))

    assert first.status_code == second.status_code == 200
    assert calls["n"] == 1, "the check ran twice; the replay should be cached"
    assert second.json()["_meta"]["idempotent_replay"] is True
    assert second.json()["verdict"] == first.json()["verdict"]

    row = client.get("/internal/usage?limit=1").json()["recent"][0]
    assert row["idempotent_replay"] is True


def test_the_same_key_on_a_different_target_is_a_conflict(client):
    client.get("/v1/check?url=https://northgate.example/", headers=paid_headers("key-2"))
    r = client.get("/v1/check?url=https://example.com/", headers=paid_headers("key-2"))
    assert r.status_code == 409
    assert r.json() == {"error": "idempotency_key_reused_with_different_request"}


def test_over_the_rate_limit_is_refused_before_settlement(client, reset_facilitator):
    from app import ratelimit
    from app.config import settings
    from app.db import SessionLocal
    from app.models import RateBucket

    import asyncio

    async def empty_bucket():
        async with SessionLocal() as s:
            row = await s.get(RateBucket, PAYER)
            if row is None:
                await ratelimit.take(PAYER)
                row = await s.get(RateBucket, PAYER)
            row.tokens = 0.0
            await s.commit()

    asyncio.run(empty_bucket())
    reset_facilitator.settle_calls.clear()

    r = client.get("/v1/check?url=https://northgate.example/", headers=paid_headers())
    assert r.status_code == 429
    assert r.json()["error"] == "rate_limited"
    assert r.json()["retry_after_s"] >= 1
    assert reset_facilitator.settle_calls == [], \
        "a rate-limited caller must not be charged"
    assert settings.rate_capacity == 60


def test_an_internal_target_is_refused_even_when_paid(client, monkeypatch):
    from app.checks import fetch as fetch_module

    monkeypatch.undo()   # drop the canned page; use the real guard
    r = client.get("/v1/check?url=http://169.254.169.254/latest/meta-data/",
                   headers=paid_headers())
    assert r.status_code == 403
    assert r.json() == {"error": "target_blocked", "reason": "metadata_address"}
    assert fetch_module is not None


def test_an_unusable_url_is_a_400_not_a_500(client, monkeypatch):
    monkeypatch.undo()
    r = client.get("/v1/check?url=file:///etc/passwd", headers=paid_headers())
    assert r.status_code == 400
    assert r.json() == {"error": "invalid_url"}
