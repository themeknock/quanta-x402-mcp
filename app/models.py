"""Tables: the audit log, the idempotency cache, the rate-limit buckets.

Two rules the schema enforces on purpose:
  * never store the full target URL (a query string can carry a token) - host only;
  * never store the raw payment header.

`Asset` is the last of the original crypto sample dataset. It is deleted when the
service is re-domained to website checks.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Asset(Base):
    __tablename__ = "assets"

    symbol: Mapped[str] = mapped_column(String(16), primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    chain: Mapped[str] = mapped_column(String(32))
    category: Mapped[str] = mapped_column(String(32))
    market_cap_rank: Mapped[int] = mapped_column(Integer)
    circulating_supply: Mapped[float] = mapped_column(Float)
    # Free-form structured extras (links, tags, contract addresses, ...).
    attributes: Mapped[dict] = mapped_column(JSON, default=dict)


class UsageLog(Base):
    """One row per call that reached the service, paid or not.

    This is the audit trail behind GET /internal/usage: who paid, on which chain,
    for which host, how long it took, and whether the answer was a replay.
    """

    __tablename__ = "usage_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    surface: Mapped[str] = mapped_column(String(8), default="http")     # 'http' | 'mcp'
    route: Mapped[str] = mapped_column(String(128))                     # '/v1/check' | 'check_url'
    target_host: Mapped[str] = mapped_column(String(255), default="")   # host only, never the full URL
    network: Mapped[str] = mapped_column(String(48), default="")        # 'eip155:84532'
    payer: Mapped[str] = mapped_column(String(96), default="")          # from the VERIFIED payload
    amount: Mapped[str] = mapped_column(String(24), default="")
    tx_ref: Mapped[str] = mapped_column(String(120), default="")        # settlement tx hash
    paid: Mapped[bool] = mapped_column(Boolean, default=False)
    idempotent_replay: Mapped[bool] = mapped_column(Boolean, default=False)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    verdict_hash: Mapped[str] = mapped_column(String(64), default="")   # sha256 of the body


class IdempotencyRecord(Base):
    """(payer, key) -> the exact body we already returned. Pruned after 24h.

    `request_hash` is what makes "same key, different request -> 409" possible:
    the route name alone cannot tell two different targets apart.
    """

    __tablename__ = "idempotency"

    payer: Mapped[str] = mapped_column(String(96), primary_key=True)
    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    route: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64), default="")
    body: Mapped[dict] = mapped_column(JSON)
    status_code: Mapped[int] = mapped_column(Integer, default=200)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class RateBucket(Base):
    """Token bucket per verified payer. The payment address IS the principal."""

    __tablename__ = "rate_bucket"

    payer: Mapped[str] = mapped_column(String(96), primary_key=True)
    tokens: Mapped[float] = mapped_column(Float)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
