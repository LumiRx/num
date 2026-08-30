-- A business we do not already hold, describing itself.
--
-- Written 26 Aug 2026.
--
-- `places` holds 2.5M rows crawled off the open web. It is good coverage and
-- it is not complete: a venue that never made it into OSM or a directory has
-- nothing for an owner to claim, and until now the claim form simply had no
-- answer for them. They typed a name into a box and the claim landed bound to
-- nothing — no address, no coordinates, no listing, nothing to put on a map
-- and nothing a concierge could ever recommend.
--
-- ── WHY THIS IS NOT A ROW IN `places` ────────────────────────────────────
--
-- The obvious implementation is to INSERT straight into `places` and be done.
-- Three things make that wrong:
--
-- 1. places.lat and places.lng are NOT NULL, and an address typed into a form
--    is not coordinates. Writing 0,0 to satisfy the constraint puts a pin in
--    the Gulf of Guinea and, worse, into cell_lat/cell_lng — the index the
--    concierge searches by proximity. One bad row is one wrong answer to
--    "what is near me", which is the only question NUM exists to answer.
--
-- 2. `places` is what NUM tells travellers is real. Anyone on the internet can
--    reach the claim form. A table that feeds recommendations must not be
--    directly writable by the public, whatever the form says on it.
--
-- 3. Verification runs against contact details ALREADY PUBLISHED on a listing
--    — that is the entire anti-hijack property of claiming. A self-submitted
--    listing has no published contact to check against, because the person
--    submitting it is the one supplying it. That is not a reason to refuse
--    them; it is a reason to treat their row differently until someone or
--    something else confirms it.
--
-- So: the owner's own words are captured faithfully, held here, geocoded and
-- reviewed, and only then promoted into `places`. The claim still lands
-- either way. Nobody is turned away because our data is incomplete.
--
-- ── NO PAYMENT INSTRUMENTS ───────────────────────────────────────────────
--
-- Same prohibition as 0003, 0004 and 0006, same reason (California B&P
-- §17550.11). Nothing below is a card, bank or wallet.

CREATE TABLE IF NOT EXISTS num_place_submissions (
  id            TEXT PRIMARY KEY,

  -- What they told us. Stored as given, sanitised but not "corrected": if we
  -- silently tidy an owner's own business name they lose trust in everything
  -- else on the page.
  name          TEXT NOT NULL,
  -- The name as it is actually written on the shopfront, in the owner's own
  -- script. A great many businesses have two names — one on the sign, one for
  -- foreigners — and holding only the second means NUM answers a Thai or
  -- Indonesian guest with a name they have never seen. Stored exactly as
  -- typed: no transliteration, no "correction". It is their name.
  name_local    TEXT,
  -- Which language the form was in when they filled it. Not a guess from the
  -- characters: Indonesian and English share an alphabet, so the script tells
  -- you nothing. It decides which language we write back to them in.
  lang          TEXT,
  address       TEXT,
  website       TEXT,
  category      TEXT,
  phone         TEXT,
  email         TEXT,

  -- Where, as far as we can tell. country/dest come from the claim context
  -- (Cloudflare geo, or the ?d= on the link they arrived from), not from a
  -- dropdown, because a dropdown would be one more field between a busy owner
  -- and finishing.
  country       TEXT,
  dest          TEXT,

  -- Filled by geocoding, later, from `address`. NULL until then — which is
  -- exactly the state `places` cannot represent, and the reason this table
  -- exists at all.
  lat           REAL,
  lng           REAL,
  geo_source    TEXT,                       -- which geocoder, so a bad batch can be found
  geo_at        TEXT,

  -- The claim this came in on. A submission is always someone claiming;
  -- there is no anonymous "add a business" path, because a listing with no
  -- one behind it is the thing we are trying not to have more of.
  claim_id      INTEGER,

  -- new       → just submitted
  -- geocoded  → has coordinates, still unreviewed
  -- promoted  → a row now exists in `places`; place_id says which
  -- duplicate  → we already held it. Not a failure: the claim gets bound to
  --              the existing place_id and the owner never sees a difference.
  -- rejected  → not a real business, or not one we will list
  status        TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','geocoded','promoted','duplicate','rejected')),
  place_id      TEXT,                       -- set on promote or duplicate
  review_note   TEXT,

  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at   TEXT,

  -- A promoted or duplicate submission must say which place it became.
  -- Without this the table can claim work it did not do.
  CHECK (status NOT IN ('promoted','duplicate') OR place_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_place_sub_status ON num_place_submissions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_place_sub_claim  ON num_place_submissions(claim_id);
-- The review queue reads this constantly and it is the only hot path here.
CREATE INDEX IF NOT EXISTS idx_place_sub_queue
  ON num_place_submissions(created_at) WHERE status IN ('new','geocoded');
