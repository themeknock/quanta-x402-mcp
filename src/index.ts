/**
 * Quanta - an agent hands over a URL, pays a tenth of a cent, and gets back a
 * structured verdict on whether that website is broken.
 *
 * No account, no API key: the verified payer address from the x402 payment IS the
 * principal for rate limiting, idempotency and the audit log.
 *
 * Paid (x402-metered): GET /v1/check, /v1/https, /v1/headers
 * Free:                GET /, /health, /demo, /bot, /internal/usage, /mcp
 *
 * Two surfaces, one payment gate: the routes below are gated by the SDK's Hono
 * middleware; the MCP tools at /mcp are gated by src/payments.ts. Both use the
 * same x402ResourceServer instance, so the price cannot differ between them.
 */

import { decodePaymentResponseHeader } from "@x402/core/http";
import { paymentMiddleware } from "@x402/hono";
import { Hono, type Context, type MiddlewareHandler } from "hono";

import { runCheck, runHeaders, runHttps } from "./checks/verdict";
import { hostOf } from "./checks/fetch";
import { settingsFrom, USER_AGENT, type Env, type Settings } from "./config";
import { handleMcp } from "./mcp";
import { decodeVerifiedHeader, nonceOf, payerOf } from "./payments";
import * as idempotency from "./idempotency";
import { take } from "./ratelimit";
import { bodyHash, logUsage, markSettled, recentUsage } from "./usage";
import { getResourceServer, paymentOptions, rails } from "./x402";

type Vars = { settings: Settings };
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * PAYMENT-SIGNATURE is the V2 request header; X-PAYMENT is its V1 legacy name.
 * The SDK middleware accepts either, so the two places that read the header back
 * out - the settlement stamp and the route - must accept either too, or a V1
 * caller would pay and get an audit row with no payer on it.
 */
const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

function verifiedPayload(c: Ctx) {
  return decodeVerifiedHeader(c.req.header("payment-signature") ?? c.req.header("x-payment"));
}

/** route key -> what the payer is buying. This also drives the x402 requirements. */
const PROTECTED_ROUTES: Record<string, string> = {
  "GET /v1/check": "Full check of one URL: reachability, HTTPS, security headers, raw-HTML basics.",
  "GET /v1/https": "HTTPS posture for one host: verified certificate, http->https upgrade, HSTS.",
  "GET /v1/headers": "Status, timings and the four security headers for one URL.",
};

const FREE_ROUTES = ["/", "/health", "/demo", "/bot", "/internal/usage", "/mcp"];

app.use("*", async (c, next) => {
  c.set("settings", settingsFrom(c.env));
  await next();
});

// --------------------------------------------------------------------------
// x402 metering
// --------------------------------------------------------------------------
/**
 * Built once per isolate, not once per request: constructing the middleware also
 * constructs an HTTP resource server, and that asks the facilitator which
 * scheme/network pairs it supports. Rebuilding it per request would put a
 * network round-trip in front of every call.
 */
let cachedMiddleware: MiddlewareHandler | null = null;

function meteringMiddleware(settings: Settings): MiddlewareHandler | null {
  const server = getResourceServer(settings);
  if (!server) return null;
  if (cachedMiddleware) return cachedMiddleware;

  const routes: Record<string, unknown> = {};
  for (const [key, description] of Object.entries(PROTECTED_ROUTES)) {
    routes[key] = { accepts: paymentOptions(settings), mimeType: "application/json", description };
  }
  cachedMiddleware = paymentMiddleware(routes as never, server);
  return cachedMiddleware;
}

/**
 * Stamp the settlement onto the audit row the route wrote.
 *
 * The route cannot know the tx hash - the SDK settles after the handler returns -
 * so this runs outside the payment middleware, reads the PAYMENT-RESPONSE header
 * the SDK attaches, and matches the row on the payment nonce.
 */
app.use("/v1/*", async (c, next) => {
  await next();

  const encoded = c.res.headers.get(PAYMENT_RESPONSE_HEADER);
  if (!encoded) return;

  const nonce = nonceOf(verifiedPayload(c));
  if (!nonce) return;

  try {
    const settlement = decodePaymentResponseHeader(encoded) as {
      success?: boolean;
      transaction?: string;
      payer?: string;
      network?: string;
    };
    if (!settlement.success) return;
    await markSettled(c.env.DB, nonce, {
      txRef: settlement.transaction ?? "",
      payer: settlement.payer ?? "",
      network: String(settlement.network ?? ""),
    });
  } catch (error) {
    // A settlement we cannot read is logged, never guessed at. The row stays
    // unpaid, which is the truthful state of what we know.
    console.warn("could not read PAYMENT-RESPONSE", error);
  }
});

