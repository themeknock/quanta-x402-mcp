/** The audit log. One place writes usage_log; both surfaces use it. */

export interface UsageRow {
  surface: "http" | "mcp";
  route: string;
  targetHost?: string;
  network?: string;
  payer?: string;
  amount?: string;
  txRef?: string;
  paid?: boolean;
  idempotentReplay?: boolean;
  durationMs?: number;
  verdictHash?: string;
  paymentNonce?: string;
}

/**
 * sha256 of a response body. Lets a caller prove a replay returned the same
 * bytes without the log holding the body.
 */
export async function bodyHash(body: unknown): Promise<string> {
  const canonical = JSON.stringify(body, Object.keys(body as object).sort());
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The public audit trail shows the first 6 and last 4 characters of an address. */
export function redactPayer(payer: string): string {
  if (!payer || payer.length <= 10) return payer;
  return `${payer.slice(0, 6)}...${payer.slice(-4)}`;
}

export async function logUsage(db: D1Database, row: UsageRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage_log
         (ts, surface, route, target_host, network, payer, amount, tx_ref,
          paid, idempotent_replay, duration_ms, verdict_hash, payment_nonce)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      new Date().toISOString(),
      row.surface,
      row.route,
      row.targetHost ?? "",
      row.network ?? "",
      row.payer ?? "",
      row.amount ?? "",
      row.txRef ?? "",
      row.paid ? 1 : 0,
      row.idempotentReplay ? 1 : 0,
      row.durationMs ?? 0,
      row.verdictHash ?? "",
      row.paymentNonce ?? "",
    )
    .run();
}

/**
 * Stamp the settlement onto the row the HTTP route already wrote.
 *
 * The route cannot know the tx hash: the SDK middleware settles after the handler
 * returns. So the row goes in unpaid and this runs from the settlement stamp,
 * matching on the payment nonce, which is unique per payment and visible on both
 * sides.
 */
export async function markSettled(
  db: D1Database,
  nonce: string,
  opts: { txRef: string; payer?: string; network?: string },
): Promise<void> {
  if (!nonce) return;
  await db
    .prepare(
      `UPDATE usage_log
          SET paid = 1,
              tx_ref = ?,
              payer = CASE WHEN ? <> '' THEN ? ELSE payer END,
              network = CASE WHEN ? <> '' THEN ? ELSE network END
        WHERE payment_nonce = ? AND paid = 0`,
    )
    .bind(
      opts.txRef,
      opts.payer ?? "",
      opts.payer ?? "",
      opts.network ?? "",
      opts.network ?? "",
      nonce,
    )
    .run();
}

export async function recentUsage(db: D1Database, limit = 25): Promise<unknown[]> {
  const capped = Math.max(1, Math.min(limit, 200));
  const { results } = await db
    .prepare(
      `SELECT ts, surface, route, target_host, network, payer, amount, tx_ref,
              paid, idempotent_replay, duration_ms, verdict_hash
         FROM usage_log ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .bind(capped)
    .all<Record<string, unknown>>();

  return (results ?? []).map((r) => ({
    ts: r.ts,
    surface: r.surface,
    route: r.route,
    target_host: r.target_host,
    network: r.network,
    payer: redactPayer(String(r.payer ?? "")),
    amount: r.amount,
    tx_ref: r.tx_ref,
    paid: r.paid === 1,
    idempotent_replay: r.idempotent_replay === 1,
    duration_ms: r.duration_ms,
    verdict_hash: r.verdict_hash,
  }));
}
