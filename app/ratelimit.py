"""Token bucket per verified payer, stored in Postgres (SQLite locally).

Capacity 60, refill 1/s by default: an agent can burst sixty calls and then
sustain one a second. The bucket key is the payer address from the VERIFIED
payment payload - there is no API key to rotate and nothing to leak.

Checked after verification and before settlement, so a caller who is over the
limit is refused without their money moving.
"""
from __future__ import annotations

import math

from .config import settings
from .db import SessionLocal
from .models import RateBucket, utcnow


async def take(payer: str, cost: float = 1.0) -> tuple[bool, int]:
    """Spend one token. Returns (allowed, retry_after_seconds)."""
    if not payer:
        return True, 0
    capacity = float(settings.rate_capacity)
    refill = float(settings.rate_refill_per_s)
    now = utcnow()

    async with SessionLocal() as s:
        row = await s.get(RateBucket, payer, with_for_update=False)
        if row is None:
            row = RateBucket(payer=payer, tokens=capacity, updated_at=now)
            s.add(row)
            tokens = capacity
        else:
            last = row.updated_at
            if last.tzinfo is None:  # SQLite hands back naive datetimes
                last = last.replace(tzinfo=now.tzinfo)
            elapsed = max(0.0, (now - last).total_seconds())
            tokens = min(capacity, row.tokens + elapsed * refill)

        if tokens < cost:
            deficit = cost - tokens
            retry_after = int(math.ceil(deficit / refill)) if refill > 0 else 60
            row.tokens = tokens
            row.updated_at = now
            await s.commit()
            return False, max(1, retry_after)

        row.tokens = tokens - cost
        row.updated_at = now
        await s.commit()
        return True, 0


async def reset(payer: str) -> None:
    """Drop a payer's bucket (tests)."""
    async with SessionLocal() as s:
        row = await s.get(RateBucket, payer)
        if row is not None:
            await s.delete(row)
            await s.commit()
