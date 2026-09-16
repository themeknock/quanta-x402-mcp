/**
 * The page a human gets at `/`.
 *
 * The same route serves JSON to anything that is not a browser, because the
 * primary caller here is an agent and an agent wants the machine answer. But a
 * person who opens the link deserves to understand this in fifteen seconds, and
 * raw JSON does not do that.
 *
 * Everything the page claims, it proves by calling this service live from the
 * visitor's browser: the 402 panel really does hit /v1/check and decode the
 * challenge header off the response, and the verdict panel really does run
 * /demo. No number on this page is written into it by hand.
 */

import type { Settings } from "./config";

/**
 * The same picture as docs/architecture.svg, in the page's own palette and sized
 * for it. Inlined rather than linked because a Worker has no filesystem to serve
 * an asset from, and one <img> request saved is one less thing to go wrong.
 */
function diagram(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 376" role="img"
  aria-label="An agent asks; the Worker answers 402; the agent pays; the Worker verifies with the facilitator, runs the check, settles, and writes an audit row to D1.">
  <style>
    .b{fill:#0B211F;stroke:#1E3B36;stroke-width:1}
    .ba{fill:#12332C;stroke:#4E6B3F}
    .h{fill:#E8F0EC;font:500 14px "IBM Plex Mono",monospace}
    .p{fill:#8FA79E;font:400 12px "IBM Plex Mono",monospace}
    .g{fill:#C8F04B;font:400 12px "IBM Plex Mono",monospace}
    .l{stroke:#2E4B45;stroke-width:1.5;fill:none}
    .lg{stroke:#7C9B3E;stroke-width:1.5;fill:none}
    .c{fill:#6F8A82;font:400 11px "IBM Plex Mono",monospace}
  </style>
  <rect class="b" x="22" y="34" width="176" height="86" rx="8"/>
  <text class="h" x="40" y="62">agent</text>
  <text class="p" x="40" y="84">HTTP or MCP client,</text>
  <text class="p" x="40" y="102">holding a wallet</text>

  <path class="l" d="M198 62 H 332" marker-end="url(#a)"/>
  <text class="c" x="222" y="54">1. a URL</text>
  <path class="l" d="M332 96 H 198" marker-end="url(#a)"/>
  <text class="c" x="220" y="114">2. 402 + price</text>

  <rect class="b" x="332" y="34" width="206" height="112" rx="8"/>
  <text class="h" x="350" y="62">Worker</text>
  <text class="p" x="350" y="84">/v1/*  paid routes</text>
  <text class="p" x="350" y="102">/mcp   the same three</text>
  <text class="g" x="350" y="128">one x402 server for both</text>

  <path class="lg" d="M538 64 H 668" marker-end="url(#b)"/>
  <text class="c" x="558" y="56">3. verify</text>
  <path class="lg" d="M538 118 H 668" marker-end="url(#b)"/>
  <text class="c" x="558" y="136">6. settle</text>

  <rect class="b ba" x="668" y="34" width="210" height="112" rx="8"/>
  <text class="h" x="686" y="62">facilitator</text>
  <text class="p" x="686" y="84">Base Sepolia, USDC</text>
  <text class="p" x="686" y="102">on-chain settlement</text>
  <text class="p" x="686" y="128">$0.001 a call</text>

  <path class="l" d="M435 146 V 196 " marker-end="url(#a)"/>
  <text class="c" x="448" y="176">4. one bounded GET</text>

  <rect class="b" x="332" y="196" width="206" height="96" rx="8"/>
  <text class="h" x="350" y="224">the check</text>
  <text class="p" x="350" y="246">SSRF guard, every hop</text>
  <text class="p" x="350" y="264">HTMLRewriter, headers</text>
  <text class="p" x="350" y="282">score = 100 - weights</text>

  <path class="l" d="M332 244 H 216" marker-end="url(#a)"/>
  <text class="c" x="228" y="236">5. verdict</text>

  <path class="lg" d="M773 146 V 336 H 119 V 292" marker-end="url(#b)"/>
  <text class="c" x="330" y="330">7. the tx hash stamps that row paid</text>

  <rect class="b" x="22" y="196" width="194" height="96" rx="8"/>
  <text class="h" x="40" y="224">D1</text>
  <text class="p" x="40" y="246">audit log: the host,</text>
  <text class="p" x="40" y="264">never the full URL</text>
  <text class="p" x="40" y="282">idempotency, limits</text>

  <defs>
    <marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="#2E4B45"/></marker>
    <marker id="b" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="#7C9B3E"/></marker>
  </defs>
</svg>`;
}

export function landingPage(settings: Settings, price: string): string {
  const rail = "Base Sepolia";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quanta — pay-per-call website checks for agents</title>
<meta name="description" content="An AI agent hands over a URL, pays a tenth of a cent, and gets back a structured verdict on whether that website is broken. No account, no API key.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230B211F'/%3E%3Ccircle cx='16' cy='15' r='7.5' fill='none' stroke='%23C8F04B' stroke-width='2.5'/%3E%3Cpath d='M19 19.5 L24 25' stroke='%23C8F04B' stroke-width='2.5' stroke-linecap='round'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{
    --ink:#0B211F; --ink-2:#0F2A27; --line:#1E3B36;
    --fg:#E8F0EC; --mut:#8FA79E; --lime:#C8F04B; --warn:#F0B84B;
    --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
    --sans:"Schibsted Grotesk",system-ui,-apple-system,Segoe UI,sans-serif;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--ink);color:var(--fg);font-family:var(--sans);
       font-size:17px;line-height:1.55;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1040px;margin:0 auto;padding:0 24px}
  a{color:var(--fg)}
  code,pre,.m{font-family:var(--mono)}

  header{border-bottom:1px solid var(--line)}
  .bar{display:flex;align-items:center;gap:16px;padding:18px 0;flex-wrap:wrap}
  .mark{font-weight:700;letter-spacing:-.02em;font-size:19px}
  .live{display:flex;align-items:center;gap:7px;font-family:var(--mono);font-size:12px;color:var(--mut)}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--lime)}
  .bar nav{margin-left:auto;display:flex;gap:20px;font-family:var(--mono);font-size:13px}
  .bar nav a{color:var(--mut);text-decoration:none}
  .bar nav a:hover{color:var(--fg)}

  .hero{padding:60px 0 44px;border-bottom:1px solid var(--line)}
  h1{font-size:clamp(32px,4.6vw,56px);line-height:1.08;letter-spacing:-.03em;
     font-weight:700;margin:0 0 22px;max-width:19ch}
  h1 em{font-style:normal;color:var(--lime)}
  .lede{font-size:19px;color:var(--mut);max-width:58ch;margin:0}
  .lede b{color:var(--fg);font-weight:500}

  .panels{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line);
          border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:40px 0 28px}
  .panel{background:var(--ink-2);padding:26px}
  .panel h2{font-size:13px;font-family:var(--mono);font-weight:500;color:var(--mut);
            margin:0 0 6px;letter-spacing:.04em;text-transform:uppercase}
  .panel p{margin:0 0 18px;font-size:15px;color:var(--mut);min-height:44px}
  button{font-family:var(--mono);font-size:13px;background:transparent;color:var(--lime);
         border:1px solid var(--lime);border-radius:6px;padding:9px 16px;cursor:pointer}
  button:hover{background:var(--lime);color:var(--ink)}
  button[disabled]{opacity:.45;cursor:default;background:transparent;color:var(--lime)}
  pre{font-size:12.5px;line-height:1.6;margin:18px 0 0;padding:16px;background:var(--ink);
      border:1px solid var(--line);border-radius:6px;overflow-x:auto;white-space:pre;color:var(--mut)}
  pre b{color:var(--fg);font-weight:500}
  pre .ok{color:var(--lime)}
  pre .no{color:var(--warn)}
  .grade{font-size:38px;font-weight:700;letter-spacing:-.02em;color:var(--lime)}

  .figure{border:1px solid var(--line);border-radius:10px;background:var(--ink-2);
          overflow-x:auto;padding:4px}
  .figure svg{display:block;min-width:820px;width:100%;height:auto}

  section.how{padding:44px 0;border-bottom:1px solid var(--line)}
  .kicker{font-family:var(--mono);font-size:12px;color:var(--mut);letter-spacing:.08em;
          text-transform:uppercase;margin:0 0 18px}
  .note{margin:22px 0 0;color:var(--mut);font-size:15px;max-width:66ch}
  .note b{color:var(--fg);font-weight:500}

  footer{padding:36px 0 56px;font-size:14px;color:var(--mut)}
  footer .row{display:flex;gap:28px;flex-wrap:wrap;font-family:var(--mono);font-size:13px}
  footer a{color:var(--mut)}

  @media(max-width:760px){
    /* margin-left:auto pushes the nav past the right edge once it wraps. */
    .bar{gap:10px}
    .bar nav{margin-left:0;width:100%;gap:16px}
    .panels{grid-template-columns:1fr}
    .hero{padding:52px 0 40px}
    .panel p{min-height:0}
  }
</style>
</head>
<body>

<header><div class="wrap bar">
  <span class="mark">Quanta</span>
  <span class="live"><span class="dot"></span>live · ${rail} testnet</span>
  <nav>
    <a href="/mcp">MCP</a>
    <a href="/demo">/demo</a>
    <a href="/bot">bot policy</a>
    <a href="https://github.com/themeknock/quanta-x402-mcp">source</a>
  </nav>
</div></header>

<div class="wrap">

  <section class="hero">
    <h1>An agent hands over a URL, pays <em>${price}</em>, and learns whether that site is broken.</h1>
    <p class="lede"><b>No account. No API key. The payment is the login.</b>
      Rate limits, idempotency and the audit log all key off the payer address in the
      verified payment, so there is nothing to sign up for and nothing to leak.</p>
  </section>

  <section class="panels">
    <div class="panel">
      <h2>Ask without paying</h2>
      <p>The paid route answers 402 and tells you the price, the chain and the address to pay.</p>
      <button id="b402">GET /v1/check</button>
      <pre id="o402">$ curl -i /v1/check?url=https://example.com
<span class="m">press the button — this runs for real</span></pre>
    </div>
    <div class="panel">
      <h2>Or run the free one</h2>
      <p>The same check, unmetered, on an allowlisted host. Every issue it names is true.</p>
      <button id="bdemo">GET /demo</button>
      <pre id="odemo">$ curl -s /demo | jq .verdict
<span class="m">press the button — this runs for real</span></pre>
    </div>
  </section>

  <section class="how">
    <p class="kicker">challenge → pay → settle → audit</p>
    <div class="figure">${diagram()}</div>
    <p class="note"><b>Verify and settle are two steps on purpose.</b> A caller over their rate
      limit is refused before their money moves — the difference between a paywall and a toll
      booth that charges you to be turned away.</p>
  </section>

  <section class="how" style="border-bottom:none">
    <p class="kicker">the same three checks, as MCP tools</p>
    <pre>{
  "mcpServers": {
    "quanta": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${settings.publicBaseUrl}/mcp"]
    }
  }
}</pre>
    <p class="note">Stateless — no session, no Durable Object. Every call carries its own payment,
      so there is nothing to remember between requests. Call a tool without one and it quotes you
      a price; call it with a made-up one and it is refused.</p>
  </section>

  <footer>
    <p class="note" style="margin:0 0 20px"><b>What it is not.</b> It does not render JavaScript.
      It settles on ${rail} testnet. It cannot read a certificate's expiry or issuer — this
      runtime exposes no certificate object — so it reports whether the certificate
      <em>verified</em> rather than pretending to have read one.</p>
    <div class="row">
      <a href="/health">health</a>
      <a href="/internal/usage">audit log</a>
      <a href="https://github.com/themeknock/quanta-x402-mcp">github</a>
      <a href="https://themeknock.net">themeknock.net</a>
    </div>
  </footer>
</div>

<script>
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

async function run(button, out, fn) {
  button.disabled = true;
  out.innerHTML = '<span class="m">running…</span>';
  try { await fn(); }
  catch (error) { out.innerHTML = '<span class="no">' + esc(error.message || error) + '</span>'; }
  button.disabled = false;
}

document.getElementById('b402').onclick = (e) => run(e.target, o402, async () => {
  const response = await fetch('/v1/check?url=https://example.com');
  const header = response.headers.get('payment-required');
  let lines = '$ curl -i /v1/check?url=https://example.com\\n\\n<b>HTTP ' + response.status + ' ' +
    (response.status === 402 ? '<span class="ok">Payment Required</span>' : esc(response.statusText)) + '</b>';
  if (header) {
    const challenge = JSON.parse(atob(header));
    const a = challenge.accepts[0];
    lines += '\\n\\n# the PAYMENT-REQUIRED header, decoded\\n' +
      '  network  <b>' + esc(a.network) + '</b>\\n' +
      '  amount   <b>' + esc(a.amount) + '</b> atomic units of USDC\\n' +
      '  asset    ' + esc(a.asset) + '\\n' +
      '  payTo    ' + esc(a.payTo);
  }
  o402.innerHTML = lines;
});

document.getElementById('bdemo').onclick = (e) => run(e.target, odemo, async () => {
  const body = await (await fetch('/demo')).json();
  if (!body.verdict) throw new Error(body.error || 'no verdict');
  const issues = body.verdict.issues.map((i) => '  ' + i.severity.padEnd(7) + ' ' + esc(i.code)).join('\\n');
  odemo.innerHTML = '$ curl -s /demo | jq .verdict\\n\\n' +
    '<span class="grade">' + esc(body.verdict.grade) + '</span>  <b>' + body.verdict.score + '/100</b>' +
    '   <span class="m">' + esc(body.target.host) + '</span>\\n\\n' + issues;
});
</script>
</body>
</html>`;
}
