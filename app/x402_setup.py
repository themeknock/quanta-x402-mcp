"""x402 multi-chain (EVM + Solana) metering, wired with the official x402 SDK.

Design choices that matter for a take-over codebase:

* Import-safe. If the x402 wheel is missing (e.g. local dev on an unsupported
  Python), the app does not crash - it logs a warning and serves UNMETERED in
  dev mode. Metering is a feature flag, not a hard dependency at import time.
* Multi-chain. Each protected route advertises BOTH an EVM option (USDC on Base
  Sepolia, `eip155:84532`) and an SVM option (USDC on Solana devnet). The paying
  agent picks the rail it holds funds on.
* One facilitator handles verify + settle. Testnet uses the public x402.org
  facilitator (no keys). Mainnet swaps in Coinbase CDP via env, nothing else
  changes.
"""
from __future__ import annotations

import logging

from .config import settings

log = logging.getLogger("quanta.x402")

EVM_NETWORK = "eip155:84532"   # Base Sepolia testnet
SVM_NETWORK = "solana:devnet"  # Solana devnet


def build_middleware(protected_routes: dict[str, str]):
    """Return (middleware_class, kwargs) for the real x402 ASGI middleware, or
    (None, None) when metering is disabled or the SDK is unavailable."""
    if not settings.x402_enabled:
        log.warning("x402 disabled (X402_ENABLED=false) - serving UNMETERED (dev mode).")
        return None, None

    try:
        from x402.http import FacilitatorConfig, HTTPFacilitatorClient, PaymentOption
        from x402.http.middleware.fastapi import PaymentMiddlewareASGI
        from x402.http.types import RouteConfig
        from x402.mechanisms.evm.exact import ExactEvmServerScheme
        from x402.mechanisms.svm.exact import ExactSvmServerScheme
        from x402.server import x402ResourceServer
    except Exception as exc:  # wheel missing / unsupported Python
        log.warning("x402 SDK unavailable (%s) - serving UNMETERED (dev mode).", exc)
        return None, None

    facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=settings.x402_facilitator_url))
    server = x402ResourceServer(facilitator)
    server.register(EVM_NETWORK, ExactEvmServerScheme())
    if settings.x402_enable_svm:
        server.register(SVM_NETWORK, ExactSvmServerScheme())

    def _accepts():
        opts = [PaymentOption(scheme="exact", pay_to=settings.x402_evm_address,
                              price=settings.x402_price, network=EVM_NETWORK)]
        if settings.x402_enable_svm:
            opts.append(PaymentOption(scheme="exact", pay_to=settings.x402_svm_address,
                                      price=settings.x402_price, network=SVM_NETWORK))
        return opts

    routes: dict[str, RouteConfig] = {}
    for route_key, description in protected_routes.items():
        routes[route_key] = RouteConfig(
            accepts=_accepts(),
            mime_type="application/json",
            description=description,
        )

    rails = [EVM_NETWORK] + ([SVM_NETWORK] if settings.x402_enable_svm else [])
    log.info("x402 enabled: %d protected route(s), rails=%s, facilitator=%s",
             len(routes), rails, settings.x402_facilitator_url)
    return PaymentMiddlewareASGI, {"routes": routes, "server": server}
