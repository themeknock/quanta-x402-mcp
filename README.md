# Quanta

**Pay-per-call structured data for autonomous AI agents.** x402-metered, MCP-native.

A small, real reference service: a FastAPI API serves a structured dataset, every
data call is metered by the **x402** protocol (a USDC micropayment on **Base** or
**Solana**), and the same data is exposed as **MCP** tools so an agent can discover
and call it natively. Backed by **Postgres/Supabase** (SQLite locally).

This is a working slice of the agent-commerce stack: `agent -> MCP tool -> x402 paywall -> data`.

---

## Why it exists

It's the exact shape of the systems I build for: a live API that sells structured
data to autonomous agents, monetized per call, with an MCP front door. It runs the
real protocols (official x402 SDK + official MCP SDK), not a mock.

---

## Architecture

```
                      ┌──────────────────────────────────────────┐
   AI agent  ───────▶ │  MCP tools (FastMCP)   /mcp              │
   (Claude, etc.)     │    list_assets · get_asset · get_signal  │
                      └───────────────┬──────────────────────────┘
                                      │  same data layer
   HTTP client ─────▶ ┌──────────────▼──────────────────────────┐
   (curl, SDK)        │  FastAPI  /v1/*   ── x402 middleware ────┤
                      │    402 challenge ▶ verify ▶ settle ▶ data │
                      └───────────────┬──────────────────────────┘
                                      │
                      ┌───────────────▼──────────────┐   ┌──────────────────┐
                      │  data.py (single source)      │   │  x402 facilitator │
                      │  assets + usage_log           │   │  verify + settle  │
                      └───────────────┬──────────────┘   │  Base / Solana    │
                                      │                   └──────────────────┘
                      ┌───────────────▼──────────────┐
                      │  Postgres / Supabase (SQLite) │
                      └───────────────────────────────┘
```

**The x402 request loop**

1. Agent calls a `/v1/*` route with no payment.
2. Server replies `402 Payment Required` + the accepted rails (USDC on Base Sepolia
   *and* Solana devnet), price, and pay-to address.
3. Agent signs a payment and retries with an `X-PAYMENT` proof.
4. The facilitator **verifies + settles** on-chain; the server returns the data and
   writes a row to `usage_log` (who paid, which chain, which record).

Metering is a **feature flag**. If the x402 wheel isn't present (local dev on an
unsupported Python), the app logs a warning and serves unmetered so you can still
work on everything else. It never fails to boot.

## Layout

```
app/
  main.py        FastAPI app, /v1/* data routes, x402 wired in
  x402_setup.py  multi-chain (EVM + Solana) metering, import-safe
  data.py        seed data + shared queries + usage log (one source of truth)
  models.py      Asset + UsageLog (SQLAlchemy 2.0 async)
  db.py          async engine; DATABASE_URL swaps SQLite <-> Supabase
  config.py      typed settings
mcp_server/
  server.py      FastMCP tools (x402-gated per tool), stdio or HTTP
client/
  pay_and_fetch.py  agent demo: unpaid -> 402, then paid -> data
scripts/seed.py  create tables + load sample data
tests/test_api.py
Dockerfile · railway.json
```

## Run it locally

```bash
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # defaults to SQLite + testnet
python -m scripts.seed
uvicorn app.main:app --port 4021
```

Prove the metering is live:

```bash
curl -i http://localhost:4021/v1/assets/BTC      # -> 402 Payment Required + rails
curl    http://localhost:4021/internal/usage     # -> audit trail (free)
python -m client.pay_and_fetch                   # unpaid 402, then paid loop
```

MCP (stdio, for Claude Desktop / MCP Inspector):

```bash
python -m mcp_server.server
```

## Deploy

- **Railway / Cloud Run / Render:** Docker build (Python 3.12). `railway.json` is included; health check is `/health`.
- **Database:** set `DATABASE_URL` to your Supabase Postgres string (`postgresql+asyncpg://...`).
- **Payments:** testnet works with the public `x402.org` facilitator and no keys. For mainnet settlement, set `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` (Coinbase CDP) and switch the network.

## Honest scope

- The dataset is a **clearly-labelled sample snapshot**, not a live market feed - enough to prove the pay-per-call mechanics end to end.
- Settlement runs on **testnet** (Base Sepolia / Solana devnet). Flipping to mainnet is config, not code.
- The full paid loop in `client/pay_and_fetch.py` needs a funded test wallet; the unpaid `402` proves the contract without one.

## Stack

FastAPI · SQLAlchemy 2.0 (async) · Postgres/Supabase · official **x402** SDK (EVM + SVM) · official **MCP** SDK (FastMCP) · Docker.
