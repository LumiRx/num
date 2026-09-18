-- An Expert's own list: shops they found, before anybody has signed anything.
--
-- ── THE GAP ───────────────────────────────────────────────────────────────
--
-- `introduce()` needs a place_id, because num_scout_places declares it NOT
-- NULL UNIQUE and that uniqueness IS the first-scout-wins rule. So an Expert
-- can only record a business that already exists in a 2.5M-row places table —
-- and scoutintro.mjs already says, in its own words, that small shops are
-- exactly the ones missing from it. That was most of Isaiah's street.
--
-- scoutintro.mjs covers the other direction: a business that signs up with a
-- code on the form. What has never existed is the Expert's own side of it —
-- the venue they walked past on Tuesday, spoke to the wrong person at, and
-- means to go back to on Friday. Without somewhere to put that, it lives in
-- their phone notes and dies there, and the round they were given is the only
-- thing the office can see.
--
-- ── A LEAD IS NOT AN INTRODUCTION ─────────────────────────────────────────
--
-- This is the line the whole scouts design is built on and this table must not
-- blur it. A row here:
--
--   · earns nothing, ever. There is no rate on it and no link to
--     num_scout_earnings. Money starts at `activated` on a real place.
--   · does NOT consume the monthly claim cap. The cap is spent by introduce(),
--     at the moment a real place is bound, because that is the only moment
--     first-come can be checked.
--   · does NOT reserve a business against other Experts. Two people may have
--     the same shop on their list. Whoever actually introduces it first wins,
--     decided by UNIQUE(place_id) over there, not by who typed it here first.
--
-- Reserving would be the tempting thing to add and it is the wrong one: it
-- would let somebody lock a street by typing, which is the same failure as
-- paying for signatures, one step earlier.
--
-- `state` is the Expert's own note to themselves about a conversation. It is
-- deliberately NOT the num_scout_places state machine — 'signed_up' here means
-- "they told me they would", which is a thing people say, and the money still
-- waits on revenue like it always did.

CREATE TABLE IF NOT EXISTS num_scout_leads (
  id           TEXT PRIMARY KEY,
  scout_id     TEXT NOT NULL REFERENCES num_scouts(id),

  name         TEXT NOT NULL,
  category     TEXT,
  phone        TEXT,
  website      TEXT,
  address      TEXT,
  area         TEXT,
  dest         TEXT,
  country      TEXT,
  lat          REAL,
  lng          REAL,

  -- 'expert'   — they typed it in themselves, walking
  -- 'round'    — it came from a list the office gave them
  source       TEXT NOT NULL DEFAULT 'expert'
               CHECK (source IN ('expert','round')),

  -- Set only once this lead is matched to a real listing, and then to a real
  -- introduction. Until both are filled this row is a note, not a claim.
  place_id       TEXT,
  scout_place_id TEXT REFERENCES num_scout_places(id),

  -- What the EXPERT thinks, not what the database knows. See the note above.
  state        TEXT NOT NULL DEFAULT 'to_visit'
               CHECK (state IN ('to_visit','visited','interested','signed_up','not_now','dead')),
  note         TEXT,

  -- Lowercased name plus the house number, so adding the same shop twice on
  -- two different days is a no-op rather than two rows to reconcile later.
  -- Computed in worker/scoutleads.mjs: a generated column would need the same
  -- normalising rules in SQL and in JS, and two copies of a rule drift.
  dedupe_key   TEXT NOT NULL,

  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT,

  UNIQUE (scout_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_scout_leads_scout ON num_scout_leads(scout_id, state);
-- The office asking "has anybody got this place on a list" is a real question
-- once two Experts work the same city.
CREATE INDEX IF NOT EXISTS idx_scout_leads_place ON num_scout_leads(place_id)
  WHERE place_id IS NOT NULL;
