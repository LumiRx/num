-- NUM · places index diet
--
-- `places` holds 2,552,694 of the database's 2,681,899 rows, and its indexes
-- are the larger half of the 1.39 GB file. Three of them were provably not
-- earning their bytes. Each finding below came from EXPLAIN QUERY PLAN run
-- against the real query shapes in worker/, not from reading the schema and
-- guessing.
--
-- This runs before the island-wide Taiwan ingest on purpose: every row added
-- from here on pays for three fewer index insertions, and the pages freed
-- here are the pages those rows are written into.

-- 1 ── idx_places_cell(cell_lat, cell_lng)
--      A strict prefix of idx_places_cell_cat(cell_lat, cell_lng, category).
--      SQLite already prefers the three-column index for a two-column lookup:
--        SEARCH places USING INDEX idx_places_cell_cat (cell_lat=? AND cell_lng=?)
--      so this index has never once been the reason a query was fast.
DROP INDEX IF EXISTS idx_places_cell;

-- 2 ── idx_places_area_nc(dest, area COLLATE NOCASE)
--      Every `area` predicate in the codebase is a leading-wildcard LIKE —
--      openapi.mjs:117, partnermcp.mjs:440, partnermcp.mjs:534 — and a
--      leading wildcard can never seek an index. The planner agrees: those
--      queries resolve through idx_places_dest_name. Two and a half million
--      index entries serving nothing.
DROP INDEX IF EXISTS idx_places_area_nc;

-- 3 ── idx_places_numrating(num_rating_n)
--      Not one row has num_rating_n > 0, so every entry in it holds the same
--      key — an index that cannot narrow anything. Rebuilt as a partial
--      index: it costs nothing while nothing is rated, and starts working the
--      day the first place is.
--
--      The matching read in learn.mjs asked for COALESCE(num_rating_n,0) > 0.
--      The column is NOT NULL DEFAULT 0, so the COALESCE could never change
--      the answer, but wrapping a column hides it from the planner — that
--      query was a full scan of every place NUM holds. It is now a bare
--      comparison, which this index can serve.
DROP INDEX IF EXISTS idx_places_numrating;
CREATE INDEX IF NOT EXISTS idx_places_numrating ON places(num_rating_n) WHERE num_rating_n > 0;

-- Deliberately kept, and why:
--   idx_places_dest_cat     exact category filters and GROUP BY category
--   idx_places_dest_name    the planner's general-purpose dest=? index
--   idx_places_cell_cat     every geographic lookup
--   idx_places_cat          console.mjs:629 counts categories across all dests
--   idx_places_dest_reviews only 542 rows have reviews > 0, so it is nearly
--                           degenerate — but growth/worker.js:1606 orders by
--                           it, and dropping an index a separate worker relies
--                           on is not a change to make in the same pass as
--                           this one. Next candidate.
