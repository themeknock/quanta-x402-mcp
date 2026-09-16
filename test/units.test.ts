/**
 * The parts that have no network and no database: scoring, the issue catalogue,
 * header reading, the raw-HTML parse, and the SSRF classifier.
 */

import { describe, expect, it } from "vitest";

import goodHtml from "./fixtures/good.html?raw";
import brokenHtml from "./fixtures/broken.html?raw";
import { readHeaders } from "../src/checks/headers";
import { NOT_HTML, RAW_ONLY, TRUNCATED, parseHtml } from "../src/checks/html";
import { classifyFailure, fromFetch } from "../src/checks/https";
import { classifyIp, validateUrl } from "../src/checks/ssrf";
import { CATALOG, WEIGHTS, gradeFor, issuesFor, score } from "../src/checks/verdict";
import { redactPayer } from "../src/usage";
import { requestHash } from "../src/idempotency";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("scoring", () => {
  it("is arithmetic, not a vibe: 100 minus the weight of each issue", () => {
    expect(score([]).score).toBe(100);
    expect(score(["NO_HSTS"]).score).toBe(92);
    expect(score(["HTTP_ERROR_STATUS"]).score).toBe(75);
    expect(score(["HTTP_ERROR_STATUS", "NO_CSP", "SLOW_TTFB"]).score).toBe(100 - 25 - 8 - 12);
  });

  it("floors at zero instead of going negative", () => {
    const everything = Object.keys(CATALOG);
    const total = everything.reduce((sum, code) => sum + WEIGHTS[CATALOG[code]!.severity], 0);
    expect(total).toBeGreaterThan(100);
    expect(score(everything).score).toBe(0);
    expect(score(everything).grade).toBe("F");
  });

  it("uses the documented grade boundaries", () => {
    expect(gradeFor(90)).toBe("A");
    expect(gradeFor(89)).toBe("B");
    expect(gradeFor(80)).toBe("B");
    expect(gradeFor(79)).toBe("C");
    expect(gradeFor(70)).toBe("C");
    expect(gradeFor(69)).toBe("D");
    expect(gradeFor(60)).toBe("D");
    expect(gradeFor(59)).toBe("F");
  });

  it("ignores a code it does not know rather than inventing a weight", () => {
    expect(score(["NOT_A_REAL_CODE"]).score).toBe(100);
    expect(score(["NOT_A_REAL_CODE"]).issues).toHaveLength(0);
  });
});

describe("issue detection", () => {
  const headers = { hsts: true, csp: true, x_frame_options: true, x_content_type_options: true };

  it("calls a 403 bot protection, not a broken site", () => {
    const codes = issuesFor({ status: 403 }, null, headers, null);
    expect(codes).toContain("BOT_PROTECTION_SUSPECTED");
    expect(codes).not.toContain("HTTP_ERROR_STATUS");
  });

  it("still calls a 500 a broken site", () => {
    expect(issuesFor({ status: 500 }, null, headers, null)).toContain("HTTP_ERROR_STATUS");
  });

  it("flags slow first byte only past the documented threshold", () => {
    expect(issuesFor({ status: 200, ttfb_ms: 1499 }, null, headers, null)).not.toContain("SLOW_TTFB");
    expect(issuesFor({ status: 200, ttfb_ms: 1501 }, null, headers, null)).toContain("SLOW_TTFB");
  });

  it("names every missing security header", () => {
    const codes = issuesFor(
      { status: 200 },
      null,
      { hsts: false, csp: false, x_frame_options: false, x_content_type_options: false },
      null,
    );
    expect(codes).toEqual(
      expect.arrayContaining(["NO_HSTS", "NO_CSP", "NO_X_FRAME_OPTIONS", "NO_X_CONTENT_TYPE_OPTIONS"]),
    );
  });
});

