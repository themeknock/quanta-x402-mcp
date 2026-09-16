/**
 * Token bucket per verified payer, stored in D1.
 *
 * Capacity 60, refill 1/s by default: an agent can burst sixty calls and then
 * sustain one a second. The bucket key is the payer address from the VERIFIED
 * payment payload - there is no API key to rotate and nothing to leak.
 *
 * Checked after verification and before settlement, so a caller who is over the
 * limit is refused without their money moving.
 */

export interface RateResult {
  allowed: boolean;
  retryAfterS: number;
}

export async function take(
  db: D1Database,
  payer: string,
  opts: { capacity: number; refillPerS: number; cost?: number },
): Promise<RateResult> {
  // No verified payer (unmetered dev mode) means no principal to meter. Do not
  // invent one: an IP is not the identity this service is built on.
  if (!payer) return { allowed: true, retryAfterS: 0 };

  const cost = opts.cost ?? 1;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const row = await db
    .prepare(`SELECT tokens, updated_at FROM rate_bucket WHERE payer = ?`)
    .bind(payer)
    .first<{ tokens: number; updated_at: string }>();

  let tokens: number;
  if (!row) {
    tokens = opts.capacity;
  } else {
    const elapsedS = Math.max(0, (now - Date.parse(row.updated_at)) / 1000);
    tokens = Math.min(opts.capacity, row.tokens + elapsedS * opts.refillPerS);
  }

  if (tokens < cost) {
    const retryAfterS =
      opts.refillPerS > 0 ? Math.max(1, Math.ceil((cost - tokens) / opts.refillPerS)) : 60;
    await write(db, payer, tokens, nowIso);
    return { allowed: false, retryAfterS };
  }

  await write(db, payer, tokens - cost, nowIso);
  return { allowed: true, retryAfterS: 0 };
}

async function write(db: D1Database, payer: string, tokens: number, ts: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO rate_bucket (payer, tokens, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (payer) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at`,
    )
    .bind(payer, tokens, ts)
    .run();
}
