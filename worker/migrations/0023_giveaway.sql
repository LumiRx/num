-- 0023 — the Friday pack draw needs somewhere to put an entry and a record of the draw.
--
-- Two tables, and the second one is the important one.
--
-- num_giveaway_entries is the obvious half: who is in this week's draw. The unique
-- key is (phone, week_start), not an insert-per-text, because somebody who texts
-- PACKS four times on Tuesday has entered once. Enforcing that in SQL rather than in
-- a code path means it stays true even when a second entry route is added later —
-- and there IS a second route, see `source`.
--
-- num_giveaway_draws is what makes the promotion defensible. A draw nobody can check
-- is a stranger on the internet promising prizes. Storing the seed, the eligible
-- count and the winners means "how do we know it was fair" has an answer that can be
-- re-run and reproduced months later, which is exactly what a regulator or an angry
-- entrant asks for. The seed is stored BEFORE the winners are computed from it.
--
-- week_start is the Friday 00:00 UTC that opens the entry period, stored as an
-- integer epoch. Deriving the period from a single anchor rather than storing a
-- start AND an end removes the class of bug where the two disagree and an entry
-- lands in a window that does not exist.
--
-- EVERY LINE IS ITS OWN STATEMENT. A column added inside a CREATE TABLE IF NOT
-- EXISTS on a table that already exists is a silent no-op.

CREATE TABLE IF NOT EXISTS num_giveaway_entries (
  id          TEXT PRIMARY KEY,
  phone       TEXT NOT NULL,
  member_id   TEXT,
  week_start  INTEGER NOT NULL,
  source      TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS num_giveaway_entries_once
  ON num_giveaway_entries (phone, week_start);

CREATE INDEX IF NOT EXISTS num_giveaway_entries_week
  ON num_giveaway_entries (week_start);

CREATE TABLE IF NOT EXISTS num_giveaway_draws (
  id             TEXT PRIMARY KEY,
  week_start     INTEGER NOT NULL,
  seed           TEXT NOT NULL,
  eligible_count INTEGER NOT NULL,
  winners        TEXT NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS num_giveaway_draws_week
  ON num_giveaway_draws (week_start);
