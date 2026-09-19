-- 0055 — what an ambassador is FOR, and a second draw on the machinery that
-- already runs the first one.
--
-- ══ NO NEW DRAW ════════════════════════════════════════════════════════
--
-- worker/fridaydraw.mjs already contains a draw whose whole point is that a
-- stranger can check it: a Fisher-Yates shuffle over a SORTED id list driven
-- by a seed that is generated once and recorded. Same seed plus same list
-- gives the same winners on a different machine a year later, and the Official
-- Rules promise exactly that in clause 7.
--
-- A second draw written beside it would be a second thing to trust, and the
-- new one would be the untested one. So the Tokyo draw reuses `pickWinners`
-- unchanged — see growth/tokyodraw.mjs for how weighting rides on top of a
-- function that deliberately de-duplicates.
--
-- What that leaves is two columns: which campaign a recorded result belongs
-- to. Added rather than rebuilt because these tables hold the live Friday
-- draw's history, and a promotion's audit trail is the last thing to rewrite.
-- One ALTER per statement, so a duplicate-column error on the first cannot
-- roll back the second.
ALTER TABLE num_giveaway_results ADD COLUMN campaign TEXT;
ALTER TABLE num_giveaway_claims ADD COLUMN campaign TEXT;

-- ══ WHAT THEY ARE FOR ══════════════════════════════════════════════════
--
-- Dre, 19 Sep 2026: "sign up for you niche and get offers directly for your
-- specialty."
--
-- A JSON array, the same shape num_hosts.services_json uses, for the same
-- reason: the list is short, it is read whole every time, and a join table for
-- six strings per person is a join table nobody thanks you for. The vocabulary
-- lives in growth/niches.mjs and a test binds the two lists together.
ALTER TABLE num_ambassadors ADD COLUMN niches_json TEXT;

-- The other half. An offer that knows who it is for is the difference between
-- a noticeboard and something addressed to a person.
ALTER TABLE num_ambassador_offers ADD COLUMN niches_json TEXT;

-- ══ FREE ENTRY ═════════════════════════════════════════════════════════
--
-- Dre's call, 19 Sep 2026.
--
-- A draw whose entries are earned by recruiting people can be treated as
-- requiring CONSIDERATION, and a prize draw with consideration is a lottery,
-- which a private company may not run in most US states. The cure is the one
-- the Friday draw already uses and says on its own rules page: a free route in
-- that asks nothing of anybody.
--
-- So entries are COMPUTED from referral counts — never stored, so they cannot
-- drift from the truth and anybody can recount them — and this table holds
-- only the exception: entries granted to somebody who asked for one free.
-- Small table, one purpose, and the thing that keeps the promotion lawful.
CREATE TABLE IF NOT EXISTS num_draw_free_entries (
  id          TEXT PRIMARY KEY,
  campaign    TEXT NOT NULL,
  member_id   TEXT,
  -- For a request from somebody who is not a member. A free route that
  -- requires an account is not free.
  email       TEXT,
  name        TEXT,
  entries     INTEGER NOT NULL DEFAULT 1 CHECK (entries > 0),
  source      TEXT NOT NULL DEFAULT 'form',
  note        TEXT,
  created_at  TEXT NOT NULL
);
-- One free entry per person per campaign. Without this the free route is the
-- easy route and the referral ladder means nothing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_free_entry_member
  ON num_draw_free_entries(campaign, member_id) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_free_entry_email
  ON num_draw_free_entries(campaign, email) WHERE email IS NOT NULL;
