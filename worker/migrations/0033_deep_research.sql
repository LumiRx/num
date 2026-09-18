-- Deep research: the long, multi-source answer Num Plus and Num Pro have been
-- sold on since memberships shipped, and which had no implementation until
-- 18 Sep 2026. See worker/research.mjs for what it does and why metering it
-- (rather than gating it) stays the right side of B&P §17550.27.
--
-- `evidence` holds the places the answer was allowed to name, so an answer can
-- be audited after the fact against what Num actually knew at the time.
CREATE TABLE IF NOT EXISTS num_research (
  id           TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL,
  brief        TEXT NOT NULL,
  dest         TEXT,
  state        TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | empty | failed
  questions    TEXT,
  constraints  TEXT,
  evidence     TEXT,
  answer       TEXT,
  unmet        TEXT,
  brain        TEXT,
  ms           INTEGER,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_research_member ON num_research(member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_state ON num_research(state, created_at);
