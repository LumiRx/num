-- QR system: connect codes to tables and to the person who issued them,
-- give staff a way in that does not depend on SMS, and give the agent a log.
--
-- Every statement here is additive. Nothing is dropped, no column changes type,
-- and existing rows keep working with NULLs — the console and the /p/ and /v/
-- landings must survive this migration without a deploy.

-- ── codes belong to a table, and to whoever issued them ──────────────────
ALTER TABLE num_paylinks    ADD COLUMN resource_id TEXT;
ALTER TABLE num_paylinks    ADD COLUMN issued_by   TEXT;   -- num_business_users.id
ALTER TABLE num_paylinks    ADD COLUMN settled_by  TEXT;   -- num_business_users.id
ALTER TABLE num_venue_codes ADD COLUMN resource_id TEXT;

CREATE INDEX IF NOT EXISTS idx_paylinks_resource ON num_paylinks(business_id, resource_id);
-- The agent sweeps unsettled bills every 15 minutes. Without this it is a full
-- scan of every code ever issued, forever.
CREATE INDEX IF NOT EXISTS idx_paylinks_open_bills
  ON num_paylinks(state, one_time, settled_at);
CREATE INDEX IF NOT EXISTS idx_venue_codes_resource ON num_venue_codes(business_id, resource_id);

-- ── staff sign-in: emailed single-use link, then a session ───────────────
-- No password to leak and no SMS to fail. A2P 10DLC is still unregistered, so
-- anything depending on a text message does not deliver today.
CREATE TABLE IF NOT EXISTS num_biz_logins (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  business_id TEXT NOT NULL,
  email_lc    TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_ip  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_biz_logins_user ON num_biz_logins(user_id, created_at);

CREATE TABLE IF NOT EXISTS num_biz_sessions (
  sid         TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  business_id TEXT NOT NULL,
  role        TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_biz_sessions_user ON num_biz_sessions(user_id, expires_at);

-- ── what the agent did, every pass ───────────────────────────────────────
-- The agent runs unattended. A change nobody can see afterwards is a change
-- nobody can undo, so every action it takes lands here first.
CREATE TABLE IF NOT EXISTS num_agent_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at      INTEGER NOT NULL,
  task        TEXT NOT NULL,      -- issue | expire | reconcile | chase | watch
  business_id TEXT,
  action      TEXT NOT NULL,      -- what it did, or 'flag' when it only reports
  ref         TEXT,               -- token / resource / booking the action touched
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_at ON num_agent_runs(ran_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_biz ON num_agent_runs(business_id, ran_at);
