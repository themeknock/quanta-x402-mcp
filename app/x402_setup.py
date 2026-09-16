"""x402 metering, wired with the official x402 SDK - ONE resource server.

Design choices that matter for a take-over codebase:

* One `x402ResourceServer` per process. The HTTP middleware and the MCP tool gate
  share it (`get_resource_server()`), so price, rails and payment requirements
  have a single source of truth. If the price changes it changes in both places
  or in neither.
* Import-safe. If the x402 wheel is missing (e.g. local dev on an unsupported
  Python), the app does not crash - it logs a warning and serves UNMETERED in
  dev mode. Metering is a feature flag, not a hard dependency at import time.
* Multi-chain. Each protected route advertises an EVM option (USDC on Base
  Sepolia, `eip155:84532`) and, when X402_ENABLE_SVM is on, an SVM option
  (USDC on Solana devnet). The public testnet facilitator settles EVM only, so
  the Solana rail stays off by default.
* One facilitator handles verify + settle. Testnet uses the public x402.org
  facilitator (no keys). Mainnet swaps in Coinbase CDP via env, nothing else
  changes.
"""
from __future__ import annotations

import logging
from typing import Any

from .config import settings

log = logging.getLogger("quanta.x402")

EVM_NETWORK = "eip155:84532"   # Base Sepolia testnet
SVM_NETWORK = "solana:devnet"  # Solana devnet

# The single resource server for this process (None = unmetered dev mode).
_server: Any = None
_server_built = False
# Tests inject a stub facilitator here so the suite never touches the network.
_facilitator_override: Any = None


def set_facilitator_client(client: Any) -> None:
    """Inject the facilitator client (tests use a stub). Must be called before
    the resource server is first built."""
    global _facilitator_override
    _facilitator_override = client
    reset_resource_server()


def reset_resource_server() -> None:
    """Drop the cached server so the next call rebuilds it (tests only)."""
    global _server, _server_built
    _server = None
    _server_built = False


def rails() -> list[str]:
    return [EVM_NETWORK] + ([SVM_NETWORK] if settings.x402_enable_svm else [])


def get_resource_server() -> Any:
    """The one x402ResourceServer. Returns None when metering is off or the SDK
    is unavailable (unmetered dev mode)."""
    global _server, _server_built
    if _server_built:
        return _server
    _server_built = True

    if not settings.x402_enabled:
        log.warning("x402 disabled (X402_ENABLED=false) - serving UNMETERED (dev mode).")
        return None

    try:
        from x402.http import FacilitatorConfig, HTTPFacilitatorClient
        from x402.mechanisms.evm.exact import ExactEvmServerScheme
        from x402.mechanisms.svm.exact import ExactSvmServerScheme
        from x402.server import x402ResourceServer
    except Exception as exc:  # wheel missing / unsupported Python
        log.warning("x402 SDK unavailable (%s) - serving UNMETERED (dev mode).", exc)
        return None

    client = _facilitator_override or HTTPFacilitatorClient(
        FacilitatorConfig(url=settings.x402_facilitator_url)
    )
    server = x402ResourceServer(client)
    server.register(EVM_NETWORK, ExactEvmServerScheme())
    if settings.x402_enable_svm:
        server.register(SVM_NETWORK, ExactSvmServerScheme())
    _server = server
    return _server


def resource_configs() -> list[Any]:
    """The ResourceConfig per enabled rail - what `build_payment_requirements`
    consumes. Same price and pay-to as the HTTP middleware advertises."""
    from x402.schemas import ResourceConfig

    configs = [ResourceConfig(scheme="exact", pay_to=settings.x402_evm_address,
                              price=settings.x402_price, network=EVM_NETWORK)]
    if settings.x402_enable_svm:
        configs.append(ResourceConfig(scheme="exact", pay_to=settings.x402_svm_address,
                                      price=settings.x402_price, network=SVM_NETWORK))
    return configs


def build_middleware(protected_routes: dict[str, str]):
    """Return (middleware_class, kwargs) for the real x402 ASGI middleware, or
    (None, None) when metering is disabled or the SDK is unavailable."""
    server = get_resource_server()
    if server is None:
        return None, None

    from x402.http import PaymentOption
    from x402.http.middleware.fastapi import PaymentMiddlewareASGI
    from x402.http.types import RouteConfig

    def _accepts() -> list[Any]:
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

    log.info("x402 enabled: %d protected route(s), rails=%s, facilitator=%s",
             len(routes), rails(), settings.x402_facilitator_url)
    return PaymentMiddlewareASGI, {"routes": routes, "server": server}
