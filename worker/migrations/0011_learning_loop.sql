-- 0011 — the first thing NUM learns that changes what NUM does.
--
-- Before this migration nothing NUM recorded ever fed back into NUM's
-- behaviour. num_asks and num_place_impressions were write-only: the ranker in
-- ai/places.js read neither, so a place NUM had put in front of four hundred
-- guests and a place it had never mentioned scored exactly the same. Every
-- part of that score was crawled off the open web — Google's star rating,
-- Google's review count, whether we hold a phone number.
--
-- These three columns are the first part of it NUM learned for itself.
--
--   num_rating    the average of what NUM's OWN guests gave after they went
--   num_rating_n  how many of them there were
--   num_rated_at  when the rollup last ran, so a stale loop is visible
--
-- ── why they are materialised on `places`
--
-- The ranker scores rows inside one SQL query over a table holding 2,529,721
-- of them. A correlated subquery into num_ratings would be paid on every
-- recommendation to every guest, for a number that changes a few times a day.
-- worker/learn.mjs recomputes these from num_ratings on a cron — totally, not
-- incrementally, because an incremental counter drifts the first time a rating
-- is edited or removed for a takedown, and a wrong average looks exactly like
-- a right one.
--
-- ── the rule that must survive every future change to this
--
-- The only way a place moves up here is that people who went there said it was
-- good. Nothing in this loop may take money as an input. Placement is not for
-- sale — gate.test.mjs already fails the build if the merchant page so much as
-- implies it is — and worker/learn.test.mjs fails it if the score gains a term
-- money can reach.
--
-- Below five ratings the number does not move the ranking at all: three
-- ratings averaging 4.7 reads identically to three hundred and is worth
-- nothing like as much.
--
-- ── DEPLOY ORDER MATTERS
--
-- ai/places.js SELECTs these columns by name. Deploying that code against a
-- database without them makes every place query throw, and nearbyPlaces()
-- catches its own errors and returns an empty list — so the failure would not
-- be an error page, it would be a concierge that politely knows no restaurants
-- anywhere in the world. Apply this first.

ALTER TABLE places ADD COLUMN num_rating REAL;
ALTER TABLE places ADD COLUMN num_rating_n INTEGER NOT NULL DEFAULT 0;
ALTER TABLE places ADD COLUMN num_rated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_places_numrating ON places(num_rating_n);
