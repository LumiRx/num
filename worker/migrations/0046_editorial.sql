-- NUM · the editorial authority layer
--
-- ── WHY THIS TABLE EXISTS ────────────────────────────────────────────────
--
-- top_places scores on rating, hygiene, confidence, contact and claimed. Every
-- one of those is a fact about a RECORD, not a judgement about a PLACE. A
-- crowd average separates a bad restaurant from an adequate one — it cannot
-- separate an adequate one from a great one, and a 4.5-star chain hotel
-- outscores the best room in the city because more people stayed there.
--
-- The judgement a concierge actually trades on comes from critics: Michelin,
-- the 50 Best families, a city's own food desk. That signal has no home in
-- the schema, so it cannot reach a guest. This is its home.
--
-- ── WHAT AN ACCOLADE HAS THAT A RATING DOES NOT ──────────────────────────
--
-- A DATE, and the ability to be TAKEN AWAY. Both are load-bearing:
--
--   · The 2026 California guide removed stars from 715, Camphor and Morihiro.
--     Masa went from three stars to two in Nov 2025. A store that only ever
--     adds accolades would recommend all four as starred for ever, in NUM's
--     own voice, which is worse than saying nothing.
--   · `weight` is therefore SIGNED. A revocation is a row with a negative
--     weight, not the absence of a row — absence cannot outrank a stale
--     positive somebody else recorded.
--   · `awarded_on` is when the ACCOLADE is from, never when we read it.
--     Scoring decays on it, so a 2026 star stops being a 2029 star by itself
--     rather than by anybody remembering to clean up.
CREATE TABLE IF NOT EXISTS num_editorial (
  id           TEXT PRIMARY KEY,
  dest         TEXT NOT NULL,

  -- `name` is the venue as the SOURCE printed it. `place_id` is our match into
  -- `places`, and is NULL until one is found. Kept apart on purpose: an
  -- unmatched accolade is still true and still worth showing an operator, and
  -- overwriting the published name with our own would lose the only string we
  -- can re-match on when the places table changes underneath it.
  place_id     TEXT,
  name         TEXT NOT NULL,
  bucket       TEXT,

  accolade     TEXT NOT NULL,
  -- star | list | critic | consensus | revoked
  kind         TEXT NOT NULL,
  -- Signed points fed into the ranking. Negative for a loss.
  weight       REAL NOT NULL,

  -- Attribution is not decoration. It is what the concierge SAYS — "two
  -- Michelin stars, 2026" is an answer a guest can act on. A number out of
  -- five is not. A row with no source may not be scored.
  source       TEXT NOT NULL,
  url          TEXT,
  awarded_on   TEXT NOT NULL,
  captured_at  TEXT NOT NULL DEFAULT (datetime('now')),
  note         TEXT,

  -- One row per ACCOLADE per venue per source per date — not one row per
  -- source per date. A single ceremony issues several facts about the same
  -- venue at once: in Nov 2025 Michelin both stripped Masa of its third star
  -- and confirmed the two it kept. Keying on (source, date) alone would make
  -- those two mutually exclusive and the loss would be the one dropped, which
  -- is precisely backwards.
  --
  -- Re-running the same research still cannot double a score: the same
  -- accolade, from the same source, on the same date, collides as intended.
  UNIQUE (dest, name, source, awarded_on, accolade)
);

CREATE INDEX IF NOT EXISTS idx_editorial_dest    ON num_editorial (dest);
CREATE INDEX IF NOT EXISTS idx_editorial_place   ON num_editorial (place_id) WHERE place_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_editorial_unmatched ON num_editorial (dest) WHERE place_id IS NULL;

-- ── THE FRESHNESS QUEUE ──────────────────────────────────────────────────
--
-- Dre, 19 Sep 2026: "we shoud keep researching the have the most uptodate
-- places. we can que the search once some asks a quick check to our ranking
-- and update of whats going on around them."
--
-- So a guest asking about a destination is the demand signal. Asking bumps
-- the counter and stamps the time, and the destinations with the most asks and
-- the stalest research rise to the top of the queue.
--
-- WHAT THIS DELIBERATELY DOES NOT DO: refresh itself. The research is a
-- judgement call across paywalled, licence-restricted and occasionally
-- advertorial sources — it caught LA Magazine running a grocery chain as a
-- "best of" pick, and three Michelin revocations no API reports. A cron that
-- claimed to do that unattended would be inventing accolades, which is the
-- exact failure this whole layer exists to prevent. This table says WHERE the
-- next research pass is worth spending. A person or an agent still does it.
CREATE TABLE IF NOT EXISTS num_editorial_demand (
  dest           TEXT PRIMARY KEY,
  asks           INTEGER NOT NULL DEFAULT 0,
  last_ask       TEXT,
  last_refreshed TEXT,
  -- Set when a pass starts so two do not run at once, cleared when it lands.
  claimed_at     TEXT
);
