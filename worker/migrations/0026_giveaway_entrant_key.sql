-- 0026 — one identity for a draw entry, so both doors count one person once.
--
-- WHAT WAS WRONG, LIVE, IN 0.8.290
--
-- Two sessions built the Friday draw in parallel. 0023 shipped an entries table
-- keyed (phone, week_start). worker/giveaway.mjs writes that shape and works.
-- worker/packdraw.mjs, wired into the app's own reply path, writes
-- (week_key, member_id) — columns that do not exist — so EVERY in-app entry
-- failed. growth/fridaydraw.mjs reads week_key too, and inserts a draw row with
-- drawn_at/period_start/period_end against a table that has week_start, so the
-- draw could not have run even with a route.
--
-- Each of those files carries its own CREATE TABLE IF NOT EXISTS for the shape
-- it wants. The table already existed, so those statements were silent no-ops —
-- the same failure that hid booking_fee_minor for weeks.
--
-- WHY A NEW TABLE RATHER THAN AN ALTER
--
-- The entry identity has to change, not just gain a column. 0023 made `phone`
-- NOT NULL, and 107 of 147 members (73%) have no phone at all — that number is
-- from the 12 Sep contact audit and is the reason a phone-keyed draw is not an
-- option. A member with only an email must be able to enter, and the same human
-- texting PACKS and sending PACKS in the app must still be ONE entry, or the
-- draw is not fair and cannot be defended.
--
-- So the key is `entrant_key`:
--
--     phone:+447700900123     anyone we know a number for, whichever door
--     member:mem_abc123       a member with no number on file
--
-- An in-app entry resolves the member's phone FIRST, so somebody who has both
-- collapses onto the phone key and cannot hold two tickets.
--
-- Nothing here drops or renames anything. 0023's tables are left exactly as
-- they are, their rows copied forward by id, so a bad apply costs nothing and
-- can be re-run. Retiring them is a separate decision once this is proven.
--
-- EVERY STATEMENT STANDS ALONE and every one is IF NOT EXISTS or OR IGNORE, so
-- a second pass is a clean no-op rather than an error to tolerate.

CREATE TABLE IF NOT EXISTS num_giveaway_entrants (
  id          TEXT PRIMARY KEY,
  entrant_key TEXT NOT NULL,
  phone       TEXT,
  member_id   TEXT,
  week_start  INTEGER NOT NULL,
  source      TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS num_giveaway_entrants_once
  ON num_giveaway_entrants (entrant_key, week_start);

CREATE INDEX IF NOT EXISTS num_giveaway_entrants_week
  ON num_giveaway_entrants (week_start);

INSERT OR IGNORE INTO num_giveaway_entrants
  (id, entrant_key, phone, member_id, week_start, source, created_at)
  SELECT id, 'phone:' || phone, phone, member_id, week_start, source, created_at
    FROM num_giveaway_entries;

CREATE TABLE IF NOT EXISTS num_giveaway_results (
  id             TEXT PRIMARY KEY,
  week_start     INTEGER NOT NULL,
  drawn_at       TEXT NOT NULL,
  seed           TEXT NOT NULL,
  eligible_count INTEGER NOT NULL,
  winners        TEXT NOT NULL,
  note           TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS num_giveaway_results_week
  ON num_giveaway_results (week_start);

CREATE TABLE IF NOT EXISTS num_giveaway_claims (
  draw_id      TEXT NOT NULL,
  entrant_key  TEXT NOT NULL,
  phone        TEXT,
  member_id    TEXT,
  state        TEXT NOT NULL DEFAULT 'won',
  claimed_at   TEXT,
  forfeited_at TEXT,
  reason       TEXT,
  PRIMARY KEY (draw_id, entrant_key)
);

CREATE INDEX IF NOT EXISTS num_giveaway_claims_draw
  ON num_giveaway_claims (draw_id);
