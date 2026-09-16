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

    # ---- Website checks ---------------------------------------------------
    check_timeout_s: float = 10.0
    check_max_bytes: int = 2_097_152        # 2 MB
    check_max_redirects: int = 5
    # /demo is free and unmetered, so it may only point at hosts we chose.
    demo_allowlist: str = "themeknock.net,example.com"

    # Public origin of this deployment (used for MCP host validation).
    public_base_url: str = "http://localhost:4021"
    # Extra Host header values the MCP endpoint accepts, comma separated.
    # DNS-rebinding protection is on, so every hostname that reaches us must be
    # listed (Fly's *.fly.dev name, for instance).
    mcp_extra_hosts: str = ""

    # Per-payer token bucket (the payment address is the principal).
    rate_capacity: int = 60
    rate_refill_per_s: float = 1.0

    app_env: str = "dev"
    port: int = 4021


    def demo_hosts(self) -> list[str]:
        return [h.strip().lower() for h in self.demo_allowlist.split(",") if h.strip()]

    def mcp_allowed_hosts(self) -> list[str]:
        from urllib.parse import urlparse

        hosts = ["localhost", "localhost:*", "127.0.0.1", "127.0.0.1:*"]
        public = urlparse(self.public_base_url).netloc
        if public:
            hosts += [public, public.split(":")[0] + ":*"]
        hosts += [h.strip() for h in self.mcp_extra_hosts.split(",") if h.strip()]
        return sorted(set(hosts))


settings = Settings()
