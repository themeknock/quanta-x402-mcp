/**
 * The HTTP surface, end to end: the payment gate, the checks behind it, the
 * audit log, idempotency and the rate limit.
 *
 * These call the Hono app directly rather than over a socket so the SDK's
 * middleware, the D1 binding and the fake network are all in one isolate and one
 * stack trace.
 */

import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import goodHtml from "./fixtures/good.html?raw";
import brokenHtml from "./fixtures/broken.html?raw";
import app from "../src/index";
import {
  FakeNetwork,
  PAYER,
  TEST_ENV,
  installStubFacilitator,
  paymentHeader,
  resetDb,
  type StubFacilitator,
} from "./helpers";

let net: FakeNetwork;
let facilitator: StubFacilitator;

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(`https://quanta.test${path}`, init), TEST_ENV, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function paidCall(path: string, extra: Record<string, string> = {}): Promise<Response> {
  return call(path, { headers: { "payment-signature": await paymentHeader(), ...extra } });
}

async function usageRows(): Promise<Array<Record<string, unknown>>> {
  const { results } = await TEST_ENV.DB.prepare(
    "SELECT route, surface, target_host, payer, paid, idempotent_replay, tx_ref, payment_nonce FROM usage_log ORDER BY id",
  ).all<Record<string, unknown>>();
  return results ?? [];
}

beforeAll(() => {
  facilitator = installStubFacilitator();
});

beforeEach(async () => {
  await resetDb();
  facilitator.rejectWith = null;
  facilitator.verifyCalls = 0;
  facilitator.settleCalls = 0;
  net = new FakeNetwork().install();
});

afterEach(() => net.restore());

