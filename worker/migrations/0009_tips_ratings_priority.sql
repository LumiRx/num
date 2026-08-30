-- After the table: how was it, and would you like to leave something.
--
-- Written 26 Aug 2026. The Uber shape — one screen after the thing happened,
-- a rating and an optional tip — applied to a restaurant table.
--
-- ══ THE TIP RULE, WHICH IS NOT A PREFERENCE ═══════════════════════════════
--
-- A tip is the server's money. Two consequences, both absolute:
--
-- 1. NUM TAKES NOTHING FROM A TIP. Not a percentage, not a processing fee,
--    not a rounding. Under 29 U.S.C. §203(m)(2)(B) an employer, manager or
--    supervisor may not keep any portion of an employee's tips, and a
--    platform that skims them is not merely in breach — it is the story.
--    DoorDash used tips to offset its own guarantee and settled with the FTC
--    for $2.5M in 2020 having already had to unwind the model in public.
--    There is no version of that which is worth a few cents a table.
--
--    Enforced below by construction: num_tips has no commission column, no
--    fee column and no share column, and num_commissions may not reference a
--    tip row. There is nowhere to put the number even if somebody wanted to.
--
-- 2. NUM NEVER HOLDS THE TIP. Same reason every other table here has no card
--    or bank column: California B&P §17550.11 sizes a bond to money the
--    seller HOLDS, and money in transit for someone else is money
--    transmission. The tip settles on the venue's own rail — the bill QR
--    paylink that already exists — and this table records only that one was
--    left, how much, and which rail reference carried it. It is a receipt,
--    not a wallet.
--
-- ══ THE RATING RULE ═══════════════════════════════════════════════════════
--
-- A rating cannot be bought, and it cannot be earned by tipping. Those are
-- two different sentences and both matter:
--
--   * No amount of money moves a rating. There is no rate, plan or setting
--     that touches it, here or in num_business_settings.
--   * A tip does not imply a good rating and a rating does not imply a tip.
--     They are separate columns, either may be null, and neither is required
--     to submit the other. A five-star average that only exists because
--     tipping guests were the only ones asked is a fabricated number.
--
-- NUM's own ratings live apart from places.rating, which is crawled from the
-- open web. Merging them would let eleven of our ratings quietly overwrite
-- four hundred of Google's, and would present a thin sample with the
-- authority of a thick one. They are shown separately, and only once
-- MIN_RATINGS of them exist — see worker/commission.mjs.

