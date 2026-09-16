-- Quanta on D1. Three tables, no content table: the service checks live URLs and
-- holds no dataset.
--
-- Two rules the schema enforces on purpose:
--   * never store the full target URL (a query string can carry a token) - host only;
--   * never store the raw payment header.

CREATE TABLE IF NOT EXISTS usage_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                TEXT    NOT NULL,             -- ISO-8601 UTC
  surface           TEXT    NOT NULL,             -- 'http' | 'mcp'
  route             TEXT    NOT NULL,             -- '/v1/check' | 'check_url' ...
  target_host       TEXT    NOT NULL DEFAULT '',  -- host only
  network           TEXT    NOT NULL DEFAULT '',  -- 'eip155:84532'
  payer             TEXT    NOT NULL DEFAULT '',  -- from the VERIFIED payment payload
  amount            TEXT    NOT NULL DEFAULT '',
  tx_ref            TEXT    NOT NULL DEFAULT '',  -- settlement tx hash when available
  paid              INTEGER NOT NULL DEFAULT 0,
  idempotent_replay INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  verdict_hash      TEXT    NOT NULL DEFAULT '',  -- sha256 of the response body
  -- Correlation only. On the HTTP surface the SDK settles AFTER the handler has
  -- returned, so the row is written unpaid and the after-settle hook stamps the
  -- tx hash onto it. The payment nonce is the only id both sides can see; it is
  -- not a secret and it is not the payment header.
  payment_nonce     TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS usage_log_ts    ON usage_log (ts DESC);
CREATE INDEX IF NOT EXISTS usage_log_nonce ON usage_log (payment_nonce);

CREATE TABLE IF NOT EXISTS idempotency (
  payer        TEXT    NOT NULL,
  key          TEXT    NOT NULL,
  route        TEXT    NOT NULL,
  -- 'same key, different target' -> 409. The route name alone cannot tell two
  -- different targets apart, so the request is hashed.
  request_hash TEXT    NOT NULL DEFAULT '',
  body         TEXT    NOT NULL,                  -- JSON
  status_code  INTEGER NOT NULL,
  created_at   TEXT    NOT NULL,
  PRIMARY KEY (payer, key)
);

CREATE TABLE IF NOT EXISTS rate_bucket (
  payer      TEXT PRIMARY KEY,
  tokens     REAL NOT NULL,
  updated_at TEXT NOT NULL
);
