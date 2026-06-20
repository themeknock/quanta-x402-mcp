"""Data model: the structured records agents pay for, plus a usage/payment log.

Every paid call is written to `usage_log` - this is what makes "done means it
demonstrably works" auditable: the operator can see exactly which agent paid,
on which chain, for which record.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def _utcnow() -> datetime:
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
    __tablename__ = "usage_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    route: Mapped[str] = mapped_column(String(128))
    symbol: Mapped[str] = mapped_column(String(16), default="")
    network: Mapped[str] = mapped_column(String(48), default="")
    payer: Mapped[str] = mapped_column(String(96), default="")
    amount: Mapped[str] = mapped_column(String(24), default="")
    tx_ref: Mapped[str] = mapped_column(String(120), default="")
    paid: Mapped[bool] = mapped_column(Boolean, default=False)
