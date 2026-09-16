/**
 * Assemble one check result, and score it.
 *
 * The score is arithmetic, not opinion: every issue has a fixed weight, the
 * weights are in this file, and 100 minus the weights is the score. Nothing is
 * rounded, nothing is tuned per site, and the issue list always adds up to the
 * number shown.
 *
 * Weights: high 25, medium 12, low 8.
 */

import { ENGINE, type Settings } from "../config";
import { boundedGet, hostOf } from "./fetch";
import { readHeaders, type HeaderReport } from "./headers";
import { parseHtml, type HtmlReport } from "./html";
import { checkHttps, fromFetch, type HttpsReport } from "./https";
import { BLOCK_REASONS, validateUrl } from "./ssrf";

export type Severity = "high" | "medium" | "low";

export const WEIGHTS: Record<Severity, number> = { high: 25, medium: 12, low: 8 };

export const CATALOG: Record<string, { severity: Severity; note?: string }> = {
  HTTP_ERROR_STATUS: { severity: "high", note: "the page did not return a success status" },
  MIXED_CONTENT: {
    severity: "high",
    note: "https page loads sub-resources over http; browsers block them",
  },
  HTTPS_NOT_VERIFIED: {
    severity: "high",
    note: "the TLS handshake failed, so a browser would refuse this site too",
  },
  NOT_SERVED_OVER_HTTPS: { severity: "high", note: "the final URL is plain http" },
  BOT_PROTECTION_SUSPECTED: {
    severity: "medium",
    note: "the site refused this checker's user agent (403/429); it may serve fine to a browser, and we do not run one",
  },
  NO_HTTPS_UPGRADE: {
    severity: "medium",
    note: "http:// serves content instead of redirecting to https://",
  },
  NO_TITLE_IN_RAW_HTML: {
    severity: "medium",
    note: "may be injected by JS; not checked in a browser",
  },
  NO_VIEWPORT_IN_RAW_HTML: {
    severity: "medium",
    note: "may be injected by JS; not checked in a browser",
  },
  SLOW_TTFB: { severity: "medium", note: "first byte took over 1500 ms" },
  NO_HSTS: { severity: "low" },
  NO_CSP: { severity: "low" },
  NO_X_FRAME_OPTIONS: { severity: "low" },
  NO_X_CONTENT_TYPE_OPTIONS: { severity: "low" },
  REDIRECT_CHAIN_TRUNCATED: {
    severity: "low",
    note: "more than the redirect budget; the chain was not followed to the end",
  },
};

export const SLOW_TTFB_MS = 1500;

export interface Issue {
  code: string;
  severity: Severity;
  note?: string;
}

export interface Verdict {
  score: number;
  grade: string;
  issues: Issue[];
}

