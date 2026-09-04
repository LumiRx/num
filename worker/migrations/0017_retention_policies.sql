-- NUM · two more retention policies, and a note on why the table now works
--
-- worker/retention.mjs (4 Sep 2026) is the first code to read
-- num_retention_policy. Until then all twelve rows had last_purged_at NULL.
-- The sweep runs hourly from scheduled() and writes last_purged_at /
-- last_purged_rows on every row it applies, so "is the policy in force" is
-- now a query, not a belief:
--
--   SELECT table_name, strategy, retain_days, last_purged_at, last_purged_rows
--     FROM num_retention_policy ORDER BY last_purged_at;
--
-- Two tables were growing with no policy at all. Both are operational
-- telemetry with a visitor id or run id, nothing a person would ask us to
-- keep, and neither is read past a month by any dashboard.

INSERT OR IGNORE INTO num_retention_policy
  (table_name, retain_days, time_column, subject_column, strategy, legal_basis, active)
VALUES
  -- 5,258 rows, ~150/day since 31 Jul, TEXT datetime column. Visitor id,
  -- referrer, country. The console reads 7 and 30 day windows.
  ('num_web_events', 90, 'created_at', NULL, 'delete', 'legitimate_interest', 1),
  -- 1,240 rows, ~90/day since 22 Aug, epoch-seconds `ran_at`. Growth-worker
  -- run log. Nothing joins to it after the day it ran.
  ('num_agent_runs', 90, 'ran_at', NULL, 'delete', 'operational', 1);
