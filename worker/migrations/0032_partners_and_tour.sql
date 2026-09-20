-- Ambassadors and influencers a venue can partner with, and whether that venue
-- has been shown round the console yet.
--
-- WHY A NEW TABLE RATHER THAN num_referral_codes
--
-- num_referral_codes already allows owner_type 'ambassador', and it is the
-- right place for the CODE. It is the wrong place for the PERSON: it holds no
-- name, no city, no reach, no way to reach them, and a venue browsing for a
-- partner needs all four. The code stays where it is — this is who is behind it.
--
-- VIP hosts are NOT copied in here. They already exist in num_hosts with their
-- own console and their own code, and a second copy of a host is a second copy
-- that goes stale. The partners page reads both and shows one list.
--
-- reach is nullable and means UNKNOWN, not zero. A follower count we have not
-- verified is worse than no number at all on a page a venue makes a spending
-- decision from.
CREATE TABLE IF NOT EXISTS num_partners (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,            -- 'ambassador' | 'influencer'
  name         TEXT NOT NULL,
  handle       TEXT,
  platform     TEXT,
  city         TEXT,
  country      TEXT,
  blurb        TEXT,
  reach        INTEGER,
  contact_email TEXT,
  code         TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_partners_live ON num_partners (status, kind, city);

-- An introduction a venue asked for. Kept as a record because an intro is a
-- promise made to two people, and neither should have to remember it.
CREATE TABLE IF NOT EXISTS num_partner_intros (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  partner_ref TEXT NOT NULL,
  partner_kind TEXT NOT NULL,
  note        TEXT,
  state       TEXT NOT NULL DEFAULT 'requested',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intros_business ON num_partner_intros (business_id, created_at DESC);

-- Whether this venue has been walked through the console. One row per venue,
-- written when they dismiss the tour, so a returning owner is not shown a
-- beginner's panel forever.
CREATE TABLE IF NOT EXISTS num_biz_tour (
  business_id  TEXT PRIMARY KEY,
  dismissed_at INTEGER,
  created_at   INTEGER NOT NULL
);
