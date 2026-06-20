"""Demo: an autonomous agent pays per call, then fetches structured data.

Step 1 always runs and proves the metering is live: an unpaid request gets a real
HTTP 402 with payment requirements.

Step 2 runs the full pay -> fetch loop using the x402 client SDK + an EVM signer.
It needs a Base Sepolia test wallet funded with test USDC, supplied as
EVM_PRIVATE_KEY. Without it, step 2 is skipped (the 402 in step 1 is still proof
the contract works).

Usage:
    QUANTA_URL=http://localhost:4021 python -m client.pay_and_fetch
    EVM_PRIVATE_KEY=0x... QUANTA_URL=https://your-app  python -m client.pay_and_fetch
"""
from __future__ import annotations

import asyncio
import os

import httpx

BASE = os.getenv("QUANTA_URL", "http://localhost:4021")


async def main() -> None:
    # 1) Unpaid -> 402 challenge
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(f"{BASE}/v1/assets/BTC")
        print(f"[unpaid] GET /v1/assets/BTC -> {r.status_code}")
        if r.status_code == 402:
            print("  payment-required:", r.headers.get("PAYMENT-REQUIRED") or r.text[:400])
        elif r.status_code == 200:
            print("  (dev mode: metering off, data returned unmetered)")

    # 2) Paid -> data, via the x402 client + a testnet signer
    pk = os.getenv("EVM_PRIVATE_KEY")
    if not pk:
        print("[paid] skipped - set EVM_PRIVATE_KEY (Base Sepolia test wallet) to run the full loop")
        return
    try:
        from eth_account import Account
        from x402.clients.httpx import x402HttpxClient  # client transport

        account = Account.from_key(pk)
        async with x402HttpxClient(account=account, base_url=BASE) as client:
            resp = await client.get("/v1/assets/BTC")
            body = await resp.aread()
            print(f"[paid] GET /v1/assets/BTC -> {resp.status_code}")
            print("  settlement:", resp.headers.get("X-PAYMENT-RESPONSE", "(see facilitator)"))
            print("  body:", body[:400])
    except Exception as exc:
        print(f"[paid] client import/run differs in your x402 version - verify: {exc}")


if __name__ == "__main__":
    asyncio.run(main())