app.use("/v1/*", async (c, next) => {
  const middleware = meteringMiddleware(c.get("settings"));
  if (!middleware) {
    // Unmetered dev mode. Loud, and visible in every response's _meta.
    console.warn("x402 disabled (X402_ENABLED=false) - serving UNMETERED (dev mode).");
    return next();
  }
  return middleware(c, next);
});

// --------------------------------------------------------------------------
// Paid routes
// --------------------------------------------------------------------------
type Runner = (metered: boolean, network: string, replay: boolean) => Promise<{ status: number; body: Record<string, unknown> }>;

/**
 * Rate limit -> idempotency -> the check -> audit row.
 *
 * Order matters. The rate limit runs before the work AND before settlement: the
 * SDK cancels settlement on any 4xx/5xx, so a refused caller does not pay.
 */
async function servePaid(
  c: Ctx,
  route: string,
  params: Record<string, string>,
  run: Runner,
  targetHost: string,
): Promise<Response> {
  const startedAt = Date.now();
  const settings = c.get("settings") as Settings;
  const metered = Boolean(getResourceServer(settings));

  const payload = verifiedPayload(c);
  const payer = payerOf(payload);
  const nonce = nonceOf(payload);
  const network = String(
    (payload as { accepted?: { network?: string } } | null)?.accepted?.network ?? "",
  );

  const limit = await take(c.env.DB, payer, {
    capacity: settings.rateCapacity,
    refillPerS: settings.rateRefillPerS,
  });
  if (!limit.allowed) {
    return c.json({ error: "rate_limited", retry_after_s: limit.retryAfterS }, 429);
  }

  const key = (c.req.header("Idempotency-Key") ?? "").slice(0, idempotency.MAX_KEY_LEN);
  const hash = await idempotency.requestHash(route, params);
  const cached = await idempotency.lookup(c.env.DB, payer, key, route, hash);

  if (cached.kind === "conflict") {
    return c.json({ error: "idempotency_key_reused_with_different_request" }, 409);
  }
  if (cached.kind === "hit") {
    const body = { ...(cached.body as Record<string, unknown>) };
    body._meta = { ...((body._meta ?? {}) as object), idempotent_replay: true };
    await logUsage(c.env.DB, {
      surface: "http",
      route,
      targetHost,
      network,
      payer,
      amount: settings.price,
      paid: false,
      idempotentReplay: true,
      paymentNonce: nonce,
      durationMs: Date.now() - startedAt,
      verdictHash: await bodyHash(body),
    });
    return c.json(body, cached.statusCode as 200);
  }

  const { status, body } = await run(metered, network, false);

  if (status === 200 && key) {
    await idempotency.remember(c.env.DB, payer, key, route, hash, body, status);
  }

  await logUsage(c.env.DB, {
    surface: "http",
    route,
    targetHost,
    network,
    payer,
    amount: settings.price,
    paid: false,
    paymentNonce: status === 200 ? nonce : "",
    durationMs: Date.now() - startedAt,
    verdictHash: await bodyHash(body),
  });

  return c.json(body, status as 200);
}

app.get("/v1/check", async (c) => {
  const url = c.req.query("url") ?? "";
  const settings = c.get("settings");
  return servePaid(
    c,
    "/v1/check",
    { url },
    (metered, network, idempotentReplay) => runCheck(url, { settings, metered, network, idempotentReplay }),
    hostOf(url),
  );
});

app.get("/v1/https", async (c) => {
  const host = c.req.query("host") ?? "";
  const settings = c.get("settings");
  return servePaid(
    c,
    "/v1/https",
    { host },
    (metered, network, idempotentReplay) => runHttps(host, { settings, metered, network, idempotentReplay }),
    host,
  );
});

app.get("/v1/headers", async (c) => {
  const url = c.req.query("url") ?? "";
  const settings = c.get("settings");
  return servePaid(
    c,
    "/v1/headers",
    { url },
    (metered, network, idempotentReplay) => runHeaders(url, { settings, metered, network, idempotentReplay }),
    hostOf(url),
  );
});

// --------------------------------------------------------------------------
// Free routes
// --------------------------------------------------------------------------
app.get("/", (c) => {
  const settings = c.get("settings");
  const metered = Boolean(getResourceServer(settings));
  return c.json({
    service: "Quanta",
    what_it_does:
      "Give it a URL, pay $0.001, get a structured verdict on whether that website is broken. No account, no API key.",
    metered_via_x402: metered,
    rails: metered ? rails(settings) : [],
    paid_routes: Object.keys(PROTECTED_ROUTES),
    free_routes: FREE_ROUTES,
    mcp: {
      endpoint: "/mcp",
      transport: "streamable-http (stateless)",
      tools: ["check_url", "check_https", "check_headers"],
    },
    limits: {
      renders_javascript: false,
      html_checked: "raw_html_only",
      certificate_fields: "not readable on this runtime; HTTPS is reported as verified or not",
      settlement: "Base Sepolia testnet",
    },
  });
});

