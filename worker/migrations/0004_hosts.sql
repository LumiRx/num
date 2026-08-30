-- 0004 — host DISPATCH. Routing a request back out to a person.
--
-- STATUS: SPECIFICATION. Not applied. No worker inlines these statements yet.
--
-- ══ READ THIS BEFORE YOU WRITE A LINE OF DISPATCH CODE ══════════════════
-- A host system ALREADY EXISTS IN PRODUCTION and this file does not replace it.
-- Live tables, built and deployed, currently holding zero rows:
--
--   num_hosts           id, name, company, email, phone, country, code,
--                       host_bps DEFAULT 300, term_months DEFAULT 12,
--                       status invited|active|paused|ended, terms_version,
--                       agreed_at, agreed_ip, console_key
--   num_host_uploads    one row per contact-list upload, carrying consent_text,
--                       consent_ip and consent_at — the auditable record that
--                       the host asserted permission for that list
--   num_host_contacts   the host's book. consent_basis host_asserted|confirmed,
--                       status pending→invited→confirmed→declined→bounced…,
--                       token for the confirm link, booked_at
--   num_host_earnings   the ledger. accrued→collected→payable→paid|void, with
--                       CHECKs enforcing host_share ≤ our_commission ≤ booking
--
-- Live endpoints in growth/worker.js: POST /api/host/join,
-- GET /api/host/summary?k=, POST /api/host/contacts?k=.
--
-- THE FIRST DRAFT OF THIS FILE CREATED ITS OWN `num_hosts` AND
-- `num_host_members`. That was wrong and would have failed SILENTLY:
-- CREATE TABLE IF NOT EXISTS against an existing table is a no-op, so the
-- table would have kept its old shape and every dispatch query would have hit
-- a missing column at runtime, in production, with no migration error to
-- explain it. That trap is written down in worker/bookdesk.mjs:86-92 as well.
-- If you ever find yourself adding a table whose name already exists, stop.
--
-- WHAT THE EXISTING SYSTEM DOES: a host brings their client list, NUM invites
-- those people (double opt-in — the host asserts, the contact confirms), they
-- become members, and the host earns 3% of NUM's commission on their bookings
-- for 12 months. That is the "Bernard has 1000 clients" half of the model and
-- it is DONE.
--
-- WHAT IS MISSING, AND WHAT THIS FILE ADDS: dispatch. Sending a request back
-- OUT to a person — the member's own driver first, then their own book, then a
-- host, then partner supply. Nothing below duplicates anything above.

-- ══ 1. EXTEND THE EXISTING HOST RECORD ══════════════════════════════════
-- ALTER, not CREATE. SQLite has no ADD COLUMN IF NOT EXISTS, so each of these
-- fails harmlessly on a second run — run them individually and ignore
-- "duplicate column name". Do NOT wrap them in a transaction with the CREATEs
-- below; a failed ALTER would roll the whole thing back.
--
-- A host today is a REFERRER: they bring clients and earn a share. These three
-- columns are what make them a SUPPLIER as well — someone Num can hand a live
-- request to.

-- What they can actually take. JSON array of service keys from the same
-- vocabulary as num_commissions.category: 'car','reservation','stay',
-- 'activity','appointment','delivery'. A host who only drives never sees a
-- restaurant request.
ALTER TABLE num_hosts ADD COLUMN services_json TEXT NOT NULL DEFAULT '[]';

-- Where. JSON array of {country, city, lat, lng, radius_km}. Coarse on purpose:
-- dispatch is a phone call, not a delivery grid, and a fake-precise radius
-- would reject the fixer who happily drives an hour.
ALTER TABLE num_hosts ADD COLUMN areas_json TEXT NOT NULL DEFAULT '[]';

-- The 5arz proof-of-human check. `agreed_at` already records that they signed
-- terms; this records that we confirmed they are a real, unique person. The
-- whole supply pitch rests on it, so it is a column, not a note. Nothing is
-- dispatched to a host with status <> 'active' AND verified_at IS NULL.
ALTER TABLE num_hosts ADD COLUMN verified_at TEXT;