describe("free routes", () => {
  it("describes itself, and admits what it cannot do", async () => {
    const body = (await (await call("/")).json()) as Record<string, any>;
    expect(body.service).toBe("Quanta");
    expect(body.metered_via_x402).toBe(true);
    expect(body.rails).toContain("eip155:84532");
    expect(body.paid_routes).toEqual(["GET /v1/check", "GET /v1/https", "GET /v1/headers"]);
    expect(body.limits.renders_javascript).toBe(false);
    expect(body.limits.certificate_fields).toContain("not readable");
  });

  it("reports health from a real query, not a hard-coded true", async () => {
    const response = await call("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, db: true });
  });

  it("publishes a bot page naming the user agent it sends", async () => {
    const text = await (await call("/bot")).text();
    expect(text).toContain("QuantaCheck");
    expect(text).toContain("Disallow: /");
  });

  it("404s with the list of free routes rather than a bare error", async () => {
    const response = await call("/nope");
    expect(response.status).toBe(404);
    expect((await response.json() as any).free_routes).toContain("/demo");
  });
});

describe("the payment gate", () => {
  it("refuses an unpaid call with 402 and a priced challenge", async () => {
    const response = await call("/v1/check?url=https://example.com");
    expect(response.status).toBe(402);

    // x402 v2 carries the challenge in a header, not the body.
    const challenge = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED")!) as any;
    expect(challenge.accepts.length).toBeGreaterThan(0);
    expect(challenge.accepts[0].network).toBe("eip155:84532");
    expect(challenge.accepts[0].payTo).toBe("0x000000000000000000000000000000000000dEaD");
    expect(challenge.accepts[0].amount).toBe("1000"); // $0.001 in USDC atomic units
  });

  it("refuses a made-up payment header instead of serving the check", async () => {
    const response = await call("/v1/check?url=https://example.com", {
      headers: { "payment-signature": "bogus" },
    });
    expect(response.status).toBe(402);
    expect(JSON.stringify(await response.json())).not.toContain("verdict");
  });

  it("refuses a payment the facilitator rejects", async () => {
    facilitator.rejectWith = "insufficient_funds";
    net.serves("https://example.com/", { body: goodHtml });

    const response = await paidCall("/v1/check?url=https://example.com");
    expect(response.status).toBe(402);
    expect(facilitator.verifyCalls).toBeGreaterThan(0);
    expect(facilitator.settleCalls).toBe(0);
  });

  it("does not charge for a target it refused to fetch", async () => {
    net.resolves("internal.test", ["10.0.0.5"]);
    const before = facilitator.settleCalls;

    const response = await paidCall("/v1/check?url=https://internal.test/");
    expect(response.status).toBe(403);
    expect((await response.json() as any).reason).toBe("private_address");
    expect(facilitator.settleCalls).toBe(before);
  });
});

describe("a paid check", () => {
  it("verifies, settles, returns a verdict and stamps the audit row paid", async () => {
    net.serves("https://example.com/", {
      body: goodHtml,
      headers: {
        "strict-transport-security": "max-age=31536000",
        "content-security-policy": "default-src 'self'",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
      },
    });

    const response = await paidCall("/v1/check?url=https://example.com/");
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, any>;
    expect(body.verdict.score).toBe(100);
    expect(body.verdict.grade).toBe("A");
    expect(body.html.title.text).toBe("Northgate Home Services");
    expect(body._meta.metered).toBe(true);
    expect(body._meta.network).toBe("eip155:84532");

    expect(facilitator.verifyCalls).toBe(1);
    expect(facilitator.settleCalls).toBe(1);

    const [row] = await usageRows();
    expect(row!.route).toBe("/v1/check");
    expect(row!.paid).toBe(1);
    expect(row!.tx_ref).toBe("0xstubtx");
    expect(row!.target_host).toBe("example.com");
    expect(row!.payer).toBe(PAYER); // a public chain address, from the verified payload
  });

  it("finds the real faults on a real-looking bad page", async () => {
    net.serves("https://broken.test/", { body: brokenHtml });

    const body = (await (await paidCall("/v1/check?url=https://broken.test/")).json()) as any;
    const codes = body.verdict.issues.map((i: { code: string }) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "NO_TITLE_IN_RAW_HTML",
        "NO_VIEWPORT_IN_RAW_HTML",
        "MIXED_CONTENT",
        "NO_HSTS",
        "NO_CSP",
      ]),
    );
    expect(body.verdict.grade).toBe("F");
  });

  it("calls a 403 bot protection rather than declaring the site broken", async () => {
    net.serves("https://guarded.test/", { status: 403, body: "<html><title>no</title></html>" });

    const body = (await (await paidCall("/v1/check?url=https://guarded.test/")).json()) as any;
    const codes = body.verdict.issues.map((i: { code: string }) => i.code);
    expect(codes).toContain("BOT_PROTECTION_SUSPECTED");
    expect(codes).not.toContain("HTTP_ERROR_STATUS");
  });

  it("re-runs the SSRF guard on a redirect instead of following it blindly", async () => {
    net
      .serves("https://redirector.test/", { status: 302, headers: { location: "http://10.0.0.5/" } })
      .resolves("10.0.0.5", ["10.0.0.5"]);

    const response = await paidCall("/v1/check?url=https://redirector.test/");
    expect(response.status).toBe(403);
    expect((await response.json() as any).reason).toBe("private_address");
  });

  it("serves /v1/headers without a body verdict", async () => {
    net.serves("https://example.com/", { body: goodHtml, headers: { "x-frame-options": "DENY" } });

    const body = (await (await paidCall("/v1/headers?url=https://example.com/")).json()) as any;
    expect(body.headers.x_frame_options).toBe(true);
    expect(body.verdict).toBeUndefined();
  });

  it("serves /v1/https with the honest certificate caveat", async () => {
    net
      .serves("https://example.com/", { body: goodHtml })
      .serves("http://example.com/", { status: 301, headers: { location: "https://example.com/" } });

    const body = (await (await paidCall("/v1/https?host=example.com")).json()) as any;
    expect(body.https.verified).toBe(true);
    expect(body.https.note).toContain("expiry and issuer are not readable");
    expect(body.https.upgrades_from_http).toBe("redirects_to_https");
  });
});

