/**
 * Tests run inside workerd, not in Node with a pile of shims.
 *
 * `@cloudflare/vitest-pool-workers` boots the same runtime `wrangler dev` and
 * production use, reading this project's own wrangler.toml, with a real local D1
 * behind the DB binding. HTMLRewriter, crypto.subtle and D1 are therefore the
 * real implementations - if a test passes here, the deployed Worker does the
 * same thing.
 *
 * Two test-only bindings: a receive address (a secret in production, so it is
 * not in wrangler.toml) and a three-token rate-limit bucket, so the limiter can
 * be shown refusing a caller without firing sixty requests at it.
 */

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          X402_EVM_ADDRESS: "0x000000000000000000000000000000000000dEaD",
          RATE_CAPACITY: "3",
          RATE_REFILL_PER_S: "0.0001",
        },
      },
    }),
  ],
});
