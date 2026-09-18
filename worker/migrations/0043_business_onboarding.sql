-- 0043 — business onboarding: how a venue takes a booking, which system it
-- already runs, and one account over several addresses.
--
-- WHY THIS EXISTS
-- Hugo's Restaurant in West Hollywood answered a NUM invitation on 18 Sep 2026
-- with three things this schema did not have a place for:
--
--   1. they take no reservations by text message, and the claim form's
--      validator refused to submit without a mobile number,
--   2. they already run an established reservation system, and nothing here
--      could record which one, let alone send a booking to it, and
--   3. they operate four Los Angeles sites and asked whether those could be
--      managed under one account, and every business object in this system is
--      a single address.
--
-- All three are now answerable. None of them required flattening a location
-- into a company, which would have broken the one thing the model has to get
-- right: a table in Studio City is not a table in West Hollywood.
--
-- The application creates each of these lazily as well (bookingchannel.mjs,
-- ressystem.mjs, bizgroup.mjs), the way most of this codebase does. This file
-- is the reviewable definition and the one a fresh database gets.

-- ── How a venue takes a NUM booking ────────────────────────────────────────
-- Keyed on the PLACE, not the business: a booking request carries a place_id
-- and most of the directory is unclaimed, so keying on a business would leave
-- the question unanswerable for every venue we could actually send one to.
-- 'none' is a supported, final answer and nothing downstream may treat it as
-- an unfinished signup.
CREATE TABLE IF NOT EXISTS num_booking_channels (
  place_id     TEXT PRIMARY KEY,
  business_id  TEXT,
  via          TEXT NOT NULL DEFAULT 'sms'
               CHECK (via IN ('sms','email','own','none')),
  sms_to       TEXT,
  email_to     TEXT,
  system_key   TEXT,
  system_name  TEXT,
  booking_url  TEXT,
  integration  TEXT NOT NULL DEFAULT 'none'
               CHECK (integration IN ('none','handoff','requested','api')),
  chosen_by    TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookchan_biz ON num_booking_channels(business_id);
CREATE INDEX IF NOT EXISTS idx_bookchan_sys ON num_booking_channels(system_key, integration);

-- ── The integration queue ──────────────────────────────────────────────────
-- One row per (system, venue) we cannot yet book into. `blocked_on` is the
-- field that decides whether a human is interrupted: 'dre' means a partner
-- agreement, a credential or a signature, which no agent can produce.
-- alerted_at is why he is told once.
CREATE TABLE IF NOT EXISTS num_integration_requests (
  id          TEXT PRIMARY KEY,
  system_key  TEXT,
  system_name TEXT NOT NULL,
  place_id    TEXT,
  business_id TEXT,
  venue_name  TEXT,
  booking_url TEXT,
  reach       TEXT NOT NULL DEFAULT 'unknown',
  state       TEXT NOT NULL DEFAULT 'open'
              CHECK (state IN ('open','working','blocked','shipped','dropped')),
  blocked_on  TEXT NOT NULL DEFAULT 'research'
              CHECK (blocked_on IN ('research','build','dre','venue','none')),
  findings    TEXT,
  alerted_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_integreq_state ON num_integration_requests(state, blocked_on);
CREATE UNIQUE INDEX IF NOT EXISTS idx_integreq_one
  ON num_integration_requests(system_name, COALESCE(place_id,''));

-- ── One account, several addresses ─────────────────────────────────────────
-- A group answers two questions and holds no operational data of its own: who
-- may manage these locations, and which other locations are theirs.
CREATE TABLE IF NOT EXISTS num_business_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  country     TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Membership is an email, because that is what the sign-in link is sent to and
-- what the person actually has. Revoked rather than deleted: "who could see
-- our bookings in March" is a question a business will eventually ask.
CREATE TABLE IF NOT EXISTS num_business_group_people (
  group_id    TEXT NOT NULL,
  email       TEXT NOT NULL,
  name        TEXT,
  role        TEXT NOT NULL DEFAULT 'manager'
              CHECK (role IN ('owner','manager','viewer')),
  added_by    TEXT,
  added_at    TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT,
  PRIMARY KEY (group_id, email)
);

-- business_id is the PRIMARY KEY, so a location belongs to at most one group
-- and the database refuses a second claim on it rather than leaving two groups
-- both believing they own a restaurant. An ownership dispute that can be
-- represented is one that gets discovered by whoever loses a booking.
CREATE TABLE IF NOT EXISTS num_business_group_sites (
  business_id TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  place_id    TEXT,
  label       TEXT,
  added_by    TEXT,
  added_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_groupsites_group ON num_business_group_sites(group_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_groupsites_place
  ON num_business_group_sites(place_id) WHERE place_id IS NOT NULL;
