-- 0052 — stay bookings.
--
-- The first table in this codebase that records a reservation NUM itself made.
--
-- Everything before it recorded a HAND-OFF: num_handoffs (a link minted),
-- num_travel_referrals (an agency quoting), num_booking_scan (which engine a
-- venue runs). In all of those the reservation lives somewhere else and NUM
-- holds a pointer to it. worker/liteapi.mjs changes that — prebook takes an
-- offer, book takes the room — so there is now a thing NUM is answerable for
-- and it needs a row.
--
-- ══ WHAT THIS TABLE MAY NOT HOLD ════════════════════════════════════════
--
-- No payment instrument. Not a card, not a token, not a billing address —
-- worker/staybookings.mjs REFUSES a write carrying one rather than dropping it
-- quietly, the same refusal travelreferral.mjs makes and for the same reason:
-- a field that is silently ignored is a field somebody later "fixes".
--
-- `transaction_id` is the exception that proves it. It is Nuitée's checkout
-- SESSION reference, minted by prebook and spent by book. It cannot be charged,
-- it expires, and without it the booking cannot be completed at all. A session
-- id is not an instrument.
--
-- The guest pays through Nuitée's SDK on their own device, Nuitée is merchant
-- of record, and NUM never holds the money. That is what keeps a California
-- seller-of-travel bond sized at zero (§17550.11, REFERRAL_STRUCTURE_ANALYSIS
-- §1), and it is the same promise every other rail here makes.
--
-- ══ WHY THE PRICES ARE STORED IN THREE PIECES ═══════════════════════════
--
-- `total_cs` is what the guest paid. `public_total_cs` is the supplier's stated
-- public price at the moment of booking. `margin_pct` is what NUM set.
--
-- Storing all three is what makes a member rate auditable a year later: whether
-- a member actually paid less than the public price on a given night is a fact
-- about that night, and the rates that would answer it are gone within twenty
-- minutes. A saving NUM cannot evidence is a saving NUM should not claim.
--
-- ══ WHY status IS DERIVED FROM EVENTS, NOT SET ══════════════════════════
--
-- bizstate.mjs made this argument on 19 Sep and it holds here: a status column
-- that is written by hand drifts from what happened. num_stay_events is the
-- truth and `status` is a cache of its last row, rebuildable by replay.

CREATE TABLE IF NOT EXISTS num_stay_bookings (
  id                TEXT PRIMARY KEY,           -- NUM's own id, uid('stay')
  member_id         TEXT NOT NULL,
  client_reference  TEXT NOT NULL,              -- idempotency key sent to the supplier
  prebook_id        TEXT,
  transaction_id    TEXT,                       -- checkout session, NOT an instrument
  booking_id        TEXT,                       -- the supplier's id, once confirmed
  supplier_booking_id TEXT,
  hotel_confirmation_code TEXT,                 -- what the front desk recognises

  hotel_id          TEXT,
  hotel_name        TEXT,
  room_name         TEXT,
  board_type        TEXT,
  checkin           TEXT NOT NULL,
  checkout          TEXT NOT NULL,
  adults            INTEGER NOT NULL DEFAULT 2,
  children_ages     TEXT,                       -- JSON array, ages not a count
  rooms             INTEGER NOT NULL DEFAULT 1,
  guest_nationality TEXT,

  currency          TEXT,
  total_cs          INTEGER,                    -- what the guest paid
  public_total_cs   INTEGER,                    -- the supplier's public price then
  margin_pct        REAL,                       -- what NUM set for this booking
  fees_at_hotel_cs  INTEGER DEFAULT 0,          -- excluded fees, owed at the desk
  was_member_rate   INTEGER NOT NULL DEFAULT 0,

  refundable        INTEGER,                    -- 1 / 0 / NULL when unknown
  cancel_by         TEXT,                       -- the deadline shown to the guest
  cancel_policy     TEXT,                       -- JSON, verbatim from the supplier

  status            TEXT NOT NULL DEFAULT 'held',  -- held → confirmed → cancelled | failed
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A guest's own bookings, newest first — the wallet's only query.
CREATE INDEX IF NOT EXISTS idx_stay_bookings_member
  ON num_stay_bookings (member_id, created_at DESC);

-- Idempotency has to be enforced by the database, not by a caller remembering.
-- A retried tap is the ordinary case on a phone with one bar, and the cost of
-- getting it wrong is a second room nobody wanted and a second charge.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stay_bookings_client_ref
  ON num_stay_bookings (client_reference);

-- Cancellation sweeps and "what is owed at the desk" both read by date.
CREATE INDEX IF NOT EXISTS idx_stay_bookings_checkin
  ON num_stay_bookings (checkin);

-- Every state change, append only. `status` above is a cache of the last row.
CREATE TABLE IF NOT EXISTS num_stay_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id    TEXT NOT NULL,
  event      TEXT NOT NULL,      -- held | price_moved | confirmed | cancelled | failed
  detail     TEXT,               -- JSON, with the supplier's words kept verbatim
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stay_events_stay
  ON num_stay_events (stay_id, id);
