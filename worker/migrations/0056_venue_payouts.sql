-- 0056 — when the venue's money actually lands.
--
-- WHAT A VENUE CANNOT SEE TODAY
-- Under direct charges the money goes into the VENUE's own Stripe balance and
-- pays out on the VENUE's own schedule to the VENUE's own bank. That is the
-- whole design and it is not changing. What it costs is visibility: a venue
-- watches NUM bills settle and has nowhere that says what those bills came to
-- or when the money arrives, so the most common question a new venue asks --
-- "where is it" -- has no answer in the product.
--
-- THE HONEST SHAPE, AND WHY IT IS TWO NUMBERS AND NOT ONE
-- A Stripe payout is the venue's WHOLE balance. It carries their own card
-- sales, their own refunds and their own adjustments alongside anything that
-- came through NUM. So "your NUM money arrives Tuesday" would be false: the
-- payout is not NUM's and mostly is not from NUM. This table records the
-- payout as Stripe reports it, and the console shows it beside -- never added
-- to -- what NUM bills contributed, which NUM knows exactly from its own
-- settled bills. Two figures that mean different things stay two figures.
--
-- NUM never holds any of this money and cannot move, delay or accelerate it.
-- This is a record of something happening elsewhere.

CREATE TABLE IF NOT EXISTS num_business_payouts (
  id            TEXT PRIMARY KEY,          -- Stripe's payout id, on the venue's account
  business_id   TEXT NOT NULL,
  account_id    TEXT,                      -- the connected account it happened on
  amount_minor  INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  -- paid | in_transit | pending | failed | canceled, as Stripe reports it.
  -- Never inferred: a payout that failed must not read as arriving.
  status        TEXT NOT NULL,
  arrives_on    TEXT,                      -- Stripe's arrival_date, as a date
  failure       TEXT,                      -- the reason, when there is one
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_biz_payouts ON num_business_payouts(business_id, created_at);
