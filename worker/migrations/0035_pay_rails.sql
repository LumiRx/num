-- 0035 — how a venue is paid through NUM: its connected Stripe account, the
-- rails it has switched off, and the Stripe references on a paid bill.
--
-- WHY A NEW TABLE AND NOT COLUMNS ON businesses
-- worker/payrails.mjs reads this on every /p/<token> pay page. If it read a
-- new column on `businesses`, every pay page in production would 500 between
-- the code shipping and this migration running (the exact failure
-- migrationhygiene.test.mjs documents for /api/host/requests). A separate
-- table can be read behind a single-row fallback — missing table means "no
-- venue is connected yet", which is the truth — so the code is safe to ship
-- first and this can run after.
--
-- stripe_account_id is the venue's OWN Stripe account (Standard, connected by
-- OAuth from the console). Charges are created ON that account and NUM takes an
-- application fee. NUM never holds the money. See payrails.mjs header.

CREATE TABLE IF NOT EXISTS num_business_rails (
  business_id              TEXT PRIMARY KEY,
  stripe_account_id        TEXT,
  stripe_charges_enabled   INTEGER NOT NULL DEFAULT 0 CHECK (stripe_charges_enabled IN (0,1)),
  stripe_country           TEXT,
  stripe_default_currency  TEXT,
  rails_off                TEXT NOT NULL DEFAULT '[]',
  connected_at             TEXT,
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A bill code paid through Stripe carries the session and the intent, so the
-- receipt, the refund and the dispute can all be found from the token.
ALTER TABLE num_paylinks ADD COLUMN checkout_session_id TEXT;
ALTER TABLE num_paylinks ADD COLUMN payment_intent_id TEXT;
-- Which approved rail settled it: 'card', 'pay_by_bank', 'promptpay_sticker', 'usdc_direct' …
ALTER TABLE num_paylinks ADD COLUMN charged_via TEXT;
-- What NUM took at source, in the bill's minor units. NULL = collected the old way (invoiced).
ALTER TABLE num_paylinks ADD COLUMN application_fee_minor INTEGER;
