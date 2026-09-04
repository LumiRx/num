-- OPTIONAL, ONE-OFF. Makes the hours backfill's per-tick query cheap for the
-- whole of its ~36-hour run, and shrinks to nothing as it finishes.
--
-- Without it the cron still works: early ticks find 300 rows instantly, and
-- only the last few scan far. With it, every tick is a few milliseconds.
-- A partial index on 124k of 2.69M rows — small, and it disappears from the
-- index as rows are parsed.
--
--   npx wrangler d1 execute num-db --remote --file=INDEX-HOURS-TODO-2026-09-04.sql
CREATE INDEX IF NOT EXISTS idx_places_hours_todo
  ON places(id)
  WHERE hours IS NOT NULL AND hours <> '' AND (hours_mask IS NULL OR hours_mask = '');
