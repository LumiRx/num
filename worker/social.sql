-- NUM social layer: members, mutual friend links, and shared plans.
--
-- Design notes that the column list alone does not carry:
--
--  * A link is only ever ACTIVE when both sides consented — the inviter by
--    sending, the invitee by opening the invite on their own device. Nothing
--    is shared across a pending link. Phone verification improves identity
--    display; consent is what gates data flow.
--  * A plan exists before any reservation does. `num_plan_items.status`
--    starts at 'idea', which is the whole point: friends plan together first
--    and book later, and the same row becomes the booking when it firms up.
--  * `num_plan_events` is the AI-to-AI channel. One member's Num appends,
--    every other member's Num reads what happened since it last looked and
--    narrates it into that member's thread.

CREATE TABLE IF NOT EXISTS num_members (
  id             TEXT PRIMARY KEY,          -- 'mem_…', minted on the device
  name           TEXT,
  phone          TEXT UNIQUE,               -- E.164, normalised
  phone_verified INTEGER NOT NULL DEFAULT 0,
  code_hash      TEXT,                      -- OTP: hash only, never the code
  code_salt      TEXT,
  code_expires   TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  ref_code       TEXT,                      -- their own referral code
  dest           TEXT,                      -- last known destination
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_num_members_phone ON num_members(phone);

CREATE TABLE IF NOT EXISTS num_links (
  id          TEXT PRIMARY KEY,
  a_id        TEXT NOT NULL,                -- inviter
  b_id        TEXT,                         -- invitee, once they exist
  b_phone     TEXT,                         -- who the invite was addressed to
  b_name      TEXT,
  state       TEXT NOT NULL DEFAULT 'pending',  -- pending | active | declined
  token       TEXT,                         -- num_invite_links.token
  plan_id     TEXT,                         -- invite carried a plan
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_num_links_a ON num_links(a_id, state);
CREATE INDEX IF NOT EXISTS idx_num_links_b ON num_links(b_id, state);
CREATE INDEX IF NOT EXISTS idx_num_links_token ON num_links(token);

CREATE TABLE IF NOT EXISTS num_plans (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  dest       TEXT,
  owner_id   TEXT NOT NULL,
  starts_on  TEXT,                          -- ISO date or null: a plan needs no date
  state      TEXT NOT NULL DEFAULT 'planning',  -- planning | booked | done | archived
  join_code  TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS num_plan_members (
  plan_id   TEXT NOT NULL,
  member_id TEXT NOT NULL,
  name      TEXT,
  role      TEXT NOT NULL DEFAULT 'member', -- owner | member
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (plan_id, member_id)
);

CREATE TABLE IF NOT EXISTS num_plan_items (
  id         TEXT PRIMARY KEY,
  plan_id    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'idea',  -- idea | booking | note | photo | bill
  title      TEXT NOT NULL,
  place      TEXT,
  address    TEXT,
  day        TEXT,                          -- ISO date, nullable — ideas have no date
  time       TEXT,
  status     TEXT NOT NULL DEFAULT 'idea',  -- idea | proposed | held | confirmed | cancelled
  cost       TEXT,
  note       TEXT,
  photo      TEXT,
  by_id      TEXT,
  by_name    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_num_plan_items_plan ON num_plan_items(plan_id);

CREATE TABLE IF NOT EXISTS num_plan_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL,
  ts      TEXT NOT NULL DEFAULT (datetime('now')),
  by_id   TEXT,
  by_name TEXT,
  kind    TEXT NOT NULL,                    -- joined | item_added | item_updated | booked | note
  summary TEXT NOT NULL,                    -- one line, written for a human thread
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_num_plan_events_plan ON num_plan_events(plan_id, id);
