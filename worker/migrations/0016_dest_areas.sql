-- NUM · precomputed neighbourhood table
--
-- Two hot-path queries in ai/places.js re-derive the same facts from the
-- 2.69M-row `places` table on every request that needs them:
--
--   isKnownArea   SELECT 1 FROM places WHERE area LIKE ?1 COLLATE NOCASE LIMIT 1
--                 No index on `area` (0012 dropped the only one, correctly:
--                 every OTHER area predicate is a leading-wildcard LIKE). On a
--                 miss — which is exactly the "guest named a city we don't
--                 cover" path — it scans the whole table: measured 940 ms and
--                 2,686,795 rows read. The honest decline is the slowest
--                 answer Num gives.
--
--   areaCenter    SELECT area, AVG(lat), AVG(lng), COUNT(*) FROM places
--                 WHERE dest=?1 … GROUP BY area — per ask, whenever no live
--                 coordinates are attached. Tokyo: 920 ms, 290K rows.
--                 categoriesFor in suggest.mjs does the same for categories.
--
-- Both answers change only when the directory is ingested, which is a
-- batch event. So compute them once. The whole GROUP BY over every
-- destination is 16,539 rows (measured 4 Sep 2026: 104 destinations,
-- 5.5 s, 4.9M rows read — once, here, instead of in slices on every ask).
--
-- `area` is declared COLLATE NOCASE so the primary key, the index and every
-- equality predicate are case-insensitive without a function call, and a
-- refresh that picks a different capitalisation of the same neighbourhood
-- lands on the same row instead of beside it.
--
-- Refresh: `refreshDestAreas(env)` in ai/places.js re-runs the fill. Call it
-- from the hourly slot in the scheduled() handler after any ingest.

CREATE TABLE IF NOT EXISTS num_dest_areas (
  dest TEXT NOT NULL,
  area TEXT NOT NULL COLLATE NOCASE,
  lat  REAL,
  lng  REAL,
  n    INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (dest, area)
);

CREATE INDEX IF NOT EXISTS idx_dest_areas_area ON num_dest_areas(area);

INSERT OR REPLACE INTO num_dest_areas (dest, area, lat, lng, n, refreshed_at)
SELECT dest, area, AVG(lat), AVG(lng), COUNT(*), strftime('%s','now')
FROM places
WHERE area IS NOT NULL AND area <> ''
GROUP BY dest, area COLLATE NOCASE;