-- ══ 2. A MEMBER'S OWN PEOPLE ════════════════════════════════════════════
-- Tom. This is the table that makes the promise on /vip/ honest.
--
-- Distinct from num_host_contacts, and the distinction is the product:
--   num_host_contacts  = people the HOST owns. Bernard's book. Consent flows
--                        host → NUM → contact, with a confirm step.
--   num_member_contacts = people ONE MEMBER trusts. Tom the driver. Consent
--                        flows member → NUM only. Tom never signed up and may
--                        never hear of Num except as a text message.
--
-- Because Tom has no account, three things follow, and all three are columns:
--
--   1. LAWFUL BASIS. `consent_source` records what the member told us and
--      `consent_at` when. The FIRST message Num ever sends Tom must identify
--      Num, name the member who added him, and carry a working opt-out.
--      `optout_at` is absolute: non-null means Tom is never contacted again,
--      for ANY member, not just the one who added him.
--      Note the existing system already solved the harder version of this for
--      host lists — num_host_uploads.consent_text/consent_ip/consent_at plus a
--      confirm token. Match that standard here; do not invent a weaker one.
--   2. HE MAY NOT REPLY. `reachable` degrades on repeated non-response so a
--      member is not left waiting on a dead number every trip.
--   3. HE MAY BECOME A HOST. `host_id` links him to num_hosts if he ever signs
--      up, at which point the member's arrangement is unchanged and Tom simply
--      starts getting paid properly. That upgrade path is the reason these are
--      two tables and not one.
CREATE TABLE IF NOT EXISTS num_member_contacts (
  id             TEXT PRIMARY KEY,             -- mct_<uuid>
  member_id      TEXT NOT NULL,
  label          TEXT NOT NULL,                -- "Tom", "my guy in Milan"
  service        TEXT NOT NULL,
  phone_e164     TEXT,
  email          TEXT,
  city           TEXT,
  country        TEXT,
  lat            REAL,
  lng            REAL,
  -- Ranking within the member's own book. Lower is asked first. "Always Tom"
  -- is rank 0; everything else is 100, ordered by distance then by use.
  rank           INTEGER NOT NULL DEFAULT 100,
  used_count     INTEGER NOT NULL DEFAULT 0,
  last_used_at   TEXT,
  reachable      INTEGER NOT NULL DEFAULT 1,
  consent_source TEXT,                         -- 'member_added' | 'member_forwarded'
  consent_at     TEXT,
  optout_at      TEXT,
  host_id        TEXT REFERENCES num_hosts(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mct_member ON num_member_contacts(member_id, service, rank);
CREATE INDEX IF NOT EXISTS idx_mct_phone  ON num_member_contacts(phone_e164);

-- ══ 3. A REQUEST THAT NEEDS A PERSON ════════════════════════════════════
-- Distinct from num_booking_requests, which is a table at a venue. This is
-- "someone must show up", and four different kinds of party can satisfy it.
CREATE TABLE IF NOT EXISTS num_dispatch_requests (
  id           TEXT PRIMARY KEY,               -- dsp_<uuid>
  ref          TEXT NOT NULL UNIQUE,
  member_id    TEXT NOT NULL,
  service      TEXT NOT NULL,
  -- Human-readable, because the person receiving it is a human with a phone.
  summary      TEXT NOT NULL,
  starts_at    TEXT,
  city         TEXT,
  country      TEXT,
  lat          REAL,
  lng          REAL,
  -- What it hangs off, if anything: a flight we booked, a plan, a booking.
  origin_kind  TEXT,                           -- 'duffel_order' | 'plan' | 'booking' | null
  origin_id    TEXT,
  state        TEXT NOT NULL DEFAULT 'open',   -- open → filled | unfilled | cancelled
  -- The offer that won. Denormalised on purpose: "who is picking me up" is the
  -- question a member asks most, and a join is the wrong shape for it.
  filled_by    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_dsp_member ON num_dispatch_requests(member_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dsp_open   ON num_dispatch_requests(state, starts_at);

-- ══ 4. WHO WE ASKED, IN WHAT ORDER ══════════════════════════════════════
-- One row per party contacted. THE ROUTING ORDER IS DATA, NOT POLICY:
--
--   tier 1  named      the member said "Tom drives me in LA". Tom, by name.
--   tier 2  own_book   the member's other contacts, nearest first.
--   tier 3  host       an active, verified num_hosts row covering that area.
--   tier 4  partner    licensed partner supply (LetsGo2Trip, Duffel, et al).
--
-- THE HARD CONSTRAINT: a dispatch MAY NOT create a tier-3 or tier-4 offer
-- while any tier-1 or tier-2 offer on the same request is still 'offered' or
-- 'accepted'. Put that check in worker code AND in a test assertion. A rule
-- that lives only in a comment is not a rule.
--
-- This table is the audit trail for the promise on /hosts/: "if we ever send
-- one of your clients to someone else while your own person was available and
-- willing, we have broken the product". That sentence is only checkable
-- because every offer, in order, with timestamps, is here.
--
-- NEVER DELETE ROWS. A declined tier-1 offer is the evidence that going to
-- tier 3 was legitimate.
CREATE TABLE IF NOT EXISTS num_dispatch_offers (
  id           TEXT PRIMARY KEY,               -- dof_<uuid>
  request_id   TEXT NOT NULL REFERENCES num_dispatch_requests(id),
  tier         INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 4),
  -- Exactly one of these three is set, and it must match the tier.
  contact_id   TEXT REFERENCES num_member_contacts(id),   -- tiers 1 and 2
  host_id      TEXT REFERENCES num_hosts(id),             -- tier 3
  partner_key  TEXT,                                      -- tier 4
  state        TEXT NOT NULL DEFAULT 'offered'
               CHECK (state IN ('offered','accepted','declined','expired','withdrawn')),
  -- What the responder quoted, verbatim, in their currency. As in
  -- num_travel_referrals: a number we RELAY, never one we calculated. No card,
  -- no token, no bank detail — §17550.11, same as 0003.
  quote_cs     INTEGER,
  quote_ccy    TEXT,
  channel      TEXT,                           -- sms | whatsapp | line | email | api
  sent_at      TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at  TEXT,
  reply_text   TEXT,
  CHECK ((contact_id IS NOT NULL) + (host_id IS NOT NULL) + (partner_key IS NOT NULL) = 1)
);
CREATE INDEX IF NOT EXISTS idx_dof_request ON num_dispatch_offers(request_id, tier, sent_at);
CREATE INDEX IF NOT EXISTS idx_dof_host    ON num_dispatch_offers(host_id, state, sent_at);
