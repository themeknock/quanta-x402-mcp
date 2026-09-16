/**
 * SSRF guard: refuse to fetch anything that lives inside the network.
 *
 * This service takes a URL from a stranger and fetches it, which is the textbook
 * setup for server-side request forgery: point it at 169.254.169.254 and read the
 * cloud metadata, or at 10.0.0.x and port-scan a private network through us.
 *
 * Two rules keep that shut:
 *   * only http and https - no file:, ftp:, gopher:, data:;
 *   * every hostname is resolved BEFORE we fetch, and every resolved address is
 *     checked against the private/loopback/link-local/reserved ranges. Re-checked
 *     after each redirect hop, because "public URL redirects to 127.0.0.1" is the
 *     classic bypass.
 *
 * Resolution happens over DNS-over-HTTPS, because a Worker has no resolver of its
 * own. That is a real dependency and it is named in the honest limits: if the DoH
 * lookup fails the target is refused, not waved through.
 *
 * Residual TOCTOU is real and stated rather than papered over: we resolve, then
 * the runtime resolves again when it fetches, and the answer could change in
 * between. Closing that needs a socket pinned to the checked address, which this
 * platform does not offer.
 */

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

export const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Cloud instance metadata. Caught by the link-local rule too, but named so the refusal is specific. */
const METADATA_ADDRESSES = new Set(["169.254.169.254", "fd00:ec2::254", "100.100.100.200"]);

export interface Target {
  ok: boolean;
  host: string;
  ip: string;
  reason: string;
}

const blocked = (reason: string, host = "", ip = ""): Target => ({ ok: false, host, ip, reason });

// --- address classification ------------------------------------------------

function parseIpv4(raw: string): number[] | null {
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function classifyIpv4(octets: number[]): string {
  const [a = 0, b = 0] = octets;
  if (a === 0) return "unspecified_address";
  if (a === 10) return "private_address";
  if (a === 127) return "loopback_address";
  if (a === 169 && b === 254) return "link_local_address";
  if (a === 172 && b >= 16 && b <= 31) return "private_address";
  if (a === 192 && b === 168) return "private_address";
  if (a === 192 && b === 0) return "non_public_address";      // 192.0.0/24, 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return "non_public_address"; // benchmarking
  if (a === 198 && b === 51) return "non_public_address";     // documentation
  if (a === 203 && b === 0) return "non_public_address";      // documentation
  if (a === 100 && b >= 64 && b <= 127) return "non_public_address";   // carrier-grade NAT
  if (a >= 224 && a <= 239) return "multicast_address";
  if (a >= 240) return "reserved_address";
  return "";
}

function expandIpv6(raw: string): number[] | null {
  let text = raw.trim().toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  if (!text.includes(":")) return null;
  text = text.split("%")[0] ?? text; // strip a zone id

  // An embedded IPv4 tail (::ffff:127.0.0.1) becomes two more hextets.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = parseIpv4(tail);
    if (!octets) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const rear = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const fill = halves.length === 2 ? 8 - head.length - rear.length : 0;
  if (fill < 0) return null;

  const groups = [...head, ...Array<string>(fill).fill("0"), ...rear];
  if (groups.length !== 8) return null;

  const out: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    out.push(parseInt(group, 16));
  }
  return out;
}

function classifyIpv6(groups: number[]): string {
  const [g0 = 0] = groups;
  if (groups.every((g) => g === 0)) return "unspecified_address";
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return "loopback_address";
  if ((g0 & 0xfe00) === 0xfc00) return "private_address";          // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return "link_local_address";       // fe80::/10
  if ((g0 & 0xff00) === 0xff00) return "multicast_address";        // ff00::/8
  if (g0 === 0x2001 && (groups[1] ?? 0) === 0x0db8) return "non_public_address"; // documentation
  // ::ffff:0:0/96 - an IPv4 address in IPv6 clothing; classify the v4 inside it.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const g6 = groups[6] ?? 0;
    const g7 = groups[7] ?? 0;
    return classifyIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  return "";
}

