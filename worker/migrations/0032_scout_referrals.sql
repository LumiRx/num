-- Who brought the expert — attribution, and a one-level override.
--
-- Written 18 Sep 2026. Until today nothing recorded how a NUM Expert arrived.
-- Isaiah and Adam were inserted by hand, the sign-up page had no referrer
-- field, and the page itself was calling an API on the wrong origin, so no
-- one had ever self-enrolled. Adding attribution now, before the first real
-- intake, is the only cheap moment: every row written from here carries it.
--
-- ── ONE LEVEL. NOT A CHAIN. ───────────────────────────────────────────────
--
-- An expert who brings another expert earns a share of what that person
-- earns, for a bounded term, and that is where it stops. The referrer's own
-- referrer earns nothing on the third person. This is a deliberate product
-- decision and a legal one: overrides that pay upward through unlimited
-- levels are the defining feature of the schemes the FTC prosecutes, and the
-- distance between "two levels" and "n levels" is one forgotten JOIN. There
-- is no parent pointer to walk here on purpose — referred_by_scout_id is
-- read once, never recursively, and worker/scouts.mjs asserts it.
--
-- ── VERIFIED REFERRER vs A NOTE ───────────────────────────────────────────
--
-- Two columns, never one. referred_by_scout_id is a real expert resolved from
-- a real code at sign-up: money can attach to it. referred_by_note is what
-- somebody typed — "Dre", "Instagram", "my cousin" — and money never attaches
-- to it. Collapsing the two into one text column is how a typed word that
-- happens to match a code becomes an invoice eighteen months later.
--
-- ── THE RATE IS LOCKED, LIKE EVERY OTHER RATE HERE ────────────────────────
--
-- referrer_share_bps is copied onto the recruit's row at sign-up and onto
-- each place at introduction, exactly as 0006 does for finder_cents and
-- share_bps, and for the same reason: people are owed what they were told.
-- Default 0 — an override only exists where one was deliberately granted, so
-- a row that predates this migration cannot silently start owing anybody.
--
-- referrer_ends_at bounds the liability. The override applies to places the
-- recruit INTRODUCES before that date. A place introduced inside the term
-- still pays out whenever it later activates, because the introduction is the
-- thing that was referred. Stamped at introduction, so what a place owes is
-- readable off the place and never recomputed from today's date.

ALTER TABLE num_scouts ADD COLUMN referred_by_scout_id TEXT REFERENCES num_scouts(id);
ALTER TABLE num_scouts ADD COLUMN referred_by_note     TEXT;
ALTER TABLE num_scouts ADD COLUMN referrer_share_bps   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE num_scouts ADD COLUMN referrer_ends_at     TEXT;

CREATE INDEX IF NOT EXISTS idx_scouts_referrer ON num_scouts(referred_by_scout_id);

-- Copied off the recruit at introduction. Null referrer means this place owes
-- nobody an override, which is the normal case.
ALTER TABLE num_scout_places ADD COLUMN referrer_scout_id  TEXT REFERENCES num_scouts(id);
ALTER TABLE num_scout_places ADD COLUMN referrer_share_bps INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_scout_places_referrer ON num_scout_places(referrer_scout_id);

-- ── widening the kind CHECK, which is why this is a rebuild ───────────────
--
-- SQLite cannot alter a CHECK constraint, and num_scout_earnings.kind is a
-- closed list that has no room for 'referrer_override'. The table is
-- therefore rebuilt — which is safe exactly once, today, because it holds
-- ZERO rows (verified against production 18 Sep 2026). After the first real
-- payout accrues, this same change would mean moving money between tables,
-- so the list below is written with the room it will need.
--
-- On a referrer_override row scout_id is the REFERRER and scout_place_id is
-- the RECRUIT's place. That is what makes UNIQUE (scout_place_id, kind,
-- period) mean "one override per place per month" and keeps the monthly job
-- safe to run twice, unchanged.

CREATE TABLE num_scout_earnings_new (
  id             TEXT PRIMARY KEY,
  scout_id       TEXT NOT NULL REFERENCES num_scouts(id),
  scout_place_id TEXT REFERENCES num_scout_places(id),

  kind           TEXT NOT NULL
                 CHECK (kind IN ('finder','commission_share','subscription_share',
                                 'referrer_override','adjustment')),

  currency       TEXT NOT NULL DEFAULT 'USD',
  gross_minor    INTEGER NOT NULL DEFAULT 0 CHECK (gross_minor >= 0),
  amount_minor   INTEGER NOT NULL           CHECK (amount_minor >= 0),

  period         TEXT,

  state          TEXT NOT NULL DEFAULT 'accrued'
                 CHECK (state IN ('accrued','payable','paid','void')),
  void_reason    TEXT,
  payout_ref     TEXT,
  accrued_at     TEXT NOT NULL DEFAULT (datetime('now')),
  payable_at     TEXT,
  paid_at        TEXT,

  CHECK (kind = 'adjustment' OR amount_minor <= gross_minor),
  UNIQUE (scout_place_id, kind, period)
);

INSERT INTO num_scout_earnings_new
  (id, scout_id, scout_place_id, kind, currency, gross_minor, amount_minor,
   period, state, void_reason, payout_ref, accrued_at, payable_at, paid_at)
SELECT
   id, scout_id, scout_place_id, kind, currency, gross_minor, amount_minor,
   period, state, void_reason, payout_ref, accrued_at, payable_at, paid_at
  FROM num_scout_earnings;

DROP TABLE num_scout_earnings;
ALTER TABLE num_scout_earnings_new RENAME TO num_scout_earnings;

CREATE INDEX IF NOT EXISTS idx_scout_earn_scout ON num_scout_earnings(scout_id, state);
