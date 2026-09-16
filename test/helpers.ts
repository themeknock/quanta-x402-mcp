/**
 * Test scaffolding: a schema, a stub facilitator, and a payment the SDK accepts.
 *
 * The stub facilitator is the important one. Every test that proves "metering is
 * ON" has to get past real SDK verification, and the real facilitator is a
 * network call against a testnet. So the suite injects a FacilitatorClient that
 * answers the three questions the SDK asks - what do you support, is this
 * payment valid, did it settle - and records what it was asked. Nothing here
 * weakens the code path under test: `verifyPayment` and `settlePayment` still
 * run, the requirements are still built by the SDK, and a payload that does not
 * match a real requirement is still refused.
 */

import { env } from "cloudflare:test";
import type { FacilitatorClient } from "@x402/core/http";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import { settingsFrom, type Env } from "../src/config";
import { EVM_NETWORK, paymentRequirements, setFacilitatorClient } from "../src/x402";

export const TEST_ENV = env as unknown as Env;
export const settings = () => settingsFrom(TEST_ENV);

/** Every table, from schema.sql, so the tests run against the shipped schema. */
export async function applySchema(): Promise<void> {
  const sql = (await import("../schema.sql?raw")).default as string;
  const statements = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await TEST_ENV.DB.prepare(statement).run();
  }
}

export async function resetDb(): Promise<void> {
  await applySchema();
  for (const table of ["usage_log", "idempotency", "rate_bucket"]) {
    await TEST_ENV.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

export interface StubFacilitator extends FacilitatorClient {
  verifyCalls: number;
  settleCalls: number;
  /** Set to make verification fail the way the real facilitator would. */
  rejectWith: string | null;
}

export function installStubFacilitator(): StubFacilitator {
  const stub: StubFacilitator = {
    verifyCalls: 0,
    settleCalls: 0,
    rejectWith: null,

    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: EVM_NETWORK }],
        extensions: [],
        signers: {},
      };
    },

    async verify(payload: PaymentPayload) {
      stub.verifyCalls += 1;
      if (stub.rejectWith) {
        return { isValid: false, invalidReason: stub.rejectWith, invalidMessage: "stub refused" };
      }
      return { isValid: true, payer: payerFromPayload(payload) };
    },

    async settle(payload: PaymentPayload, requirements: PaymentRequirements) {
      stub.settleCalls += 1;
      return {
        success: true,
        transaction: "0xstubtx",
        network: requirements.network,
        payer: payerFromPayload(payload),
      };
    },
  };

  setFacilitatorClient(stub);
  return stub;
}

function payerFromPayload(payload: PaymentPayload): string {
  const auth = (payload.payload as { authorization?: { from?: string } })?.authorization;
  return auth?.from ?? "";
}

export const PAYER = "0x1111111111111111111111111111111111111111";

/**
 * A payment header the SDK will match and verify.
 *
 * `accepted` is a copy of a requirement the SDK itself built, because that is
 * exactly what `findMatchingRequirements` compares against - a hand-typed
 * requirement would be refused, which is the point of the matcher.
 */
export async function paymentHeader(
  opts: { payer?: string; nonce?: string } = {},
): Promise<string> {
  const [requirement] = await paymentRequirements(settings());
  if (!requirement) throw new Error("no payment requirements built - is the stub installed?");

  const now = Math.floor(Date.now() / 1000);
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: requirement,
    payload: {
      signature: `0x${"ab".repeat(32)}`,
      authorization: {
        from: opts.payer ?? PAYER,
        to: requirement.payTo,
        value: requirement.amount,
        validAfter: String(now - 60),
        validBefore: String(now + 600),
        nonce: opts.nonce ?? `0x${crypto.randomUUID().replace(/-/g, "")}`,
      },
    },
  };
  return encodePaymentSignatureHeader(payload);
}

// ---------------------------------------------------------------------------
// The network, faked
// ---------------------------------------------------------------------------
/**
 * No test touches the real internet.
 *
 * Quanta makes two kinds of outbound call: a DNS-over-HTTPS lookup (the SSRF
 * guard - Workers has no DNS resolver) and the fetch of the target itself. Both
 * go through the global `fetch`, so the suite replaces it with a router: a test
 * declares "this URL answers 403 with these headers" and gets exactly that,
 * every run, with nobody's uptime involved.
 *
 * An unregistered URL throws. A test that silently reaches the real internet is
 * a test that passes for the wrong reason, so it is made to fail instead.
 */

export interface FakeRoute {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** Fail the fetch the way the runtime does, e.g. "SSL handshake failure". */
  throws?: string;
  delayMs?: number;
}

export class FakeNetwork {
  private readonly real = globalThis.fetch;
  private readonly routes = new Map<string, FakeRoute>();
  /** host -> the addresses DoH will answer with. */
  private readonly dns = new Map<string, string[]>();
  readonly requested: string[] = [];

  /** Answer DoH for `host` with `addresses`; the default is one public address. */
  resolves(host: string, addresses: string[] = ["93.184.216.34"]): this {
    this.dns.set(host.toLowerCase(), addresses);
    return this;
  }

  /** Answer `url` with a fixed response, and resolve its host while we are here. */
  serves(url: string, route: FakeRoute = {}): this {
    const parsed = new URL(url);
    this.routes.set(normalise(url), route);
    if (!this.dns.has(parsed.hostname.toLowerCase())) this.resolves(parsed.hostname);
    return this;
  }

  install(): this {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      this.handle(input, init)) as typeof fetch;
    return this;
  }

  restore(): void {
    globalThis.fetch = this.real;
  }

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    this.requested.push(url);

    if (url.startsWith(DOH_PREFIX)) return this.answerDns(url);

    const route = this.routes.get(normalise(url));
    if (!route) {
      throw new Error(`fake network: nothing registered for ${url}`);
    }
    if (route.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, route.delayMs));
      if (init?.signal?.aborted) throw new Error("The operation was aborted");
    }
    if (route.throws) throw new Error(route.throws);

    return new Response(route.body ?? "", {
      status: route.status ?? 200,
      headers: { "content-type": "text/html; charset=utf-8", ...(route.headers ?? {}) },
    });
  }

  private answerDns(url: string): Response {
    const query = new URL(url).searchParams;
    const name = (query.get("name") ?? "").toLowerCase();
    const type = query.get("type") === "AAAA" ? 28 : 1;
    const addresses = this.dns.get(name) ?? [];
    const answer = addresses
      .filter((address) => (address.includes(":") ? type === 28 : type === 1))
      .map((address) => ({ type, data: address }));
    return Response.json({ Status: answer.length ? 0 : 3, Answer: answer });
  }
}

const DOH_PREFIX = "https://cloudflare-dns.com/dns-query";

/** Trailing-slash differences must not decide whether a route matches. */
function normalise(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname === "/" ? "/" : parsed.pathname}${parsed.search}`;
}
