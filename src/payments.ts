/**
 * Real x402 payment verification for the MCP surface.
 *
 * Why this file exists: the HTTP side is gated by the SDK's Hono middleware,
 * which decodes the payment header, verifies it with the facilitator, runs the
 * handler, then settles. MCP has no middleware - the payment arrives as a tool
 * argument. The first version of this service gated MCP tools with
 * `if (!payment)`, which is a presence check: `payment="x"` got the data for
 * free. This module does the real thing, through the SAME x402ResourceServer the
 * middleware uses, so price, rails and requirements cannot drift between the two
 * surfaces.
 *
 * Order of operations, deliberately matching the middleware:
 *     decode -> find matching requirements -> verify (facilitator)
 *     -> [caller runs rate limit / the tool] -> settle (facilitator)
 *
 * Verification and settlement are two steps for a reason: a caller who is over
 * the rate limit is refused *before* their money moves.
 */

import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import type { Settings } from "./config";
import { paymentRequirements, readyServer } from "./x402";

export interface PaymentRefusal {
  ok: false;
  reason: string;
  message?: string;
}

export interface VerifiedPayment {
  ok: true;
  payer: string;
  network: string;
  amount: string;
  nonce: string;
  settle: () => Promise<{ settled: boolean; txRef: string }>;
}

export type PaymentOutcome = VerifiedPayment | PaymentRefusal;

export function refusalBody(refusal: PaymentRefusal): Record<string, unknown> {
  const body: Record<string, unknown> = { x402: "payment_invalid", reason: refusal.reason };
  if (refusal.message) body.message = refusal.message;
  return body;
}

/**
 * Decode the payment header the middleware has ALREADY verified.
 *
 * The Hono middleware does not hand the verified payload down to the handler, so
 * the route decodes the same header again - only to read the payer address and
 * the nonce. This is not a second trust decision: by the time a handler runs, the
 * middleware has verified that header with the facilitator, and a request that
 * failed verification never reaches here.
 */
export function decodeVerifiedHeader(header: string | undefined | null): PaymentPayload | null {
  if (!header) return null;
  try {
    return decodePaymentSignatureHeader(header) as PaymentPayload;
  } catch {
    return null;
  }
}

/** The nonce is the only id the route and the settlement stamp can both see. */
export function nonceOf(payload: PaymentPayload | undefined | null): string {
  const inner = (payload as { payload?: Record<string, unknown> } | null)?.payload;
  const auth = (inner as { authorization?: Record<string, unknown> } | undefined)?.authorization;
  return String(auth?.nonce ?? "");
}

export function payerOf(payload: PaymentPayload | undefined | null): string {
  const inner = (payload as { payload?: Record<string, unknown> } | null)?.payload;
  const auth = (inner as { authorization?: Record<string, unknown> } | undefined)?.authorization;
  return String(auth?.from ?? "");
}

/**
 * The x402 challenge an unpaid MCP tool call gets back.
 *
 * Same `accepts[]` the HTTP 402 carries, because it is built from the same server
 * instance and the same ResourceConfig.
 */
export async function mcpChallenge(
  settings: Settings,
  description: string,
  resource: string,
): Promise<Record<string, unknown>> {
  let requirements: PaymentRequirements[];
  try {
    requirements = await paymentRequirements(settings);
  } catch (error) {
    return {
      x402: "facilitator_unavailable",
      reason: String((error as Error)?.message ?? error),
      hint: "The payment facilitator is unreachable, so this tool cannot be priced right now.",
    };
  }
  return {
    x402: "payment_required",
    x402Version: 2,
    resource,
    description,
    accepts: requirements,
    hint: "Pay with an x402 client, then call this tool again with payment=<base64 payment payload>.",
  };
}

/**
 * Decode and verify a payment payload handed to an MCP tool.
 *
 * Returns a VerifiedPayment (the caller must call `.settle()` after the tool
 * succeeds) or a PaymentRefusal. Never throws on caller input.
 */
export async function verifyMcpPayment(
  settings: Settings,
  paymentB64: string,
  routeKey: string,
): Promise<PaymentOutcome> {
  let server: x402ResourceServer | null;
  try {
    server = await readyServer(settings);
  } catch (error) {
    return { ok: false, reason: "facilitator_unavailable", message: String((error as Error)?.message ?? error) };
  }

  if (!server) {
    // Unmetered dev mode: there is nothing to verify against. Refuse rather than
    // pretend a payment was checked.
    return {
      ok: false,
      reason: "metering_disabled",
      message: "This instance runs unmetered (X402_ENABLED=false); payments are not accepted.",
    };
  }

  // 1. decode - exactly the way the SDK middleware decodes the PAYMENT-SIGNATURE header.
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(paymentB64) as PaymentPayload;
  } catch (error) {
    return { ok: false, reason: "malformed_payment_payload", message: String((error as Error)?.message ?? error) };
  }

  // 2. does the payload match something we actually sell?
  let available: PaymentRequirements[];
  try {
    available = await paymentRequirements(settings);
  } catch (error) {
    return { ok: false, reason: "facilitator_unavailable", message: String((error as Error)?.message ?? error) };
  }
  const requirements = server.findMatchingRequirements(available, payload);
  if (!requirements) {
    return {
      ok: false,
      reason: "no_matching_requirements",
      message: `payload does not match any accepted rail/price for ${routeKey}`,
    };
  }

  // 3. verify with the facilitator. Presence is not proof; this is.
  let verified: { isValid: boolean; invalidReason?: string; invalidMessage?: string; payer?: string };
  try {
    verified = (await server.verifyPayment(payload, requirements)) as typeof verified;
  } catch (error) {
    return { ok: false, reason: "verify_error", message: String((error as Error)?.message ?? error) };
  }
  if (!verified.isValid) {
    return {
      ok: false,
      reason: verified.invalidReason ?? "invalid_payment",
      ...(verified.invalidMessage ? { message: verified.invalidMessage } : {}),
    };
  }

  let payer = verified.payer ?? payerOf(payload);

  return {
    ok: true,
    payer,
    network: String(requirements.network),
    amount: settings.price,
    nonce: nonceOf(payload),
    settle: async () => {
      try {
        const result = await server.settlePayment(payload, requirements);
        if (!result.success) {
          return { settled: false, txRef: result.errorReason ?? "settle_failed" };
        }
        if (result.payer) payer = result.payer;
        return { settled: true, txRef: result.transaction ?? "" };
      } catch (error) {
        return { settled: false, txRef: `settle_error:${String((error as Error)?.message ?? error)}` };
      }
    },
  };
}
