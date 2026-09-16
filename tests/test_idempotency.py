"""Idempotency: same payer + same key + same request -> the same answer, once.

The key space is per payer, which is the whole point of "the payment is the
identity": one agent cannot read or overwrite another agent's cached answer by
guessing a key.
"""
from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest

from app import idempotency
from app.db import init_db
from app.models import IdempotencyRecord, utcnow

PAYER_A = "0xA11CE00000000000000000000000000000000001"
PAYER_B = "0xB0B0000000000000000000000000000000000002"
ROUTE = "/v1/check"


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True, scope="module")
def _db(client):
    """Reuse the app's initialised test DB."""
    run(init_db())


def test_miss_then_hit():
    h = idempotency.request_hash(ROUTE, {"url": "https://example.com"})
    assert run(idempotency.lookup(PAYER_A, "k1", ROUTE, h)).kind == "miss"

    run(idempotency.remember(PAYER_A, "k1", ROUTE, h, {"verdict": "ok"}, 200))

    hit = run(idempotency.lookup(PAYER_A, "k1", ROUTE, h))
    assert hit.is_hit
    assert hit.body == {"verdict": "ok"}
    assert hit.status_code == 200


def test_same_key_different_target_is_a_conflict():
    h1 = idempotency.request_hash(ROUTE, {"url": "https://example.com"})
    h2 = idempotency.request_hash(ROUTE, {"url": "https://themeknock.net"})
    run(idempotency.remember(PAYER_A, "k2", ROUTE, h1, {"verdict": "ok"}, 200))

    assert run(idempotency.lookup(PAYER_A, "k2", ROUTE, h2)).is_conflict
    assert run(idempotency.lookup(PAYER_A, "k2", "/v1/tls", h1)).is_conflict


def test_keys_do_not_leak_between_payers():
    h = idempotency.request_hash(ROUTE, {"url": "https://example.com"})
    run(idempotency.remember(PAYER_A, "shared-key", ROUTE, h, {"secret": "A"}, 200))

    # Same key, different payer: a miss, not a hit and not a conflict.
    assert run(idempotency.lookup(PAYER_B, "shared-key", ROUTE, h)).kind == "miss"


def test_no_key_means_no_caching():
    h = idempotency.request_hash(ROUTE, {"url": "https://example.com"})
    run(idempotency.remember(PAYER_A, "", ROUTE, h, {"verdict": "ok"}, 200))
    assert run(idempotency.lookup(PAYER_A, "", ROUTE, h)).kind == "miss"


def test_long_keys_are_truncated_not_rejected():
    h = idempotency.request_hash(ROUTE, {"url": "https://example.com"})
    long_key = "z" * 300
    run(idempotency.remember(PAYER_A, long_key, ROUTE, h, {"verdict": "ok"}, 200))
    assert run(idempotency.lookup(PAYER_A, long_key, ROUTE, h)).is_hit
    assert run(idempotency.lookup(PAYER_A, "z" * idempotency.MAX_KEY_LEN, ROUTE, h)).is_hit


def test_records_older_than_24h_are_pruned_on_read():
    h = idempotency.request_hash(ROUTE, {"url": "https://old.example"})

    async def _plant_stale():
        from app.db import SessionLocal
        async with SessionLocal() as s:
            s.add(IdempotencyRecord(payer=PAYER_A, key="stale", route=ROUTE,
                                    request_hash=h, body={"verdict": "old"},
                                    status_code=200,
                                    created_at=utcnow() - timedelta(hours=25)))
            await s.commit()

    run(_plant_stale())
    assert run(idempotency.lookup(PAYER_A, "stale", ROUTE, h)).kind == "miss"
