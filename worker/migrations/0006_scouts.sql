-- NUM Scouts — a person gets credited for a business they brought in.
--
-- Written 25 Aug 2026. Specification: claude/num-SCOUTS-PROGRAMME.md
--
-- ── WHAT THIS DOES NOT DO, AND WHY ────────────────────────────────────────
--
-- It does not create territories. "You own Bangkok" is an exclusivity promise
-- that has to be honoured, becomes a franchise territory the moment any fee
-- attaches, and — because NUM would be assigning areas — is the single
-- strongest fact against independent-contractor status in a misclassification
-- test. The unit here is one business. First scout to bring a business that
-- then VERIFIES is credited to it permanently.
--
-- The map in the app is therefore a record of what someone found, not a claim
-- on land. That is also the better product: Strava's map is where you ran, not
-- ground you own, and people find that more motivating rather than less.
--
-- ── NOTHING IS PAID FOR A SIGNATURE ───────────────────────────────────────
--
-- The finder's fee is NOT paid when a business verifies. It is paid when that
-- business has produced its first FINDER_GATE_MINOR (500 = $5.00) of revenue
-- to NUM.
--
-- Paying on verification sounds generous and is a trap. Verifying costs a
-- venue two minutes and proves nothing about whether it will ever take a NUM
-- guest, so the optimal strategy for a scout paid on verification is volume of
-- signatures: walk a street, get fifty owners to tap a link, collect $250, and
-- leave behind fifty listings nobody uses. NUM pays out real money and gets a
-- directory of dead entries — which is worse than nothing, because a
-- concierge that recommends places with no one behind them is a concierge
-- people stop trusting.
--
-- Gating on the venue's first $5 to NUM inverts it. NUM earns $2 flat on a
-- reservation, so the gate is roughly three real guests through the door: the
-- scout is only paid once the thing they were paid for has actually happened.
-- A scout who signs up fifty dead venues earns nothing; a scout who signs up
-- five live ones is paid in full. That is the same fee, pointed at the
-- outcome instead of the paperwork.
--
-- The recurring shares run from activation, not verification, for the same
-- reason: the clock should start when the business starts producing, so a
-- venue that takes four months to switch on does not silently burn a third of
-- the scout's term doing nothing.
--
-- ── NO PAYMENT INSTRUMENTS, ANYWHERE ─────────────────────────────────────
--
-- Same prohibition as 0003_travel_referrals.sql and 0004_hosts.sql, same
-- reason: California B&P §17550.11 sizes a seller-of-travel bond to money the
-- seller HOLDS, and NUM holds none. There is no card, bank, IBAN or wallet
-- column below. Payout destinations live with the payout provider, keyed by
-- scout id, and never here.

-- ── the scout ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS num_scouts (
  id            TEXT PRIMARY KEY,
  member_id     TEXT,                       -- links to a NUM account when they have one
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  email_lc      TEXT NOT NULL UNIQUE,
  phone         TEXT,
  country       TEXT,                       -- ISO-3166 alpha-2, drives payout + tax rules
  code          TEXT NOT NULL UNIQUE,       -- their referral code, printed on their card
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','paused','ended','blocked')),

  -- The terms they agreed to, and the proof. Never assume the current version:
  -- a scout who joined in August is owed August's terms.
  terms_version TEXT NOT NULL,
  agreed_at     TEXT NOT NULL,
  agreed_ip     TEXT,

  -- Rates LOCKED AT SIGN-UP, in basis points, same principle as
  -- num_biz_referrals.pct: people are owed what they were told.
  --   finder_cents   — flat, once the business has produced finder_gate_minor
  --   finder_gate_minor — how much revenue that business must produce first
  --   share_bps      — share of NUM's commission on percentage-rate categories
  --   sub_share_bps  — share of net subscription revenue from their businesses
  --   term_months    — how long the two recurring shares run, per business
  finder_cents  INTEGER NOT NULL DEFAULT 500  CHECK (finder_cents  >= 0 AND finder_cents  <= 5000),
  -- $5.00. Locked at sign-up like every other rate: a scout who joined when
  -- the gate was $5 is not moved to a $20 gate later. 0 would mean "pay on
  -- verification", which is the thing this exists to prevent, so it is barred.
  finder_gate_minor INTEGER NOT NULL DEFAULT 500
                CHECK (finder_gate_minor > 0 AND finder_gate_minor <= 100000),
  share_bps     INTEGER NOT NULL DEFAULT 2000 CHECK (share_bps     >= 0 AND share_bps     <= 5000),
  sub_share_bps INTEGER NOT NULL DEFAULT 2000 CHECK (sub_share_bps >= 0 AND sub_share_bps <= 5000),
  term_months   INTEGER NOT NULL DEFAULT 24   CHECK (term_months   >  0),

  -- Fraud ceiling. An uncapped programme is an uncapped liability, and this is
  -- open to anyone on the internet. NULL means "use the programme default",
  -- which is NOT the same as 0 — 0 would silently mean "this scout earns
  -- nothing" and must only ever be set deliberately.
  monthly_claim_cap INTEGER,

  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT,

  -- The programme cannot be configured into a loss. A finder's fee is only
  -- ever released once the business has produced at least finder_gate_minor,
  -- so a fee larger than the gate would be NUM paying out more than it took
  -- in from that business — the exact thing the earnings CHECK below exists to
  -- forbid. Enforced here, at the point the rates are set.
  --
  -- Table-level, and therefore last: SQLite requires every table constraint to
  -- follow every column definition, and putting this in the middle of the
  -- column list is a syntax error that takes the whole migration down.
  CHECK (finder_cents <= finder_gate_minor)
);
CREATE INDEX IF NOT EXISTS idx_scouts_code   ON num_scouts(code);
CREATE INDEX IF NOT EXISTS idx_scouts_member ON num_scouts(member_id);

