/**
 * HTTPS posture - and an honest account of what this platform can and cannot see.
 *
 * The Python build of this service read the certificate itself: expiry, issuer,
 * SAN match. Cloudflare Workers exposes no certificate object, and outbound raw
 * TCP to Cloudflare's own IP ranges is blocked, so doing the handshake by hand is
 * not open either - a large share of the web sits behind Cloudflare. Rather than
 * fake those fields, they are gone.
 *
 * What is left is not nothing. The runtime performs a real TLS handshake and
 * fails closed on an expired, hostname-mismatched, self-signed or
 * untrusted-chain certificate. So "the fetch succeeded" IS a verification
 * result - the same trust decision a browser makes - and it catches the failure
 * mode that actually takes sites down. It just cannot tell you the expiry date.
 *
 * One rule this file will not break: a timeout is not a certificate error. If the
 * host is simply unreachable we say unreachable, never "the certificate is bad".
 */

import type { Settings } from "../config";
import { USER_AGENT } from "../config";
import { resolve, type Target } from "./ssrf";

export type UpgradeState =
  | "redirects_to_https"
  | "serves_http_without_redirect"
  | "no_http_listener";

export interface HttpsReport {
  ok: boolean;
  verified: boolean;
  checked: "verified_fetch";
  status?: number;
  upgrades_from_http?: UpgradeState;
  hsts?: boolean;
  note: string;
  error?: string;
}

export const NOTE =
  "the certificate verified against a browser trust store; expiry and issuer are not readable on this platform";

/** Classify a fetch failure. Only a named TLS failure is allowed to mean "bad certificate". */
export function classifyFailure(error: unknown): "tls" | "timeout" | "dns" | "connect" {
  const text = String((error as Error)?.message ?? error).toLowerCase();
  if (text.includes("ssl") || text.includes("certificate") || text.includes("tls")) return "tls";
  if (text.includes("abort") || text.includes("timeout") || text.includes("timed out")) {
    return "timeout";
  }
  if (text.includes("dns") || text.includes("name not resolved")) return "dns";
  return "connect";
}

/** The `https` block for /v1/check: derived from the fetch that already happened, no extra requests. */
export function fromFetch(finalUrl: string): HttpsReport {
  let isHttps = false;
  try {
    isHttps = new URL(finalUrl).protocol === "https:";
  } catch {
    isHttps = false;
  }
  return isHttps
    ? { ok: true, verified: true, checked: "verified_fetch", note: NOTE }
    : {
        ok: false,
        verified: false,
        checked: "verified_fetch",
        note: "the final URL is not https, so no certificate was involved",
      };
}

export interface HttpsOutcome {
  kind: "ok" | "unreachable";
  detail?: string;
  target: Target;
  report: HttpsReport;
}

/** The full posture check behind /v1/https. Two probes: https, then http. */
export async function checkHttps(host: string, settings: Settings): Promise<HttpsOutcome> {
  const target = await resolve(host);
  if (!target.ok) {
    return {
      kind: "unreachable",
      detail: target.reason,
      target,
      report: { ok: false, verified: false, checked: "verified_fetch", note: NOTE },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.checkTimeoutMs);

  try {
    let secure: Response;
    try {
      secure = await fetch(`https://${host}/`, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" },
      });
    } catch (error) {
      const kind = classifyFailure(error);
      if (kind === "tls") {
        return {
          kind: "ok",
          target,
          report: {
            ok: false,
            verified: false,
            checked: "verified_fetch",
            note: "the TLS handshake failed, so a browser would refuse this site too",
            error: String((error as Error)?.message ?? error),
          },
        };
      }
      // Unreachable is unreachable. We do not dress a timeout up as a bad certificate.
      return {
        kind: "unreachable",
        detail: kind,
        target,
        report: { ok: false, verified: false, checked: "verified_fetch", note: NOTE },
      };
    }

    const upgrade = await probeHttpUpgrade(host, controller.signal);

    return {
      kind: "ok",
      target,
      report: {
        ok: true,
        verified: true,
        checked: "verified_fetch",
        status: secure.status,
        upgrades_from_http: upgrade,
        hsts: Boolean((secure.headers.get("strict-transport-security") ?? "").trim()),
        note: NOTE,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeHttpUpgrade(host: string, signal: AbortSignal): Promise<UpgradeState> {
  try {
    const plain = await fetch(`http://${host}/`, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" },
    });
    const location = plain.headers.get("location") ?? "";
    const redirecting = plain.status >= 300 && plain.status < 400;
    if (redirecting && location.toLowerCase().startsWith("https://")) return "redirects_to_https";
    if (redirecting) {
      try {
        if (new URL(location, `http://${host}/`).protocol === "https:") return "redirects_to_https";
      } catch {
        /* a Location we cannot parse is not an upgrade */
      }
    }
    return "serves_http_without_redirect";
  } catch {
    // Nothing on port 80 is a fine answer, and a common one behind a CDN.
    return "no_http_listener";
  }
}
