-- 0037 — a fleet from a camera roll.
--
-- Four columns and three indexes. No new tables: an asset built from
-- photographs is the SAME num_assets row as one typed by hand, and giving it a
-- table of its own would have meant two shapes for one thing, two queries
-- everywhere, and a member-facing view that showed one and not the other.
--
-- ALTER, never CREATE — 0021 is sealed. The trap written at the head of 0004
-- applies here word for word: a CREATE TABLE IF NOT EXISTS against a table
-- that already exists is a silent no-op, so an edit would reach fresh
-- databases and no live one.

-- WHAT THE MODEL SAID, kept as evidence rather than folded into the columns.
-- A host looking at "Sunseeker Manhattan 68" needs to be able to see that we
-- were guessing — the confidence, what we could not tell, and when. Without
-- this the console can only show a guess as though it were a fact, which is
-- how a wrong model year ends up in front of a client.
ALTER TABLE num_assets ADD COLUMN identified_json TEXT;

-- NOT YET CHECKED BY A HUMAN.
--
-- Distinct from `listable`, and both are needed. `listable` answers "may a
-- member be shown this" and is the marketplace gate. `draft` answers "has the
-- host looked at what we wrote down" and is the honesty gate. An asset can be
-- confirmed and still not listable (no price yet, no calendar), and nothing can be
-- listable while it is a draft, because nobody has said the name is right.
--
-- DEFAULT 0 so every row that already exists — all of them typed by hand — is
-- correctly not a draft.
ALTER TABLE num_assets ADD COLUMN draft INTEGER NOT NULL DEFAULT 0;

-- Which upload a photograph arrived in. The grouping decision lives in the
-- asset it was attached to. This is how a host can say "undo that batch", and
-- how we can tell, later, which groupings a model made versus which a host
-- made by hand.
ALTER TABLE num_asset_photos ADD COLUMN batch_id TEXT;

-- The link between a hull and an offer.
--
-- An asset is a thing with a calendar. A product is an offer with a price. They
-- were never joined, so a host with six boats could put six products on their
-- shelf and nothing knew which boat each one was — which means a double
-- booking check on the asset could not see the product that caused it.
ALTER TABLE num_host_products ADD COLUMN asset_id TEXT;

CREATE INDEX IF NOT EXISTS idx_assets_draft ON num_assets(host_id, draft, created_at);
CREATE INDEX IF NOT EXISTS idx_asset_photos_batch ON num_asset_photos(batch_id);
CREATE INDEX IF NOT EXISTS idx_host_products_asset ON num_host_products(asset_id);
