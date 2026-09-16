"""Seed data + the query functions shared by the HTTP API and the MCP server.

The dataset is a small, clearly-labelled SAMPLE snapshot - enough to prove the
pay-per-call mechanics end to end without pretending to be a live market feed.
It is replaced by live website checks when the service is re-domained; the usage
log has already moved to app/usage.py.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select

from .db import SessionLocal
from .models import Asset

SEED_ASSETS: list[dict[str, Any]] = [
    {"symbol": "BTC", "name": "Bitcoin", "chain": "bitcoin", "category": "store-of-value",
     "market_cap_rank": 1, "circulating_supply": 19_700_000.0,
     "attributes": {"consensus": "pow", "tags": ["l1", "blue-chip"]}},
    {"symbol": "ETH", "name": "Ethereum", "chain": "ethereum", "category": "smart-contract",
     "market_cap_rank": 2, "circulating_supply": 120_400_000.0,
     "attributes": {"consensus": "pos", "tags": ["l1", "evm"], "evm": True}},
    {"symbol": "SOL", "name": "Solana", "chain": "solana", "category": "smart-contract",
     "market_cap_rank": 5, "circulating_supply": 470_000_000.0,
     "attributes": {"consensus": "pos", "tags": ["l1", "high-throughput"], "svm": True}},
    {"symbol": "USDC", "name": "USD Coin", "chain": "multi", "category": "stablecoin",
     "market_cap_rank": 6, "circulating_supply": 34_000_000_000.0,
     "attributes": {"issuer": "circle", "tags": ["stablecoin", "x402-settlement"]}},
    {"symbol": "BASE", "name": "Base", "chain": "base", "category": "l2",
     "market_cap_rank": 0, "circulating_supply": 0.0,
     "attributes": {"rollup": "optimistic", "settles_to": "ethereum", "tags": ["l2", "evm"]}},
    {"symbol": "LINK", "name": "Chainlink", "chain": "ethereum", "category": "oracle",
     "market_cap_rank": 14, "circulating_supply": 657_000_000.0,
     "attributes": {"tags": ["oracle", "evm"]}},
    {"symbol": "ARB", "name": "Arbitrum", "chain": "arbitrum", "category": "l2",
     "market_cap_rank": 40, "circulating_supply": 4_000_000_000.0,
     "attributes": {"rollup": "optimistic", "tags": ["l2", "evm"]}},
    {"symbol": "JUP", "name": "Jupiter", "chain": "solana", "category": "defi",
     "market_cap_rank": 55, "circulating_supply": 2_700_000_000.0,
     "attributes": {"tags": ["dex-aggregator", "svm"]}},
]


def _asset_dict(a: Asset) -> dict[str, Any]:
    return {
        "symbol": a.symbol,
        "name": a.name,
        "chain": a.chain,
        "category": a.category,
        "market_cap_rank": a.market_cap_rank or None,
        "circulating_supply": a.circulating_supply,
        "attributes": a.attributes or {},
    }


async def seed_if_empty() -> None:
    async with SessionLocal() as s:
        existing = (await s.execute(select(Asset))).scalars().first()
        if existing:
            return
        s.add_all([Asset(**row) for row in SEED_ASSETS])
        await s.commit()


async def list_assets() -> list[dict[str, Any]]:
    async with SessionLocal() as s:
        rows = (
            await s.execute(select(Asset).order_by(Asset.market_cap_rank))
        ).scalars().all()
        return [_asset_dict(a) for a in rows]


async def get_asset(symbol: str) -> dict[str, Any] | None:
    async with SessionLocal() as s:
        a = await s.get(Asset, symbol.upper())
        return _asset_dict(a) if a else None


def derive_signal(asset: dict[str, Any]) -> dict[str, Any]:
    """A tiny deterministic 'signal' derived from the structured record - shows the
    API can serve computed views, not just rows. Deterministic, so it is testable."""
    rank = asset.get("market_cap_rank") or 999
    cat = asset.get("category")
    tier = "core" if rank and rank <= 5 else "mid" if rank and rank <= 50 else "long-tail"
    bias = "accumulate" if cat in {"store-of-value", "smart-contract"} else "neutral"
    return {"symbol": asset["symbol"], "tier": tier, "bias": bias, "rank": rank}
