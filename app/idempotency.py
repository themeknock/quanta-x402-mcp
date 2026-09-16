"""Idempotency: (verified payer, Idempotency-Key) -> the body we already returned.

The payment is the identity, so the key space is per payer - one agent cannot
read or clobber another agent's cached answer by guessing a key.

Honest note about cost, because it is not what people assume: a replay does not
repeat the *work*, but it still costs the caller a payment. On HTTP the SDK
middleware verifies and settles around the handler, and we do not reach inside
it; on MCP we settle for the same reason, so the price of a call does not depend
on which transport the agent happened to use.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy import delete, select

from .db import SessionLocal
from .models import IdempotencyRecord, utcnow

MAX_KEY_LEN = 128
TTL = timedelta(hours=24)


def request_hash(route: str, params: dict[str, Any]) -> str:
    raw = json.dumps({"route": route, "params": params}, sort_keys=True,
                     separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


@dataclass
class Outcome:
    """'miss' -> do the work. 'hit' -> return body/status. 'conflict' -> 409."""

    kind: str
    body: dict[str, Any] | None = None
    status_code: int = 200

    @property
    def is_hit(self) -> bool:
        return self.kind == "hit"

    @property
    def is_conflict(self) -> bool:
        return self.kind == "conflict"


MISS = "miss"


async def lookup(payer: str, key: str, route: str, req_hash: str) -> Outcome:
    if not payer or not key:
        return Outcome(MISS)
    async with SessionLocal() as s:
        await _prune(s)
        row = await s.get(IdempotencyRecord, (payer, key[:MAX_KEY_LEN]))
        if row is None:
            return Outcome(MISS)
        if row.route != route or row.request_hash != req_hash:
            return Outcome("conflict")
        return Outcome("hit", body=row.body, status_code=row.status_code)


async def remember(payer: str, key: str, route: str, req_hash: str,
                   body: dict[str, Any], status_code: int = 200) -> None:
    if not payer or not key:
        return
    key = key[:MAX_KEY_LEN]
    async with SessionLocal() as s:
        row = await s.get(IdempotencyRecord, (payer, key))
        if row is None:
            s.add(IdempotencyRecord(payer=payer, key=key, route=route,
                                    request_hash=req_hash, body=body,
                                    status_code=status_code, created_at=utcnow()))
        else:
            row.route, row.request_hash = route, req_hash
            row.body, row.status_code, row.created_at = body, status_code, utcnow()
        await s.commit()


async def _prune(s) -> None:
    """Drop rows older than the TTL. Done on read/write so there is no cron."""
    await s.execute(
        delete(IdempotencyRecord).where(IdempotencyRecord.created_at < utcnow() - TTL)
    )
    await s.commit()


async def count() -> int:
    async with SessionLocal() as s:
        rows = (await s.execute(select(IdempotencyRecord))).scalars().all()
        return len(rows)
