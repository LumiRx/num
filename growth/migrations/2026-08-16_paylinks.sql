-- Paylink QRs: scan at the table, pay the venue directly. NUM never touches
-- the money; these tables hold the codes and the meter, nothing financial.
-- Run BEFORE deploying the worker that references them:
--   cd ~/num-worktrees/app-main/growth
--   npx wrangler@latest d1 execute num-db --remote --file=./migrations/2026-08-16_paylinks.sql

CREATE TABLE IF NOT EXISTS num_paylinks (
  token          TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL,
  label          TEXT NOT NULL,
  kind           TEXT NOT NULL,              -- 'url' | 'promptpay'
  target         TEXT NOT NULL,              -- https URL, or PromptPay id digits
  promptpay_kind TEXT,                       -- 'phone' | 'tax_id' | 'ewallet'
  amount_mode    TEXT NOT NULL DEFAULT 'open',
  amount         TEXT,                       -- fixed amount as '250.00'
  currency       TEXT NOT NULL DEFAULT 'THB',
  zone_type      TEXT,
  state          TEXT NOT NULL DEFAULT 'active',
  created_at     TEXT,
  revoked_at     TEXT,
  revoked_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_paylinks_biz ON num_paylinks(business_id, state);

CREATE TABLE IF NOT EXISTS num_pay_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT NOT NULL,
  business_id TEXT NOT NULL,
  kind        TEXT NOT NULL,                 -- scan | tap_through | retired_view | unknown_token
  billable    INTEGER NOT NULL DEFAULT 0,    -- metered, never yet invoiced; no rate exists
  visitor_id  TEXT,
  ip_hash     TEXT,
  day         TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pay_events_biz_day ON num_pay_events(business_id, day);
CREATE INDEX IF NOT EXISTS idx_pay_events_tok ON num_pay_events(token, created_at);
