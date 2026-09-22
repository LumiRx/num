-- eSIM: orders, the listing cache, text-menu state, supplier doorbell dedupe.
-- Money is integer US cents. Supplier cost is also kept in the supplier's own
-- units (cost_units) because that exact number is what an order must quote.

CREATE TABLE IF NOT EXISTS num_esim_orders (
  id                TEXT PRIMARY KEY,
  token             TEXT NOT NULL UNIQUE,
  state             TEXT NOT NULL CHECK (state IN ('quoted','checkout','paid','ordering','ready','refunding','refunded','attention','expired')),
  provider          TEXT NOT NULL,
  plan_code         TEXT NOT NULL,
  plan_label        TEXT NOT NULL,
  dest_label        TEXT NOT NULL,
  country           TEXT,
  airport           TEXT,
  region            TEXT,
  cost_units        INTEGER NOT NULL,
  cost_cs           INTEGER NOT NULL,
  price_cs          INTEGER NOT NULL CHECK (price_cs >= 50),
  currency          TEXT NOT NULL DEFAULT 'usd',
  channel           TEXT NOT NULL DEFAULT 'web',
  phone             TEXT,
  email             TEXT,
  name              TEXT,
  member_id         TEXT,
  sms_ok            INTEGER NOT NULL DEFAULT 0,
  marketing_ok      INTEGER NOT NULL DEFAULT 0,
  -- Evidence for the marketing box, kept only while it is ticked and only
  -- until payment: then it moves to num_sms_consent and is cleared here.
  consent_ip        TEXT,
  consent_ua        TEXT,
  consent_country   TEXT,
  ip_hash           TEXT,
  ref               TEXT,
  utm               TEXT,
  stripe_session    TEXT UNIQUE,
  stripe_url        TEXT,
  stripe_session_at TEXT,
  checkout_attempts INTEGER NOT NULL DEFAULT 0,
  stripe_pi         TEXT,
  paid_cs           INTEGER,
  provider_order_no TEXT,
  esim_tran_no      TEXT,
  iccid             TEXT,
  lpa               TEXT,
  qr_url            TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  sms_sent_at       TEXT,
  email_sent_at     TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at           TEXT,
  ordering_at       TEXT,
  ready_at          TEXT,
  refunded_at       TEXT,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_esim_orders_state ON num_esim_orders(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_esim_orders_phone ON num_esim_orders(phone, created_at);
CREATE INDEX IF NOT EXISTS idx_esim_orders_ip ON num_esim_orders(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_esim_orders_supplier ON num_esim_orders(provider_order_no);

CREATE TABLE IF NOT EXISTS num_esim_plans (
  provider             TEXT NOT NULL,
  code                 TEXT NOT NULL,
  name                 TEXT NOT NULL,
  scope                TEXT NOT NULL CHECK (scope IN ('local','regional','global')),
  countries            TEXT NOT NULL,
  data_mb              INTEGER,
  unlimited            INTEGER NOT NULL DEFAULT 0,
  days                 INTEGER NOT NULL,
  cost_units           INTEGER NOT NULL,
  cost_cs              INTEGER NOT NULL,
  retail_cs            INTEGER,
  price_cs             INTEGER NOT NULL,
  activate_within_days INTEGER,
  networks             TEXT,
  topup                INTEGER NOT NULL DEFAULT 0,
  refreshed_at         TEXT NOT NULL,
  PRIMARY KEY (provider, code)
);
CREATE INDEX IF NOT EXISTS idx_esim_plans_scope ON num_esim_plans(scope);

CREATE TABLE IF NOT EXISTS num_esim_countries (
  country      TEXT PRIMARY KEY,
  from_cs      INTEGER NOT NULL,
  plans        INTEGER NOT NULL,
  local_plans  INTEGER NOT NULL,
  refreshed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS num_esim_menus (
  phone      TEXT PRIMARY KEY,
  stage      TEXT NOT NULL CHECK (stage IN ('dest','pick')),
  data       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS num_esim_doorbell (
  notify_id   TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS num_esim_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS num_esim_text_usage (
  phone TEXT NOT NULL,
  day   TEXT NOT NULL,
  n     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (phone, day)
);
