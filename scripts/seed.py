"""Create the tables and report what is there. Idempotent.

Quanta has no seed data - it checks live URLs. This script exists so a fresh
deployment can prove its schema is in place before any traffic arrives.

    python -m scripts.seed
"""
from __future__ import annotations

import asyncio

from sqlalchemy import func, select

from app.db import SessionLocal, init_db
from app.models import IdempotencyRecord, RateBucket, UsageLog


async def main() -> None:
    await init_db()
    async with SessionLocal() as s:
        counts = {
            "usage_log": (await s.execute(select(func.count()).select_from(UsageLog))).scalar_one(),
            "idempotency": (await s.execute(select(func.count()).select_from(IdempotencyRecord))).scalar_one(),
            "rate_bucket": (await s.execute(select(func.count()).select_from(RateBucket))).scalar_one(),
        }
    print("schema ready. rows:", counts)


if __name__ == "__main__":
    asyncio.run(main())
