-- NUM · business claim + verification, and the referral/invite ledger.
-- Applied with:  npx wrangler d1 execute num-db --remote --file claim/schema.sql

-- ── Business claims ──────────────────────────────────────────────────────
-- One row per attempt to claim a directory listing. The verification target
-- is ALWAYS copied from the directory row at claim time (channel_value), never
-- supplied by the claimant — that is the whole anti-fraud premise.
CREATE TABLE IF NOT EXISTS num_claims (
  id             TEXT PRIMARY KEY,
  place_id       TEXT NOT NULL,                    -- places.id being claimed
  business_id    TEXT,                             -- set once verified
  claimant_name  TEXT,
  claimant_email TEXT,
  claimant_phone TEXT,                             -- for contacting them, NEVER for the code
  channel        TEXT NOT NULL CHECK (channel IN ('sms','voice','email_domain','manual')),
  channel_value  TEXT,                             -- masked at rest for display; the real target
  code_hash      TEXT,                             -- SHA-256(salt + code); the code itself is never stored
  code_salt      TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 5,
  sent_at        TEXT,
  expires_at     TEXT,
  state          TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','verified','failed','expired','review','rejected','revoked')),
  review_reason  TEXT,                             -- why it needs a human
  evidence       TEXT,                             -- JSON: uploaded proof for manual review
  ip             TEXT,
  user_agent     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at     TEXT,
  decided_by     TEXT
);
CREATE INDEX IF NOT EXISTS num_claims_place ON num_claims (place_id, created_at DESC);
CREATE INDEX IF NOT EXISTS num_claims_state ON num_claims (state, created_at DESC);

-- Every state change, append-only. A hijack attempt should be legible months later.
CREATE TABLE IF NOT EXISTS num_claim_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id   TEXT NOT NULL,
  event      TEXT NOT NULL,          -- started | code_sent | code_wrong | verified | locked | review | decided
  detail     TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS num_claim_events_claim ON num_claim_events (claim_id, id);

-- Ownership, once proven. A place has at most one active owner.
CREATE TABLE IF NOT EXISTS num_place_owners (
  place_id    TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  claim_id    TEXT NOT NULL,
  method      TEXT NOT NULL,         -- how ownership was proven
  phone       TEXT,                  -- the verified number, linked to the profile
  verified_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT
);

-- ── Referrals & invites ──────────────────────────────────────────────────
-- An invite is a link minted BY a member FOR one person. It carries the
-- referrer so a signup can be attributed without cookies.
CREATE TABLE IF NOT EXISTS num_invite_links (
  token        TEXT PRIMARY KEY,
  code         TEXT NOT NULL,                    -- referral code of the sender
  sender_id    TEXT NOT NULL,
  sender_name  TEXT,
  to_phone     TEXT,                             -- optional: who it was minted for
  to_name      TEXT,
  message      TEXT,                             -- the personalised line
  channel      TEXT,                             -- sms | whatsapp | share | copy
  sent_at      TEXT,
  opened_at    TEXT,
  signed_up_at TEXT,
  signup_id    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS num_invite_links_sender ON num_invite_links (sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS num_invite_links_code ON num_invite_links (code);