app.get("/health", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
  } catch (error) {
    console.warn("health: database unreachable", error);
    return c.json({ ok: false, db: false }, 503);
  }
  return c.json({ ok: true, db: true });
});

/**
 * The same verdict /v1/check returns, free, for hosts we chose ourselves.
 *
 * Free and unmetered, so it is allowlisted: this endpoint cannot be pointed at
 * someone else's site and used as an anonymous scanner.
 *
 * It tries the allowlist in order and returns the first host that answers. That
 * is not politeness, it is a live constraint: this Worker is served from a Custom
 * Domain on the themeknock.net zone, and a Worker subrequest to another hostname
 * on its OWN zone loops and times out. themeknock.net is therefore unreachable
 * from inside quanta.themeknock.net, while every other host on the list is fine.
 * Rather than ship a demo that 502s, the endpoint moves to the next host and says
 * in `_meta` which ones did not answer.
 */
const DEMO_MAX_ATTEMPTS = 3;

app.get("/demo", async (c) => {
  const startedAt = Date.now();
  const settings = c.get("settings");
  const requested = c.req.query("url") ?? "";

  if (requested) {
    const host = hostOf(requested).toLowerCase();
    if (!settings.demoAllowlist.includes(host)) {
      return c.json(
        {
          error: "demo_host_not_allowed",
          allowed: settings.demoAllowlist,
          hint: "The free demo only checks hosts we own. Paid calls to /v1/check take any URL.",
        },
        403,
      );
    }
  }

  const candidates = requested
    ? [requested]
    : settings.demoAllowlist.slice(0, DEMO_MAX_ATTEMPTS).map((host) => `https://${host}`);

  const skipped: Array<{ host: string; reason: string }> = [];
  let last: { status: number; body: Record<string, unknown> } = {
    status: 502,
    body: { error: "demo_unavailable" },
  };

  for (const target of candidates) {
    const host = hostOf(target).toLowerCase();
    last = await runCheck(target, { settings, metered: false });

    await logUsage(c.env.DB, {
      surface: "http",
      route: "/demo",
      targetHost: host,
      paid: false,
      durationMs: Date.now() - startedAt,
      verdictHash: await bodyHash(last.body),
    });

    if (last.status === 200) {
      last.body._meta = {
        ...((last.body._meta ?? {}) as object),
        free_demo: true,
        ...(skipped.length ? { demo_hosts_that_did_not_answer: skipped } : {}),
      };
      return c.json(last.body, 200);
    }

    skipped.push({ host, reason: String(last.body.detail ?? last.body.error ?? "unknown") });
  }

  last.body._meta = { free_demo: true, demo_hosts_that_did_not_answer: skipped };
  return c.json(last.body, last.status as 200);
});

app.get("/bot", (c) => {
  const settings = c.get("settings");
  return c.text(`Quanta website checks

User-Agent: ${USER_AGENT}

What it is
  Quanta fetches a single page when one of its users asks it to check that page.
  It is not a crawler: it follows no links, queues nothing, and never visits a
  URL nobody asked about. One request per call, at most ${settings.checkMaxRedirects} redirect hops.

What it reads
  The response status, timings, whether HTTPS verifies, four security headers,
  and the raw HTML (title, viewport, mixed content, asset counts). It does not
  run JavaScript. It stores the hostname it checked, never the full URL.

How to block it
  User-agent: QuantaCheck
  Disallow: /

Contact
  themeknock@gmail.com
`);
});

app.get("/internal/usage", async (c) => {
  const limit = Number(c.req.query("limit") ?? 25);
  return c.json({ recent: await recentUsage(c.env.DB, Number.isFinite(limit) ? limit : 25) });
});

app.all("/mcp", async (c) => handleMcp(c.req.raw, c.env, c.get("settings")));

app.notFound((c) => c.json({ error: "not_found", free_routes: FREE_ROUTES }, 404));

app.onError((error, c) => {
  console.error("unhandled", error);
  return c.json({ error: "internal_error" }, 500);
});

// The Worker entrypoint. Nothing else may be exported from this module: workerd
// reads every named export as a handler or Durable Object class, so a re-exported
// constant is a startup crash, not a convenience.
export default app;