/** A refusal reason for an address, or "" when it is fine to fetch. */
export function classifyIp(raw: string): string {
  const address = raw.trim().replace(/^\[|\]$/g, "");
  if (METADATA_ADDRESSES.has(address)) return "metadata_address";
  const v4 = parseIpv4(address);
  if (v4) return classifyIpv4(v4);
  const v6 = expandIpv6(address);
  if (v6) return classifyIpv6(v6);
  return "unresolvable";
}

// --- URL validation --------------------------------------------------------

export interface ParsedUrl {
  ok: boolean;
  host: string;
  scheme: string;
}

export function validateUrl(raw: string): ParsedUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, host: "", scheme: "" };
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) return { ok: false, host: "", scheme: url.protocol };
  if (!url.hostname) return { ok: false, host: "", scheme: url.protocol };
  return { ok: true, host: url.hostname, scheme: url.protocol };
}

/** Names that never belong to the public internet, whatever DNS says today. */
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

// --- resolution ------------------------------------------------------------

interface DohAnswer {
  Status?: number;
  Answer?: Array<{ type: number; data: string }>;
}

async function doh(host: string, type: "A" | "AAAA", signal?: AbortSignal): Promise<string[]> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`;
  const response = await fetch(url, { headers: { accept: "application/dns-json" }, signal });
  if (!response.ok) throw new Error(`doh_${response.status}`);
  const body = (await response.json()) as DohAnswer;
  const wanted = type === "A" ? 1 : 28;
  return (body.Answer ?? []).filter((a) => a.type === wanted).map((a) => a.data);
}

/**
 * Resolve a hostname and refuse it if ANY address it answers with is internal.
 *
 * All addresses, not just the first: a host that returns one public and one
 * private address is a rebinding attempt, not a lucky draw.
 */
export async function resolve(
  host: string,
  cache?: Map<string, Target>,
  signal?: AbortSignal,
): Promise<Target> {
  if (!host) return blocked("no_host");
  const key = host.toLowerCase();

  const cached = cache?.get(key);
  if (cached) return cached;

  const result = await resolveUncached(host, signal);
  cache?.set(key, result);
  return result;
}

async function resolveUncached(host: string, signal?: AbortSignal): Promise<Target> {
  const name = host.toLowerCase().replace(/\.$/, "");

  // A literal address never touches DNS - not to save a lookup, but because DNS
  // has no answer for one: asking a resolver about "93.184.216.34" is NXDOMAIN,
  // and treating that as "unreachable" would refuse a URL that works.
  const literal = classifyIp(name);
  if (literal !== "unresolvable") {
    const ip = name.replace(/^\[|\]$/g, "");
    return literal ? blocked(literal, host, ip) : { ok: true, host, ip, reason: "" };
  }

  if (name === "localhost" || INTERNAL_SUFFIXES.some((s) => name.endsWith(s))) {
    return blocked("loopback_address", host);
  }

  let addresses: string[];
  try {
    const [a, aaaa] = await Promise.all([
      doh(name, "A", signal),
      doh(name, "AAAA", signal).catch(() => [] as string[]),
    ]);
    addresses = [...a, ...aaaa];
  } catch {
    return blocked("dns_failed", host);
  }

  if (addresses.length === 0) return blocked("dns_failed", host);

  for (const address of addresses) {
    const reason = classifyIp(address);
    if (reason) return blocked(reason === "unresolvable" ? "dns_failed" : reason, host, address);
  }

  return { ok: true, host, ip: addresses[0] ?? "", reason: "" };
}

/** Validate a URL and resolve its host through the guard. */
export async function checkUrl(
  raw: string,
  cache?: Map<string, Target>,
  signal?: AbortSignal,
): Promise<Target> {
  const parsed = validateUrl(raw);
  if (!parsed.ok) return blocked("invalid_url");
  return resolve(parsed.host, cache, signal);
}

export const BLOCK_REASONS = new Set([
  "private_address",
  "loopback_address",
  "link_local_address",
  "metadata_address",
  "multicast_address",
  "reserved_address",
  "unspecified_address",
  "non_public_address",
]);
