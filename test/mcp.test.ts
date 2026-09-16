/**
 * The MCP surface, and the gate in front of it.
 *
 * This is the file that matters most. MCP has no middleware to hang a payment
 * check on, so the payment arrives as a tool argument - and the easy version of
 * that, `if (!payment)`, is a presence check that hands the data to anyone who
 * types a word. The tests below assert the opposite: `payment="bogus"` is
 * refused, the facilitator is actually asked, and nothing that looks like a
 * verdict comes back to an unpaid caller.
 */

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import goodHtml from "./fixtures/good.html?raw";
import app from "../src/index";
import {
  FakeNetwork,
  TEST_ENV,
  installStubFacilitator,
  paymentHeader,
  resetDb,
  type StubFacilitator,
} from "./helpers";

let net: FakeNetwork;
let facilitator: StubFacilitator;

async function rpc(body: unknown, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request("https://quanta.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
      ...init,
    }),
    TEST_ENV,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

let id = 0;
async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  id += 1;
  const response = await rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  expect(response.status).toBe(200);
  const envelope = (await response.json()) as any;
  const text = envelope.result?.content?.[0]?.text;
  expect(text, JSON.stringify(envelope)).toBeTypeOf("string");
  return JSON.parse(text);
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

describe("the protocol", () => {
  it("initializes on a protocol version the SDK supports", async () => {
    const response = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    const body = (await response.json()) as any;
    expect(body.result.serverInfo.name).toBe("Quanta");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("lists exactly the three tools", async () => {
    const body = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as any;
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "check_url",
      "check_https",
      "check_headers",
    ]);
  });

  it("says in the tool description that JavaScript is not rendered", async () => {
    const body = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as any;
    const checkUrl = body.result.tools.find((t: { name: string }) => t.name === "check_url");
    expect(checkUrl.description).toContain("JavaScript is NOT rendered");
  });

  it("answers an unknown method with a JSON-RPC error, not a crash", async () => {
    const body = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "no/such/method" })).json()) as any;
    expect(body.error.code).toBe(-32601);
  });

  it("accepts a notification with 202 and no body", async () => {
    const response = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
  });

  it("refuses GET on /mcp, because this server keeps no session to stream", async () => {
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request("https://quanta.test/mcp"), TEST_ENV, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(405);
  });
});

describe("the tool payment gate", () => {
  it("quotes a price instead of working when no payment is offered", async () => {
    const result = await callTool("check_url", { url: "https://example.com/" });
    expect(result.x402).toBe("payment_required");
    expect(result.accepts[0].network).toBe("eip155:84532");
    expect(result.verdict).toBeUndefined();
    expect(net.requested).toHaveLength(0); // it did not even look at the site
  });

  it("REFUSES payment='bogus' - presence is not proof", async () => {
    net.serves("https://example.com/", { body: goodHtml });

    const result = await callTool("check_url", { url: "https://example.com/", payment: "bogus" });

    expect(result.x402).toBe("payment_invalid");
    expect(result.reason).toBe("malformed_payment_payload");
    expect(result.verdict).toBeUndefined();
    expect(result.html).toBeUndefined();
    expect(facilitator.settleCalls).toBe(0);
    expect(net.requested).toHaveLength(0);
  });

  it("refuses a well-formed payload that matches nothing we sell", async () => {
    const header = await paymentHeader();
    const decoded = JSON.parse(atob(header));
    decoded.accepted.amount = "1"; // a tenth of a cent is 1000; this is not our price
    const forged = btoa(JSON.stringify(decoded));

    const result = await callTool("check_url", { url: "https://example.com/", payment: forged });
    expect(result.x402).toBe("payment_invalid");
    expect(result.reason).toBe("no_matching_requirements");
    expect(facilitator.verifyCalls).toBe(0);
  });

  it("refuses a payment the facilitator says is invalid", async () => {
    facilitator.rejectWith = "insufficient_funds";
    net.serves("https://example.com/", { body: goodHtml });

    const result = await callTool("check_url", {
      url: "https://example.com/",
      payment: await paymentHeader(),
    });
    expect(result.x402).toBe("payment_invalid");
    expect(result.reason).toBe("insufficient_funds");
    expect(facilitator.verifyCalls).toBe(1);
    expect(facilitator.settleCalls).toBe(0);
  });

  it("verifies before it works, and settles after", async () => {
    net.serves("https://example.com/", { body: goodHtml });

    const result = await callTool("check_url", {
      url: "https://example.com/",
      payment: await paymentHeader(),
    });

    expect(result.verdict.grade).toBeTypeOf("string");
    expect(result.html.title.text).toBe("Northgate Home Services");
    expect(result._meta.metered).toBe(true);
    expect(result._meta.tx_ref).toBe("0xstubtx");
    expect(facilitator.verifyCalls).toBe(1);
    expect(facilitator.settleCalls).toBe(1);

    const row = await TEST_ENV.DB.prepare(
      "SELECT surface, route, paid, tx_ref, target_host FROM usage_log ORDER BY id DESC LIMIT 1",
    ).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      surface: "mcp",
      route: "check_url",
      paid: 1,
      tx_ref: "0xstubtx",
      target_host: "example.com",
    });
  });

  it("gates all three tools, not just the first one", async () => {
    for (const [tool, args] of [
      ["check_url", { url: "https://example.com/" }],
      ["check_https", { host: "example.com" }],
      ["check_headers", { url: "https://example.com/" }],
    ] as const) {
      const result = await callTool(tool, { ...args, payment: "bogus" });
      expect(result.x402, `${tool} let a bogus payment through`).toBe("payment_invalid");
    }
    expect(net.requested).toHaveLength(0);
  });

  it("refuses an over-limit payer before settling, so they are not charged", async () => {
    net.serves("https://example.com/", { body: goodHtml });

    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(
        await callTool("check_url", { url: "https://example.com/", payment: await paymentHeader() }),
      );
    }

    expect(results.slice(0, 3).every((r) => r.verdict)).toBe(true); // RATE_CAPACITY = 3
    expect(results[3].error).toBe("rate_limited");
    expect(results[4].error).toBe("rate_limited");
    expect(facilitator.settleCalls).toBe(3);
  });

  it("names an unknown tool instead of guessing at one", async () => {
    const result = await callTool("check_vibes", { url: "https://example.com/" });
    expect(result.error).toContain("unknown tool");
  });
});