describe("idempotency", () => {
  it("replays the stored body instead of re-fetching the target", async () => {
    net.serves("https://example.com/", { body: goodHtml });
    const key = { "Idempotency-Key": "abc-123" };

    const first = (await (await paidCall("/v1/check?url=https://example.com/", key)).json()) as any;
    const fetchesAfterFirst = net.requested.filter((u) => u === "https://example.com/").length;

    const second = (await (await paidCall("/v1/check?url=https://example.com/", key)).json()) as any;
    expect(second.verdict).toEqual(first.verdict);
    expect(second._meta.idempotent_replay).toBe(true);
    expect(net.requested.filter((u) => u === "https://example.com/").length).toBe(fetchesAfterFirst);

    const rows = await usageRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.idempotent_replay).toBe(1);
  });

  it("409s when the same key is reused for a different URL", async () => {
    net.serves("https://example.com/", { body: goodHtml }).serves("https://other.test/", { body: goodHtml });
    const key = { "Idempotency-Key": "abc-123" };

    expect((await paidCall("/v1/check?url=https://example.com/", key)).status).toBe(200);
    const response = await paidCall("/v1/check?url=https://other.test/", key);
    expect(response.status).toBe(409);
    expect((await response.json() as any).error).toBe("idempotency_key_reused_with_different_request");
  });
});

describe("rate limiting", () => {
  it("refuses over-limit callers before their money moves", async () => {
    net.serves("https://example.com/", { body: goodHtml });

    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await paidCall("/v1/check?url=https://example.com/")).status);
    }

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]); // RATE_CAPACITY = 3 in tests
    expect(statuses.slice(3)).toEqual([429, 429]);
    // Three calls did the work and settled; the two refusals did not.
    expect(facilitator.settleCalls).toBe(3);
  });

  it("scopes the bucket to the payer, so one agent cannot spend another's", async () => {
    net.serves("https://example.com/", { body: goodHtml });
    for (let i = 0; i < 4; i += 1) await paidCall("/v1/check?url=https://example.com/");

    const other = await paymentHeader({ payer: "0x2222222222222222222222222222222222222222" });
    const response = await call("/v1/check?url=https://example.com/", {
      headers: { "payment-signature": other },
    });
    expect(response.status).toBe(200);
  });
});

describe("the free demo", () => {
  it("checks a host we own, free and unmetered", async () => {
    net.serves("https://themeknock.net/", { body: goodHtml });

    const response = await call("/demo");
    expect(response.status).toBe(200);

    const body = (await response.json()) as any;
    expect(body.target.host).toBe("themeknock.net");
    expect(body._meta.free_demo).toBe(true);
    expect(body._meta.metered).toBe(false);
    expect(facilitator.settleCalls).toBe(0);
  });

  it("cannot be pointed at someone else's site", async () => {
    const response = await call("/demo?url=https://not-ours.test/");
    expect(response.status).toBe(403);
    expect((await response.json() as any).error).toBe("demo_host_not_allowed");
  });
});

describe("the audit log", () => {
  it("stores the host, never the full URL - a query string can carry a token", async () => {
    net.serves("https://example.com/?token=secret-value", { body: goodHtml });
    await paidCall("/v1/check?url=" + encodeURIComponent("https://example.com/?token=secret-value"));

    const dump = JSON.stringify(await usageRows());
    expect(dump).toContain("example.com");
    expect(dump).not.toContain("secret-value");
  });

  it("never hands a full payer address back out of /internal/usage", async () => {
    net.serves("https://example.com/", { body: goodHtml });
    await paidCall("/v1/check?url=https://example.com/");

    const body = await (await call("/internal/usage")).text();
    expect(body).toContain("0x1111...1111");
    expect(body).not.toContain(PAYER);
  });
});
