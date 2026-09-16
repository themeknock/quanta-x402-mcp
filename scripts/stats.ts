/**
 * The numbers for the README, measured - never typed.
 *
 * Reads the live D1 audit log through wrangler and prints paid calls, unique
 * payers, p50/p95 duration, the replay ratio and the unreachable-target ratio,
 * with the date it ran. The README quotes this output and says when it was run;
 * if the numbers are stale, that is visible rather than hidden.
 *
 *   npm run stats              # remote (production D1)
 *   npm run stats -- --local   # the local dev database
 */

import { execFileSync } from "node:child_process";

interface Row {
  paid: number;
  payer: string;
  duration_ms: number;
  idempotent_replay: number;
  route: string;
  verdict_hash: string;
}

const local = process.argv.includes("--local");

function query<T>(sql: string): T[] {
  const output = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "quanta", local ? "--local" : "--remote", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const parsed = JSON.parse(output) as Array<{ results: T[] }>;
  return parsed[0]?.results ?? [];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

const rows = query<Row>(
  "SELECT paid, payer, duration_ms, idempotent_replay, route, verdict_hash FROM usage_log",
);

if (rows.length === 0) {
  console.log(`quanta stats (${local ? "local" : "remote"}) - ${new Date().toISOString().slice(0, 10)}`);
  console.log("no calls recorded yet");
  process.exit(0);
}

const paid = rows.filter((r) => r.paid === 1);
const payers = new Set(paid.map((r) => r.payer).filter(Boolean));
const durations = rows.map((r) => r.duration_ms).filter((d) => d > 0);
const replays = rows.filter((r) => r.idempotent_replay === 1).length;
// A row with no verdict hash is a call that never produced a verdict: the target
// was unreachable or refused by the guard.
const noVerdict = rows.filter((r) => !r.verdict_hash).length;

const pct = (n: number) => `${((n / rows.length) * 100).toFixed(1)}%`;

console.log(`quanta stats (${local ? "local" : "remote"}) - run ${new Date().toISOString().slice(0, 10)}`);
console.log(`  calls logged        ${rows.length}`);
console.log(`  paid calls          ${paid.length}`);
console.log(`  unique payers       ${payers.size}`);
console.log(`  duration p50 / p95  ${percentile(durations, 50)} ms / ${percentile(durations, 95)} ms`);
console.log(`  idempotent replays  ${replays} (${pct(replays)})`);
console.log(`  no verdict returned ${noVerdict} (${pct(noVerdict)})`);
