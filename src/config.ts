/**
 * One place reads the environment. Everything else takes a `Settings`.
 *
 * Workers hands env vars in as strings (there is no .env parsing at runtime), so
 * every number and boolean is coerced here, once, with a documented default.
 */

export interface Env {
  DB: D1Database;

  // [vars] in wrangler.toml
  X402_ENABLED?: string;
  X402_FACILITATOR_URL?: string;
  X402_PRICE?: string;
  X402_ENABLE_SVM?: string;
  CHECK_TIMEOUT_S?: string;
  CHECK_MAX_BYTES?: string;
  CHECK_MAX_REDIRECTS?: string;
  RATE_CAPACITY?: string;
  RATE_REFILL_PER_S?: string;
  DEMO_ALLOWLIST?: string;
  PUBLIC_BASE_URL?: string;

  // secrets
  X402_EVM_ADDRESS?: string;
  X402_SVM_ADDRESS?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
}

export interface Settings {
  x402Enabled: boolean;
  facilitatorUrl: string;
  price: string;
  enableSvm: boolean;
  evmAddress: string;
  svmAddress: string;
  checkTimeoutMs: number;
  checkMaxBytes: number;
  checkMaxRedirects: number;
  rateCapacity: number;
  rateRefillPerS: number;
  demoAllowlist: string[];
  publicBaseUrl: string;
}

const num = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const bool = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === "true" || raw === "1";
};

export function settingsFrom(env: Env): Settings {
  return {
    x402Enabled: bool(env.X402_ENABLED, true),
    facilitatorUrl: env.X402_FACILITATOR_URL || "https://www.x402.org/facilitator",
    price: env.X402_PRICE || "$0.001",
    enableSvm: bool(env.X402_ENABLE_SVM, false),
    // No default address. An unset receive address is a misconfiguration we want
    // to fail loudly on, not quietly paper over with a zero address.
    evmAddress: env.X402_EVM_ADDRESS || "",
    svmAddress: env.X402_SVM_ADDRESS || "",
    checkTimeoutMs: num(env.CHECK_TIMEOUT_S, 10) * 1000,
    checkMaxBytes: num(env.CHECK_MAX_BYTES, 2_097_152),
    checkMaxRedirects: num(env.CHECK_MAX_REDIRECTS, 5),
    rateCapacity: num(env.RATE_CAPACITY, 60),
    rateRefillPerS: num(env.RATE_REFILL_PER_S, 1),
    demoAllowlist: (env.DEMO_ALLOWLIST || "themeknock.net,example.com")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    publicBaseUrl: env.PUBLIC_BASE_URL || "http://localhost:8787",
  };
}

export const ENGINE = "quanta/0.3.0";
export const USER_AGENT = "QuantaCheck/0.3 (+https://quanta.themeknock.net/bot)";
