-- NUM's own pictures of places, taken by members who were standing there.
--
-- ── WHY NOT SOMEBODY ELSE'S PICTURES ─────────────────────────────────────
--
-- 18 Sep 2026: "for the restaurants they don't have any pictures so we need
-- to pull their images from the internet, yelp typically has great images."
-- Scraping Yelp breaks their terms, and both Yelp's and Google's photo APIs
-- forbid caching the image into your own database — a takedown attached to
-- the one table the product sits on. So this is the other half of the same
-- ask, which is better: "we want users to submit images when they visit …
-- we offer .01 per verified image of a location … use 5arz to prove the
-- location." A photo library NUM owns, with a provenance row under every
-- picture.
--
-- ── WHAT A ROW IS ────────────────────────────────────────────────────────
--
-- One photo, one member, one place, and how we know they were there:
--   proof = 'scan'  they scanned the venue's own NUM code within the hour
--   proof = 'fix'   the phone's fix at capture was within 150 m of the place
--   proof = 'none'  neither — kept, reviewable, never paid
-- plus whether the member's identity is 5arz-verified at the time, because
-- the payment rule is proof AND identity, never one alone.
--
-- Nothing reaches a shelf until state = 'approved' by a human in the console.
-- The reward is written in CENTS (reward_cents), because the offer is a cent
-- and a Star is a dollar: cents accrue on the member and every 100 becomes ★1
-- (kind 'reward', cashable) — see worker/placephotos.mjs.

CREATE TABLE IF NOT EXISTS num_place_photos (
  id            TEXT PRIMARY KEY,
  place_id      TEXT NOT NULL,
  member_id     TEXT NOT NULL REFERENCES num_members(id),
  r2_key        TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  proof         TEXT NOT NULL DEFAULT 'none' CHECK (proof IN ('scan','fix','none')),
  proof_km      REAL,
  identity_verified INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected')),
  reviewed_at   TEXT,
  reviewed_by   TEXT,
  reject_reason TEXT,
  reward_cents  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_place_photos_place  ON num_place_photos(place_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_place_photos_member ON num_place_photos(member_id, created_at);
-- The same picture from the same person twice is one row, however many times the upload is retried.
CREATE UNIQUE INDEX IF NOT EXISTS idx_place_photos_dupe ON num_place_photos(member_id, sha256);

-- Cents a member has earned from photos and not yet had turned into a Star.
CREATE TABLE IF NOT EXISTS num_photo_credit (
  member_id  TEXT PRIMARY KEY REFERENCES num_members(id),
  cents      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
