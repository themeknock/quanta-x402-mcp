# Quanta

Pay-per-call website checks for autonomous agents. An agent hands over a URL, pays
a tenth of a cent over **x402**, and gets back a structured verdict on whether that
website is broken. No account, no API key: the verified payer address from the
payment is the identity.

Two surfaces, one payment gate:

* **HTTP** — `GET /v1/check`, `/v1/https`, `/v1/headers`, metered by the x402 SDK's
  Hono middleware.
* **MCP** — `check_url`, `check_https`, `check_headers` at `/mcp`, gated by the same
  `x402ResourceServer` instance, so the price cannot differ between the two.

Runs on Cloudflare Workers + D1. Free tier, $0/month.

```
npm install
npm test            # vitest, inside workerd, against a stub facilitator
npm run typecheck
npm run dev         # wrangler dev --local
```

Settlement is **Base Sepolia testnet**. It does not render JavaScript, and it
reports whether HTTPS verifies rather than certificate expiry and issuer, because
the Workers runtime exposes no certificate object. Both limits are stated in the
service's own `/` response, not only here.

> The full README (what it costs, what it refuses to answer, the real settlement
> tx) lands in session 5. Until then this file says only what is already true.
