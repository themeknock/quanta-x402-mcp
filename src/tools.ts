/**
 * The three MCP tools, and the gate every one of them goes through.
 *
 * x402-over-MCP, done properly. MCP has no middleware to gate tools, so the
 * payment arrives as a tool argument. Every paid tool runs the same four steps:
 *
 *   1. no payment      -> return the x402 challenge (built by the SDK from the
 *                         SAME resource server the HTTP middleware uses)
 *   2. payment present -> VERIFY it with the facilitator (src/payments.ts).
 *                         Presence is not proof. A bogus string is refused.
 *   3. verified        -> per-payer rate limit, then run the check
 *   4. check ran       -> SETTLE, then write the audit row
 */

import type { Env, Settings } from "./config";
import { hostOf, runCheck, runHeaders, runHttps } from "./checks/verdict";
import { mcpChallenge, refusalBody, verifyMcpPayment, type VerifiedPayment } from "./payments";
import { take } from "./ratelimit";
import { bodyHash, logUsage } from "./usage";

export const TOOL_DEFINITIONS = [
  {
    name: "check_url",
    description:
      "Check one website: is it reachable, does its certificate verify, does it send the security headers, and what does its raw HTML say. Costs one x402 payment. JavaScript is NOT rendered, so html.checked is always \"raw_html_only\".",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to check." },
        payment: { type: "string", description: "Base64 x402 payment payload. Omit to get the price." },
      },
      required: ["url"],
    },
  },
  {
    name: "check_https",
    description:
      "HTTPS posture for one hostname: does the certificate verify the way a browser judges it, does http:// redirect to https://, is HSTS set. Certificate expiry and issuer are not reported - the runtime exposes no certificate object.",
    inputSchema: {
      type: "object" as const,
      properties: {
        host: { type: "string", description: "Hostname only, no scheme or path." },
        payment: { type: "string", description: "Base64 x402 payment payload. Omit to get the price." },
      },
      required: ["host"],
    },
  },
  {
    name: "check_headers",
    description:
      "Status, timings and the four security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options) for one URL.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to check." },
        payment: { type: "string", description: "Base64 x402 payment payload. Omit to get the price." },
      },
      required: ["url"],
    },
  },
];

const DESCRIPTIONS: Record<string, string> = {
  check_url: "Full check of one URL: reachability, HTTPS, security headers, raw-HTML basics.",
  check_https: "HTTPS posture for one host: verified certificate, http->https upgrade, HSTS.",
  check_headers: "Status, timings and the four security headers for one URL.",
};

type Gate =
  | { kind: "refused"; body: Record<string, unknown> }
  | { kind: "verified"; payment: VerifiedPayment };

async function gate(
  tool: string,
  payment: string | undefined,
  env: Env,
  settings: Settings,
): Promise<Gate> {
  if (!payment) {
    return {
      kind: "refused",
      body: await mcpChallenge(settings, DESCRIPTIONS[tool] ?? tool, `mcp://quanta/${tool}`),
    };
  }

  const verified = await verifyMcpPayment(settings, payment, DESCRIPTIONS[tool] ?? tool);
  if (!verified.ok) return { kind: "refused", body: refusalBody(verified) };

  const limit = await take(env.DB, verified.payer, {
    capacity: settings.rateCapacity,
    refillPerS: settings.rateRefillPerS,
  });
  if (!limit.allowed) {
    // Refused before settlement: over-limit callers do not pay.
    return { kind: "refused", body: { error: "rate_limited", retry_after_s: limit.retryAfterS } };
  }

  return { kind: "verified", payment: verified };
}

async function finish(
  tool: string,
  payment: VerifiedPayment,
  body: Record<string, unknown>,
  startedAt: number,
  targetHost: string,
  env: Env,
): Promise<Record<string, unknown>> {
  const { settled, txRef } = await payment.settle();
  const durationMs = Date.now() - startedAt;

  await logUsage(env.DB, {
    surface: "mcp",
    route: tool,
    targetHost,
    network: payment.network,
    payer: payment.payer,
    amount: payment.amount,
    txRef: settled ? txRef : "",
    paid: settled,
    durationMs,
    verdictHash: await bodyHash(body),
  });

  if (!settled) return { x402: "settlement_failed", reason: txRef };

  const existing = (body._meta ?? {}) as Record<string, unknown>;
  body._meta = {
    ...existing,
    metered: true,
    network: payment.network,
    amount: payment.amount,
    tx_ref: txRef,
    duration_ms: durationMs,
  };
  return body;
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  settings: Settings,
): Promise<Record<string, unknown>> {
  if (!DESCRIPTIONS[name]) return { error: `unknown tool '${name}'` };

  const startedAt = Date.now();
  const payment = typeof args.payment === "string" ? args.payment : undefined;
  const checked = await gate(name, payment, env, settings);
  if (checked.kind === "refused") return checked.body;

  const opts = { settings, metered: true, network: checked.payment.network };

  if (name === "check_https") {
    const host = String(args.host ?? "");
    const result = await runHttps(host, opts);
    return finish(name, checked.payment, result.body, startedAt, host, env);
  }

  const url = String(args.url ?? "");
  const result = name === "check_url" ? await runCheck(url, opts) : await runHeaders(url, opts);
  return finish(name, checked.payment, result.body, startedAt, hostOf(url), env);
}
