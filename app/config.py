"""Typed settings, loaded from environment / .env (pydantic-settings)."""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Database: SQLite locally, Supabase/Postgres in prod.
    database_url: str = "sqlite+aiosqlite:///./quanta.db"

    # x402 metering
    x402_enabled: bool = True
    x402_facilitator_url: str = "https://www.x402.org/facilitator"
    x402_evm_address: str = "0x0000000000000000000000000000000000000000"
    # Solana rail: off by default because the public testnet facilitator settles
    # EVM only. Turn on with a Solana-capable facilitator (or Coinbase CDP).
    x402_enable_svm: bool = False
    x402_svm_address: str = "11111111111111111111111111111111"
    x402_price: str = "$0.001"
    cdp_api_key_id: str | None = None
    cdp_api_key_secret: str | None = None

    app_env: str = "dev"
    port: int = 4021


settings = Settings()
