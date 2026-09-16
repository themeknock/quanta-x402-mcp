/**
 * One bounded GET. Redirects are followed by hand so the SSRF guard sees every hop.
 *
 * Budgets, all configurable, all enforced:
 *   * 10 s for the whole thing, TTFB included;
 *   * 5 redirect hops, then stop and say the chain was truncated;
 *   * 2 MB of body, then stop reading and say the body was truncated.
 *
 * `redirect: "manual"` is deliberate: letting the runtime follow redirects would
 * hop straight past the guard.
 */

import type { Settings } from "../config";
import { USER_AGENT } from "../config";
import { checkUrl, type Target } from "./ssrf";

export interface FetchResult {
  ok: boolean;
  detail: string; // dns | connect | timeout | tls, or an SSRF reason
  status: number;
  finalUrl: string;
  redirects: number;
  truncatedRedirects: boolean;
  ttfbMs: number;
  totalMs: number;
  bytes: number;
  bodyTruncated: boolean;
  contentType: string;
  body: Uint8Array;
  headers: Record<string, string>;
  target: Target;
}

const empty: Target = { ok: false, host: "", ip: "", reason: "" };

function classify(error: unknown): string {
  const text = String((error as Error)?.message ?? error).toLowerCase();
  if (text.includes("abort") || text.includes("timed out") || text.includes("timeout")) {
    return "timeout";
  }
  // The runtime does not hand back a typed TLS error, so the certificate case is
  // recognised by name. Anything unrecognised is reported as "connect", never
  // guessed at.
  if (text.includes("ssl") || text.includes("certificate") || text.includes("tls")) return "tls";
  if (text.includes("dns") || text.includes("name not resolved")) return "dns";
  return "connect";
}

function failure(detail: string, partial: Partial<FetchResult> = {}): FetchResult {
  return {
    ok: false,
    detail,
    status: 0,
    finalUrl: "",
    redirects: 0,
    truncatedRedirects: false,
    ttfbMs: 0,
    totalMs: 0,
    bytes: 0,
    bodyTruncated: false,
    contentType: "",
    body: new Uint8Array(),
    headers: {},
    target: empty,
    ...partial,
  };
}

export async function boundedGet(rawUrl: string, settings: Settings): Promise<FetchResult> {
  const started = Date.now();
  const dnsCache = new Map<string, Target>();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.checkTimeoutMs);

  let current = rawUrl;
  let redirects = 0;
  let target: Target = empty;

  try {
    for (;;) {
      // The guard runs on the original URL and again on every redirect target.
      target = await checkUrl(current, dnsCache, controller.signal);
      if (!target.ok) {
        return failure(target.reason, { target, finalUrl: current, redirects });
      }

      const hopStarted = Date.now();
      let response: Response;
      try {
        response = await fetch(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" },
        });
      } catch (error) {
        return failure(classify(error), {
          target,
          finalUrl: current,
          redirects,
          totalMs: Date.now() - started,
        });
      }
      const ttfbMs = Date.now() - hopStarted;

      const isRedirect = response.status >= 300 && response.status < 400;
      const location = response.headers.get("location");
      if (isRedirect && location && redirects < settings.checkMaxRedirects) {
        current = new URL(location, current).toString();
        redirects += 1;
        continue;
      }

      const { bytes, truncated } = await readCapped(response, settings.checkMaxBytes);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      return {
        ok: true,
        detail: "",
        status: response.status,
        finalUrl: current,
        redirects,
        truncatedRedirects: isRedirect,
        ttfbMs,
        totalMs: Date.now() - started,
        bytes: bytes.length,
        bodyTruncated: truncated,
        contentType: response.headers.get("content-type") ?? "",
        body: bytes,
        headers,
        target,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Read at most `max` bytes, then stop pulling. A 900 MB target costs us 2 MB. */
async function readCapped(
  response: Response,
  max: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total >= max) {
      chunks.push(value.subarray(0, value.length - (total - max)));
      truncated = total > max;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return "";
  }
}
