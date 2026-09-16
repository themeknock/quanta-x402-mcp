"""The audit log writer/reader. One place writes usage_log, both surfaces use it."""
from __future__ import annotations

import hashlib
import json
from typing import Any

from sqlalchemy import desc, select, update

from .db import SessionLocal
from .models import UsageLog


def body_hash(body: Any) -> str:
    """sha256 of a response body - lets a caller prove a replay returned the
    same bytes without us storing the body in the log."""
    raw = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


def redact_payer(payer: str) -> str:
    """Public audit trail shows the first 6 and last 4 characters of an address."""
    if not payer or len(payer) <= 10:
        return payer
    return f"{payer[:6]}...{payer[-4:]}"


async def log_usage(
    surface: str,
    route: str,
    *,
    target_host: str = "",
    network: str = "",
    payer: str = "",
    amount: str = "",
    tx_ref: str = "",
    paid: bool = False,
    idempotent_replay: bool = False,
    duration_ms: int = 0,
    verdict_hash: str = "",
    payment_nonce: str = "",
) -> None:
    async with SessionLocal() as s:
        s.add(UsageLog(surface=surface, route=route, target_host=target_host,
                       network=network, payer=payer, amount=amount, tx_ref=tx_ref,
                       paid=paid, idempotent_replay=idempotent_replay,
                       duration_ms=duration_ms, verdict_hash=verdict_hash,
                       payment_nonce=payment_nonce))
        await s.commit()


async def mark_settled(nonce: str, *, tx_ref: str, payer: str = "",
                       network: str = "") -> None:
    """Stamp the settlement onto the row the HTTP route already wrote.

    The route cannot know the tx hash: the SDK middleware settles after the
    handler returns. So the row goes in unpaid and this runs from the SDK's
    after-settle hook. Matching on the payment nonce, which is unique per
    payment and visible on both sides.
    """
    if not nonce:
        return
    values = {"paid": True, "tx_ref": tx_ref}
    if payer:
        values["payer"] = payer
    if network:
        values["network"] = network
    async with SessionLocal() as s:
        await s.execute(
            update(UsageLog)
            .where(UsageLog.payment_nonce == nonce, UsageLog.paid.is_(False))
            .values(**values)
        )
        await s.commit()


async def recent_usage(limit: int = 25) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 200))
    async with SessionLocal() as s:
        rows = (
            await s.execute(select(UsageLog).order_by(desc(UsageLog.ts), desc(UsageLog.id)).limit(limit))
        ).scalars().all()
        return [
            {"ts": r.ts.isoformat(), "surface": r.surface, "route": r.route,
             "target_host": r.target_host, "network": r.network,
             "payer": redact_payer(r.payer), "amount": r.amount, "tx_ref": r.tx_ref,
             "paid": r.paid, "idempotent_replay": r.idempotent_replay,
             "duration_ms": r.duration_ms, "verdict_hash": r.verdict_hash}
            for r in rows
        ]