-- ── one business, one scout, forever ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS num_scout_places (
  id          TEXT PRIMARY KEY,
  scout_id    TEXT NOT NULL REFERENCES num_scouts(id),

  -- place_id is what makes the map possible at all. Today claims.place_id is
  -- NULL on every row in production, which is why a scout map would currently
  -- plot nothing: a claim is not yet bound to a place, so it has no
  -- coordinates. Binding it is the prerequisite for this whole feature.
  place_id    TEXT NOT NULL,
  claim_id    INTEGER,                      -- claims.id once the business verifies
  biz_name    TEXT NOT NULL,                -- snapshot: the listing may be renamed later
  dest        TEXT,
  country     TEXT,
  lat         REAL,
  lng         REAL,

  -- introduced → the scout brought them
  -- verified   → the business confirmed its listing. Earns nothing yet.
  -- activated  → the business has produced finder_gate_minor of revenue to
  --              NUM. THIS is the state that pays the finder's fee and starts
  --              the term clock for the two recurring shares.
  -- rejected   → the introduction was not accepted (duplicate, bad faith)
  -- void       → reversed after the fact; void_reason says why
  state       TEXT NOT NULL DEFAULT 'introduced'
              CHECK (state IN ('introduced','verified','activated','rejected','void')),
  void_reason TEXT,

  -- Running total of what NUM has actually collected from this business, in
  -- minor units. The gate is measured against this, and it keeps counting
  -- afterwards because it is also how a scout sees a place earning on the map.
  revenue_minor INTEGER NOT NULL DEFAULT 0 CHECK (revenue_minor >= 0),
  -- Copied off the scout at introduction, like every other rate here.
  finder_gate_minor INTEGER NOT NULL DEFAULT 500 CHECK (finder_gate_minor > 0),

  -- The rates that applied to THIS place, copied off the scout at introduction.
  -- Denormalised on purpose. If the programme rate changes next year, every
  -- existing row still knows what it promised.
  finder_cents  INTEGER NOT NULL,
  share_bps     INTEGER NOT NULL,
  sub_share_bps INTEGER NOT NULL,
  -- Set on ACTIVATION, not verification: activated_at + term_months. The
  -- clock starts when the business starts producing, so a venue that takes
  -- four months to switch on does not burn a sixth of the scout's term idle.
  term_ends_at  TEXT,

  introduced_at TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at   TEXT,
  activated_at  TEXT,                       -- when revenue_minor first crossed the gate

  -- The whole first-come rule, enforced by the database rather than by code
  -- that might one day forget. A second scout introducing the same place gets
  -- a constraint violation, not a duplicate payout.
  UNIQUE (place_id)
);
CREATE INDEX IF NOT EXISTS idx_scout_places_scout ON num_scout_places(scout_id, state);
CREATE INDEX IF NOT EXISTS idx_scout_places_claim ON num_scout_places(claim_id);
-- The activation sweep: verified places waiting on the gate. Without this the
-- job that looks for "who crossed $5 today" scans every place a scout ever
-- introduced, forever.
CREATE INDEX IF NOT EXISTS idx_scout_places_gate
  ON num_scout_places(state, place_id) WHERE state = 'verified';

-- ── what a scout is owed ──────────────────────────────────────────────────
--
-- Deliberately the same state machine as num_host_earnings, including the
-- constraint that matters most: NUM cannot owe out more than it took in.
CREATE TABLE IF NOT EXISTS num_scout_earnings (
  id             TEXT PRIMARY KEY,
  scout_id       TEXT NOT NULL REFERENCES num_scouts(id),
  scout_place_id TEXT REFERENCES num_scout_places(id),

  kind           TEXT NOT NULL
                 CHECK (kind IN ('finder','commission_share','subscription_share','adjustment')),

  -- What NUM actually collected on this event, and the slice of it owed on.
  -- A finder fee carries gross too, now that it is released only after the
  -- business has produced finder_gate_minor: gross_minor is the revenue that
  -- opened the gate. That is what lets the check at the bottom of this table
  -- cover the finder fee as well, instead of exempting it.
  currency       TEXT NOT NULL DEFAULT 'USD',
  gross_minor    INTEGER NOT NULL DEFAULT 0 CHECK (gross_minor >= 0),
  amount_minor   INTEGER NOT NULL           CHECK (amount_minor >= 0),

  -- Which month a recurring share belongs to, so a re-run cannot double-pay.
  period         TEXT,                      -- 'YYYY-MM' for the two recurring kinds

  state          TEXT NOT NULL DEFAULT 'accrued'
                 CHECK (state IN ('accrued','payable','paid','void')),
  void_reason    TEXT,
  payout_ref     TEXT,
  accrued_at     TEXT NOT NULL DEFAULT (datetime('now')),
  payable_at     TEXT,
  paid_at        TEXT,

  -- Nothing owed may exceed what was collected — the finder fee included,
  -- which is the whole point of gating it on the business's first $5. Only a
  -- manual adjustment is exempt, because a correction has no gross of its own.
  CHECK (kind = 'adjustment' OR amount_minor <= gross_minor),
  -- One row per place per kind per month. This is what makes the monthly job
  -- safe to run twice.
  UNIQUE (scout_place_id, kind, period)
);
CREATE INDEX IF NOT EXISTS idx_scout_earn_scout ON num_scout_earnings(scout_id, state);

-- ── the terms a scout accepted ────────────────────────────────────────────
--
-- Stored, not linked. A URL can be edited; what someone agreed to cannot be.
CREATE TABLE IF NOT EXISTS num_scout_terms (
  version     TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
