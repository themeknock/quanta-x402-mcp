"""Per-payer token bucket. Capacity 60, refill 1/s.

Checked after verification and before settlement, so an agent that is over the
limit is refused without paying for the refusal.
"""
from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest

from app import ratelimit
from app.config import settings
from app.db import SessionLocal, init_db
from app.models import RateBucket, utcnow

PAYER = "0xRATE000000000000000000000000000000000001"
OTHER = "0xRATE000000000000000000000000000000000002"


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True, scope="module")
def _db(client):
    run(init_db())


@pytest.fixture(autouse=True)
def _clean():
    run(ratelimit.reset(PAYER))
    run(ratelimit.reset(OTHER))
    yield


def test_burst_up_to_capacity_then_refuse():
    capacity = settings.rate_capacity
    for i in range(capacity):
        allowed, _ = run(ratelimit.take(PAYER))
        assert allowed, f"refused at call {i + 1} of {capacity}"

    allowed, retry_after = run(ratelimit.take(PAYER))
    assert allowed is False
    assert retry_after >= 1


def test_buckets_are_per_payer():
    for _ in range(settings.rate_capacity):
        run(ratelimit.take(PAYER))
    assert run(ratelimit.take(PAYER))[0] is False
    assert run(ratelimit.take(OTHER))[0] is True


def test_tokens_refill_over_time():
    for _ in range(settings.rate_capacity):
        run(ratelimit.take(PAYER))
    assert run(ratelimit.take(PAYER))[0] is False

    async def _rewind(seconds: int):
        async with SessionLocal() as s:
            row = await s.get(RateBucket, PAYER)
            row.updated_at = utcnow() - timedelta(seconds=seconds)
            await s.commit()

    run(_rewind(5))  # five seconds of refill at 1/s
    for _ in range(5):
        assert run(ratelimit.take(PAYER))[0] is True
    assert run(ratelimit.take(PAYER))[0] is False


def test_refill_never_exceeds_capacity():
    run(ratelimit.take(PAYER))

    async def _rewind_far():
        async with SessionLocal() as s:
            row = await s.get(RateBucket, PAYER)
            row.updated_at = utcnow() - timedelta(days=7)
            await s.commit()

    run(_rewind_far())
    for i in range(settings.rate_capacity):
        assert run(ratelimit.take(PAYER))[0] is True, f"refused at {i + 1}"
    assert run(ratelimit.take(PAYER))[0] is False


def test_unknown_payer_is_not_metered():
    # No verified payer (dev mode) -> nothing to key a bucket on; do not invent one.
    assert run(ratelimit.take(""))[0] is True