-- ── how it was ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS num_ratings (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL,
  business_id   TEXT,
  place_id      TEXT,
  member_ref    TEXT,

  -- 1–5, the scale every guest already knows. Null is not a rating; a guest
  -- who only wanted to tip is not recorded as having said the food was fine.
  stars         INTEGER CHECK (stars IS NULL OR stars BETWEEN 1 AND 5),
  -- Free text, in the guest's own language. Shown to the venue, never
  -- published without the venue seeing it first.
  comment       TEXT,
  lang          TEXT,

  -- One rating per booking. A venue cannot ask a guest to rate again until
  -- they liked the answer, and a guest cannot brigade a venue from one meal.
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (booking_id)
);
CREATE INDEX IF NOT EXISTS idx_ratings_biz   ON num_ratings(business_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ratings_place ON num_ratings(place_id, created_at);

-- ── what was left for the server ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS num_tips (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL,
  business_id   TEXT,
  place_id      TEXT,

  amount_cs     INTEGER NOT NULL CHECK (amount_cs > 0),
  currency      TEXT NOT NULL DEFAULT 'usd',

  -- Who it is for, when the guest said. Free text on purpose: "the girl with
  -- the green hair" is how people actually name a server, and a dropdown of
  -- staff we do not employ would be worse data and a staffing record NUM has
  -- no business keeping.
  for_whom      TEXT,

  -- Where the money actually went. NUM does not carry it: this is the
  -- venue's own paylink or bill-QR reference, so a disputed tip can be traced
  -- on the rail that moved it. NOT a payment instrument — a reference to one
  -- that lives with the processor.
  rail          TEXT NOT NULL DEFAULT 'venue'
                CHECK (rail IN ('venue','paylink','cash','other')),
  rail_ref      TEXT,

  state         TEXT NOT NULL DEFAULT 'recorded'
                CHECK (state IN ('recorded','settled','failed','void')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at    TEXT,

  -- One tip per booking. A second is an edit, not another tip.
  UNIQUE (booking_id)
);
CREATE INDEX IF NOT EXISTS idx_tips_biz ON num_tips(business_id, created_at);

-- ── priority seating ──────────────────────────────────────────────────────
--
-- The guest pays to be seated sooner at a venue THEY ALREADY CHOSE. Up to
-- $20, only where the venue has switched it on, and the venue keeps 40%.
--
-- ══ WHAT THIS MUST NEVER BECOME ═══════════════════════════════════════════
--
-- This is one word away from paid placement, and the word is who pays.
--
--   guest pays for a better TABLE   → this feature
--   venue pays for a better RANK    → the thing NUM promises it does not do,
--                                     in writing, on the business page, with
--                                     a test that fails the build if that
--                                     page ever starts selling ranking
--
-- So priority seating must not touch recommendation order, must not touch
-- which venues are shown, and must not be a reason a venue appears at all. A
-- guest who declines it sees exactly the same list. Anything else and the
-- honest answer to "can I pay to be recommended" stops being no.
--
-- worker/priority.test.mjs fails the build if the fee or the flag reaches
-- ranking code.
ALTER TABLE num_business_settings
  ADD COLUMN f_priority_seating INTEGER NOT NULL DEFAULT 0
  CHECK (f_priority_seating IN (0,1));

-- The most a guest may be asked for, in minor units. $20.00 is the ceiling
-- Dre set and 0 means the venue has not set one; the code clamps to
-- PRIORITY_MAX_CS regardless, so a bad row cannot bill $200.
ALTER TABLE num_business_settings
  ADD COLUMN priority_max_cs INTEGER NOT NULL DEFAULT 0
  CHECK (priority_max_cs >= 0 AND priority_max_cs <= 2000);

-- The venue's share of that fee, in basis points. 4000 = 40%, locked per
-- business like every other rate here: a venue that was signed at 40% is not
-- moved to 25% by a code change six months later.
ALTER TABLE num_business_settings
  ADD COLUMN priority_share_bps INTEGER NOT NULL DEFAULT 4000
  CHECK (priority_share_bps BETWEEN 0 AND 10000);

-- ── what the venue is owed out of a priority fee ──────────────────────────
--
-- The mirror image of num_commissions: that table is what a venue owes NUM,
-- this is what NUM owes a venue. Kept apart on purpose — netting them would
-- produce one number nobody can audit, and "why is this month $14" is a
-- question a merchant is entitled to an answer to.
CREATE TABLE IF NOT EXISTS num_venue_payouts (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL,
  business_id   TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('priority_seating','adjustment')),

  -- What the guest paid, and the venue's slice of it.
  gross_cs      INTEGER NOT NULL CHECK (gross_cs >= 0),
  share_bps     INTEGER NOT NULL CHECK (share_bps BETWEEN 0 AND 10000),
  amount_cs     INTEGER NOT NULL CHECK (amount_cs >= 0),
  currency      TEXT NOT NULL DEFAULT 'usd',

  state         TEXT NOT NULL DEFAULT 'accrued'
                CHECK (state IN ('accrued','payable','paid','void')),
  void_reason   TEXT,
  payout_ref    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at       TEXT,

  -- NUM cannot owe a venue more than the guest paid. Same shape as the
  -- constraint on num_scout_earnings and for the same reason.
  CHECK (kind = 'adjustment' OR amount_cs <= gross_cs),
  -- One payout per booking per kind. The confirmation link gets tapped twice.
  UNIQUE (booking_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_venue_payouts_biz ON num_venue_payouts(business_id, state);
