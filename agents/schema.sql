-- num-agents: the public platform AI agents use to submit business data to NUM.
--
-- Deliberately NOT reusing num_agent_clients: that table is a human sales agent's
-- client book (stage, commission_bp) and has nothing to do with software agents.
-- Everything here is prefixed num_ai_ so the two can never be confused.
--
-- The central rule this schema enforces: an agent submission is a SUBMISSION, not
-- a listing. Nothing an agent writes touches `places` or `businesses`. A person at
-- 5arz promotes an approved submission across; until then it is invisible to
-- travellers. That is what "agent-submitted, human-verified" means in storage.

CREATE TABLE IF NOT EXISTS num_ai_agents (
  id             TEXT PRIMARY KEY,
  -- sha-256 of the key, hex. The key itself is shown once at signup and never
  -- stored, so a database leak cannot be used to write as somebody else's agent.
  key_hash       TEXT NOT NULL UNIQUE,
  key_prefix     TEXT NOT NULL,              -- numa_live_ab12 — enough to identify a key in a log
  agent_name     TEXT NOT NULL,
  operator_name  TEXT NOT NULL,
  operator_email TEXT NOT NULL,
  homepage       TEXT,
  purpose        TEXT NOT NULL,
  tier           TEXT NOT NULL DEFAULT 'free'
                 CHECK (tier IN ('free','bundle','pro','full')),
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','paused','banned')),
  signup_ip_hash TEXT,
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER,
  rotated_at     INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS ix_ai_agents_email ON num_ai_agents(operator_email);

CREATE TABLE IF NOT EXISTS num_ai_submissions (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES num_ai_agents(id) ON DELETE CASCADE,
  external_ref   TEXT,                       -- the agent's own id for this business
  relationship   TEXT NOT NULL
                 CHECK (relationship IN ('owner','authorized_agent','third_party')),
  name           TEXT NOT NULL,
  vertical       TEXT,
  country        TEXT,
  city           TEXT,
  payload        TEXT NOT NULL,              -- the whole submitted body, verbatim JSON
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','duplicate','withdrawn')),
  business_id    TEXT,                       -- set only when a human approves and links it
  place_id       TEXT,                       -- set if it was matched to an existing directory place
  review_note    TEXT,
  reviewed_by    TEXT,
  reviewed_at    INTEGER,
  callback_url   TEXT,
  callback_state TEXT,                       -- null | sent | failed
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS ix_ai_sub_agent  ON num_ai_submissions(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_ai_sub_status ON num_ai_submissions(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_sub_ref
  ON num_ai_submissions(agent_id, external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS num_ai_promos (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES num_ai_agents(id) ON DELETE CASCADE,
  submission_id  TEXT REFERENCES num_ai_submissions(id) ON DELETE CASCADE,
  external_ref   TEXT,
  business_id    TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('promo','special','event','ad')),
  title          TEXT NOT NULL,
  detail         TEXT NOT NULL,
  starts_at      TEXT,
  ends_at        TEXT,
  discount_pct   INTEGER CHECK (discount_pct IS NULL OR (discount_pct >= 0 AND discount_pct <= 90)),
  terms          TEXT,
  payload        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','expired','withdrawn')),
  review_note    TEXT,
  reviewed_by    TEXT,
  reviewed_at    INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS ix_ai_promo_agent ON num_ai_promos(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_ai_promo_status ON num_ai_promos(status, created_at);

-- One row per agent per UTC day. Writes are free; this counts reads only, which
-- is the thing the tiers actually meter.
CREATE TABLE IF NOT EXISTS num_ai_usage (
  agent_id       TEXT NOT NULL,
  day            TEXT NOT NULL,              -- YYYY-MM-DD, UTC
  reads          INTEGER NOT NULL DEFAULT 0,
  writes         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day)
) STRICT;

-- Signup abuse guard, keyed on a salted hash of the IP so the table holds no
-- addresses. Same reasoning as VISITOR_SALT on the capture worker.
CREATE TABLE IF NOT EXISTS num_ai_signup_guard (
  ip_hash        TEXT NOT NULL,
  day            TEXT NOT NULL,
  count          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
) STRICT;