export function gradeFor(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

/** 100 minus the weight of every issue found, floored at 0. */
export function score(codes: string[]): Verdict {
  let total = 100;
  const issues: Issue[] = [];
  for (const code of codes) {
    const entry = CATALOG[code];
    if (!entry) continue;
    total -= WEIGHTS[entry.severity];
    issues.push(entry.note ? { code, severity: entry.severity, note: entry.note } : { code, severity: entry.severity });
  }
  total = Math.max(0, total);
  return { score: total, grade: gradeFor(total), issues };
}

export interface HttpBlock {
  status: number;
  final_url: string;
  redirects: number;
  ttfb_ms: number;
  total_ms: number;
  bytes: number;
  content_type: string;
  truncated?: boolean;
}

export function issuesFor(
  http: Partial<HttpBlock>,
  https: Partial<HttpsReport> | null,
  headers: HeaderReport | null,
  html: HtmlReport | null,
): string[] {
  const codes: string[] = [];
  const status = http.status ?? 0;

  if (status === 403 || status === 429) {
    // A refusal aimed at our user agent is a different fact from a broken page,
    // and saying so is the difference between a useful answer and a wrong one.
    codes.push("BOT_PROTECTION_SUSPECTED");
  } else if (status >= 400) {
    codes.push("HTTP_ERROR_STATUS");
  }
  if (http.truncated) codes.push("REDIRECT_CHAIN_TRUNCATED");
  if ((http.ttfb_ms ?? 0) > SLOW_TTFB_MS) codes.push("SLOW_TTFB");

  if (https) {
    if (https.error) codes.push("HTTPS_NOT_VERIFIED");
    else if (https.verified === false) codes.push("NOT_SERVED_OVER_HTTPS");
    if (https.upgrades_from_http === "serves_http_without_redirect") codes.push("NO_HTTPS_UPGRADE");
  }

  if (html) {
    if (!html.title.present) codes.push("NO_TITLE_IN_RAW_HTML");
    if (!html.viewport.present) codes.push("NO_VIEWPORT_IN_RAW_HTML");
    if (html.mixed_content.count > 0) codes.push("MIXED_CONTENT");
  }

  if (headers) {
    if (!headers.hsts) codes.push("NO_HSTS");
    if (!headers.csp) codes.push("NO_CSP");
    if (!headers.x_frame_options) codes.push("NO_X_FRAME_OPTIONS");
    if (!headers.x_content_type_options) codes.push("NO_X_CONTENT_TYPE_OPTIONS");
  }

  return codes;
}

export interface Meta {
  checked_at: string;
  engine: string;
  metered: boolean;
  network: string;
  idempotent_replay: boolean;
}

export function meta(opts: {
  metered: boolean;
  network?: string;
  idempotentReplay?: boolean;
}): Meta {
  return {
    checked_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    engine: ENGINE,
    metered: opts.metered,
    network: opts.network ?? "",
    idempotent_replay: opts.idempotentReplay ?? false,
  };
}

// ---------------------------------------------------------------------------
// Running a check: one URL in, (http status, body) out.
// ---------------------------------------------------------------------------

export interface RunResult {
  status: number;
  body: Record<string, unknown>;
}

interface RunOpts {
  settings: Settings;
  metered: boolean;
  network?: string;
  idempotentReplay?: boolean;
}

function errorFor(detail: string): RunResult {
  if (detail === "invalid_url" || detail === "no_host") {
    return { status: 400, body: { error: "invalid_url" } };
  }
  if (BLOCK_REASONS.has(detail)) {
    return { status: 403, body: { error: "target_blocked", reason: detail } };
  }
  if (detail === "dns_failed") {
    return { status: 502, body: { error: "target_unreachable", detail: "dns" } };
  }
  return { status: 502, body: { error: "target_unreachable", detail: detail || "connect" } };
}

function httpBlock(result: Awaited<ReturnType<typeof boundedGet>>): HttpBlock {
  const block: HttpBlock = {
    status: result.status,
    final_url: result.finalUrl,
    redirects: result.redirects,
    ttfb_ms: result.ttfbMs,
    total_ms: result.totalMs,
    bytes: result.bytes,
    content_type: result.contentType,
  };
  if (result.truncatedRedirects) block.truncated = true;
  return block;
}

/** GET /v1/check - the full verdict. */
export async function runCheck(url: string, opts: RunOpts): Promise<RunResult> {
  const result = await boundedGet(url, opts.settings);
  if (!result.ok) return errorFor(result.detail);

  const https = fromFetch(result.finalUrl);
  const http = httpBlock(result);
  const headers = readHeaders(result.headers);
  const html = await parseHtml(result.body, {
    finalUrl: result.finalUrl,
    contentType: result.contentType,
    truncated: result.bodyTruncated,
  });

  const codes = issuesFor(http, https, headers, html);
  return {
    status: 200,
    body: {
      target: { url, host: result.target.host, ip: result.target.ip },
      http,
      https,
      headers,
      html,
      verdict: score(codes),
      _meta: meta(opts),
    },
  };
}

/** GET /v1/https - HTTPS posture for one host. */
export async function runHttps(host: string, opts: RunOpts): Promise<RunResult> {
  if (!host || host.includes("/") || host.includes(":")) {
    return { status: 400, body: { error: "invalid_url" } };
  }
  const outcome = await checkHttps(host, opts.settings);
  if (outcome.kind === "unreachable") {
    const detail = outcome.detail ?? "connect";
    if (BLOCK_REASONS.has(detail)) {
      return { status: 403, body: { error: "target_blocked", reason: detail } };
    }
    return errorFor(detail);
  }

  return {
    status: 200,
    body: {
      target: { host, ip: outcome.target.ip },
      https: outcome.report,
      _meta: meta(opts),
    },
  };
}

/** GET /v1/headers - status, timings and the four security headers. */
export async function runHeaders(url: string, opts: RunOpts): Promise<RunResult> {
  const parsed = validateUrl(url);
  if (!parsed.ok) return { status: 400, body: { error: "invalid_url" } };

  const result = await boundedGet(url, opts.settings);
  if (!result.ok) return errorFor(result.detail);

  return {
    status: 200,
    body: {
      target: { url, host: result.target.host, ip: result.target.ip },
      http: httpBlock(result),
      headers: readHeaders(result.headers),
      _meta: meta(opts),
    },
  };
}

export { hostOf };
