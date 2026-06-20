"""Create tables and load the sample dataset. Idempotent.

    python -m scripts.seed
"""
from __future__ import annotations

import asyncio

from app.data import seed_if_empty
from app.db import init_db


async def main() -> None:
    await init_db()
    await seed_if_empty()
    print("seeded.")


if __name__ == "__main__":
    asyncio.run(main())