describe("raw HTML", () => {
  it("reads title, viewport and asset counts", async () => {
    const report = await parseHtml(bytes(goodHtml), {
      finalUrl: "https://example.com/",
      contentType: "text/html",
    });
    expect(report.checked).toBe(RAW_ONLY);
    expect(report.title).toEqual({ present: true, text: "Northgate Home Services" });
    expect(report.viewport.present).toBe(true);
    expect(report.stylesheets).toBe(1); // rel="preconnect" is not a stylesheet
    expect(report.scripts).toBe(1);
    expect(report.mixed_content.count).toBe(0);
  });

  it("finds mixed content on an https page", async () => {
    const report = await parseHtml(bytes(brokenHtml), {
      finalUrl: "https://example.com/",
      contentType: "text/html",
    });
    expect(report.title.present).toBe(false);
    expect(report.viewport.present).toBe(false);
    expect(report.mixed_content.count).toBe(2);
  });

  it("does not call http sub-resources on an http page mixed content", async () => {
    const report = await parseHtml(bytes(brokenHtml), {
      finalUrl: "http://example.com/",
      contentType: "text/html",
    });
    expect(report.mixed_content.count).toBe(0);
  });

  it("says so instead of guessing when the body is not HTML", async () => {
    const report = await parseHtml(bytes("{}"), {
      finalUrl: "https://example.com/data.json",
      contentType: "application/json",
    });
    expect(report.checked).toBe(NOT_HTML);
  });

  it("marks a truncated body as truncated, so the answer is not read as complete", async () => {
    const report = await parseHtml(bytes(goodHtml), {
      finalUrl: "https://example.com/",
      contentType: "text/html",
      truncated: true,
    });
    expect(report.checked).toBe(TRUNCATED);
  });
});

describe("headers", () => {
  it("is presence only, and is case-insensitive", () => {
    expect(readHeaders({ "Strict-Transport-Security": "max-age=31536000" }).hsts).toBe(true);
    expect(readHeaders({ "content-security-policy": "  " }).csp).toBe(false);
    expect(readHeaders({}).x_frame_options).toBe(false);
  });
});

describe("https reporting", () => {
  it("reports a completed https fetch as verified, with the platform caveat", () => {
    const report = fromFetch("https://example.com/");
    expect(report.verified).toBe(true);
    expect(report.note).toContain("expiry and issuer are not readable");
  });

  it("does not claim a certificate for a plain http final URL", () => {
    expect(fromFetch("http://example.com/").verified).toBe(false);
  });

  it("never dresses a timeout up as a certificate failure", () => {
    expect(classifyFailure(new Error("The operation was aborted"))).toBe("timeout");
    expect(classifyFailure(new Error("SSL peer certificate error"))).toBe("tls");
    expect(classifyFailure(new Error("something else entirely"))).toBe("connect");
  });
});

describe("ssrf classifier", () => {
  it.each([
    ["127.0.0.1", "loopback_address"],
    ["10.0.0.5", "private_address"],
    ["192.168.1.1", "private_address"],
    ["169.254.1.1", "link_local_address"],
    ["169.254.169.254", "metadata_address"],
    ["fd00:ec2::254", "metadata_address"],
    ["::ffff:127.0.0.1", "loopback_address"],
    ["0.0.0.0", "unspecified_address"],
    ["::1", "loopback_address"],
    ["100.64.0.1", "non_public_address"],
    ["240.0.0.1", "reserved_address"],
  ])("refuses %s as %s", (ip, reason) => {
    expect(classifyIp(ip)).toBe(reason);
  });

  it("lets a public address through", () => {
    expect(classifyIp("93.184.216.34")).toBe("");
    expect(classifyIp("2606:2800:220:1:248:1893:25c8:1946")).toBe("");
  });

  it("only accepts http and https", () => {
    expect(validateUrl("https://example.com/x").ok).toBe(true);
    expect(validateUrl("http://example.com/x").ok).toBe(true);
    expect(validateUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateUrl("gopher://example.com").ok).toBe(false);
    expect(validateUrl("not a url").ok).toBe(false);
  });
});

describe("audit hygiene", () => {
  it("stores a payer redacted, never in full", () => {
    expect(redactPayer("0x1111111111111111111111111111111111111111")).toBe("0x1111...1111");
    expect(redactPayer("")).toBe("");
  });

  it("hashes the request so the same key with a different target is detectable", async () => {
    const a = await requestHash("/v1/check", { url: "https://a.example" });
    const b = await requestHash("/v1/check", { url: "https://b.example" });
    expect(a).not.toBe(b);
    expect(await requestHash("/v1/check", { url: "https://a.example" })).toBe(a);
  });
});
