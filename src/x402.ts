/**
 * x402 metering, wired with the official SDK - ONE resource server.
 *
 * Design choices that matter for a take-over codebase:
 *
 * * One `x402ResourceServer` per isolate. The HTTP middleware and the MCP tool
 *   gate share it, so price, rails and payment requirements have a single source
 *   of truth. If the price changes it changes in both places or in neither.
 * * Built lazily from `env`, because a Worker has no environment at module load.
 *   The instance is cached for the life of the isolate, and `initialize()` (one
 *   blocking call to the facilitator asking which scheme/network pairs it
 *   supports) is cached as a promise so concurrent requests wait on one fetch.
 * * Multi-chain. Each protected route advertises an EVM option (USDC on Base
 *   Sepolia, `eip155:84532`) and, when X402_ENABLE_SVM is on, an SVM option. The
 *   public testnet facilitator settles EVM only, so the Solana rail stays off.
 * * Metering is a feature flag. `X402_ENABLED=false` serves unmetered with a loud
 *   warning, which is the only way to run the checks locally without a wallet.
 */

import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/http";
import { x402ResourceServer, type ResourceConfig } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";

import type { Settings } from "./config";

export const EVM_NETWORK = "eip155:84532"; // Base Sepolia testnet
export const SVM_NETWORK = "solana:devnet";

let cached: x402ResourceServer | null = null;
let initPromise: Promise<void> | null = null;
/** Tests inject a stub facilitator here so the suite never touches the network. */
let facilitatorOverride: FacilitatorClient | null = null;

export function setFacilitatorClient(client: FacilitatorClient | null): void {
  facilitatorOverride = client;
  resetResourceServer();
}

export function resetResourceServer(): void {
  cached = null;
  initPromise = null;
}

export function rails(settings: Settings): string[] {
  return settings.enableSvm ? [EVM_NETWORK, SVM_NETWORK] : [EVM_NETWORK];
}

/** The one x402ResourceServer. `null` when metering is off (unmetered dev mode). */
export function getResourceServer(settings: Settings): x402ResourceServer | null {
  if (!settings.x402Enabled) return null;
  if (cached) return cached;

  const facilitator =
    facilitatorOverride ??
    new HTTPFacilitatorClient({ url: settings.facilitatorUrl });

  const server = new x402ResourceServer(facilitator).register(EVM_NETWORK, new ExactEvmScheme());
  if (settings.enableSvm) server.register(SVM_NETWORK, new ExactEvmScheme());

  cached = server;
  return server;
}

/** `initialize()` once per isolate; concurrent callers share the same promise. */
export async function readyServer(settings: Settings): Promise<x402ResourceServer | null> {
  const server = getResourceServer(settings);
  if (!server) return null;
  if (!initPromise) {
    initPromise = server.initialize().catch((error: unknown) => {
      initPromise = null; // a failed init must not poison the isolate forever
      throw error;
    });
  }
  await initPromise;
  return server;
}

/** The ResourceConfig per enabled rail - what `buildPaymentRequirements` consumes. */
export function resourceConfigs(settings: Settings): ResourceConfig[] {
  const configs: ResourceConfig[] = [
    {
      scheme: "exact",
      payTo: settings.evmAddress,
      price: settings.price,
      network: EVM_NETWORK,
    },
  ];
  if (settings.enableSvm) {
    configs.push({
      scheme: "exact",
      payTo: settings.svmAddress,
      price: settings.price,
      network: SVM_NETWORK,
    });
  }
  return configs;
}

/** The accepted payment requirements, one per enabled rail, built by the SDK. */
export async function paymentRequirements(settings: Settings): Promise<PaymentRequirements[]> {
  const server = await readyServer(settings);
  if (!server) return [];
  const out: PaymentRequirements[] = [];
  for (const config of resourceConfigs(settings)) {
    out.push(...(await server.buildPaymentRequirements(config)));
  }
  return out;
}

/** Payment options in the shape the Hono middleware's RoutesConfig wants. */
export function paymentOptions(settings: Settings) {
  const options = [
    { scheme: "exact", payTo: settings.evmAddress, price: settings.price, network: EVM_NETWORK },
  ];
  if (settings.enableSvm) {
    options.push({
      scheme: "exact",
      payTo: settings.svmAddress,
      price: settings.price,
      network: SVM_NETWORK,
    });
  }
  return options;
}
