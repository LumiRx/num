-- Milestones an Expert reaches, and the bonus machinery behind them.
--
-- Written 18 Sep 2026, on Dre's call: build the whole thing now with every
-- cash rate at zero, so recognition works tonight and switching money on
-- later is one number rather than a rebuild.
--
-- ── AWARDED ONCE, EVER ────────────────────────────────────────────────────
--
-- UNIQUE (scout_id, key) is the load-bearing line. The checker runs on every
-- activation, so without it a milestone pays again every time somebody's
-- eleventh venue produces revenue. A bonus that pays twice is not a bug
-- people report. It is a bug people keep quiet about, and it is found in an
-- audit months later.
--
-- ── A BONUS IS FUNDED BY REAL REVENUE, OR IT IS RECOGNITION ───────────────
--
-- A milestone row is always written when it is reached, because the badge
-- costs nothing and is the point of the feature. The EARNINGS row beside it
-- is written only when the bonus is both configured above zero and covered by
-- what those venues actually produced to NUM.
--
-- That is why 'milestone' below is NOT added to the adjustment exemption in
-- num_scout_earnings. A milestone bonus carries a gross — the revenue of the
-- venues that qualified it — so the existing CHECK keeps meaning what it has
-- always meant: NUM cannot owe out more than it took in. A bonus that cannot
-- be covered is recorded as reached with bonus_cents = 0 rather than quietly
-- paid out of nothing.
--
-- ── WHY THE THRESHOLD IS COPIED ONTO THE ROW ──────────────────────────────
--
-- Same principle as every rate in 0006 and 0032: if "ten venues" becomes
-- "fifteen venues" next quarter, the person who already reached ten keeps
-- what they reached. The row records what it took on the day.

CREATE TABLE IF NOT EXISTS num_scout_milestones (
  id          TEXT PRIMARY KEY,
  scout_id    TEXT NOT NULL REFERENCES num_scouts(id),

  -- The programme's name for it, e.g. 'first_activation', 'live_10'.
  -- Definitions live in worker/scoutmilestones.mjs. This is the record that
  -- one was reached, which must outlive any edit to that list.
  key         TEXT NOT NULL,
  label       TEXT NOT NULL,              -- what it was called when reached
  threshold   INTEGER NOT NULL,           -- what it took, copied at award
  reached_at  TEXT NOT NULL DEFAULT (datetime('now')),

  -- Zero unless a funded bonus was configured AND covered by real revenue.
  bonus_cents INTEGER NOT NULL DEFAULT 0
              CHECK (bonus_cents >= 0 AND bonus_cents <= 100000),
  -- The earnings row that carries the money, when there is money. NULL is the
  -- normal case and means recognition only — never "payment pending".
  earning_id  TEXT REFERENCES num_scout_earnings(id),

  UNIQUE (scout_id, key)
);
CREATE INDEX IF NOT EXISTS idx_scout_milestones_scout
  ON num_scout_milestones(scout_id, reached_at);

-- ── widening the kind CHECK, for the last time it is free ─────────────────
--
-- num_scout_earnings still holds ZERO rows (verified against production
-- immediately before writing this). That is the only reason this rebuild is
-- safe, and it will not be true again — the first activation writes a row and
-- from then on this same change means moving money between tables.
--
-- So 'milestone' goes in now, while it costs nothing, rather than when it is
-- needed.

CREATE TABLE num_scout_earnings_new (
  id             TEXT PRIMARY KEY,
  scout_id       TEXT NOT NULL REFERENCES num_scouts(id),
  scout_place_id TEXT REFERENCES num_scout_places(id),

  kind           TEXT NOT NULL
                 CHECK (kind IN ('finder','commission_share','subscription_share',
                                 'referrer_override','milestone','adjustment')),

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
