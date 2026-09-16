/**
 * Idempotency: (verified payer, Idempotency-Key) -> the body we already returned.
 *
 * The payment is the identity, so the key space is per payer - one agent cannot
 * read or clobber another agent's cached answer by guessing a key.
 *
 * Honest note about cost, because it is not what people assume: a replay does not
 * repeat the *work*, but it still costs the caller a payment. On HTTP the SDK
 * middleware verifies and settles around the handler and we do not reach inside
 * it; on MCP we settle for the same reason, so the price of a call does not
 * depend on which transport the agent happened to use.
 */

export const MAX_KEY_LEN = 128;
const TTL_MS = 24 * 60 * 60 * 1000;

export type Outcome =
  | { kind: "miss" }
  | { kind: "hit"; body: unknown; statusCode: number }
  | { kind: "conflict" };

/**
 * A stable fingerprint of "what was asked for".
 *
 * Keys are sorted into an array rather than passed to JSON.stringify's second
 * argument: that argument is a property *whitelist*, and a whitelist of the
 * top-level keys silently drops every nested param - which would make two
 * different URLs on the same route hash identically and defeat the 409 rule.
 */
export async function requestHash(route: string, params: Record<string, string>): Promise<string> {
  const entries = Object.keys(params)
    .sort()
    .map((key) => [key, params[key] ?? ""]);
  const canonical = JSON.stringify([route, entries]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Drop rows past the TTL. Done on access, so there is no cron to forget about. */
async function prune(db: D1Database): Promise<void> {
  const cutoff = new Date(Date.now() - TTL_MS).toISOString();
  await db.prepare(`DELETE FROM idempotency WHERE created_at < ?`).bind(cutoff).run();
}

export async function lookup(
  db: D1Database,
  payer: string,
  key: string,
  route: string,
  hash: string,
): Promise<Outcome> {
  if (!payer || !key) return { kind: "miss" };
  await prune(db);
  const row = await db
    .prepare(`SELECT route, request_hash, body, status_code FROM idempotency WHERE payer = ? AND key = ?`)
    .bind(payer, key.slice(0, MAX_KEY_LEN))
    .first<{ route: string; request_hash: string; body: string; status_code: number }>();

  if (!row) return { kind: "miss" };
  if (row.route !== route || row.request_hash !== hash) return { kind: "conflict" };
  return { kind: "hit", body: JSON.parse(row.body), statusCode: row.status_code };
}

export async function remember(
  db: D1Database,
  payer: string,
  key: string,
  route: string,
  hash: string,
  body: unknown,
  statusCode = 200,
): Promise<void> {
  if (!payer || !key) return;
  await db
    .prepare(
      `INSERT INTO idempotency (payer, key, route, request_hash, body, status_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (payer, key) DO UPDATE SET
         route = excluded.route,
         request_hash = excluded.request_hash,
         body = excluded.body,
         status_code = excluded.status_code,
         created_at = excluded.created_at`,
    )
    .bind(
      payer,
      key.slice(0, MAX_KEY_LEN),
      route,
      hash,
      JSON.stringify(body),
      statusCode,
      new Date().toISOString(),
    )
    .run();
}
