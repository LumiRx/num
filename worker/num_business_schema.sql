-- NUM · merchant commerce layer: profile, settings, proof view, safety triggers.
-- Applied with:  npx wrangler d1 execute num-db --remote --file worker/num_business_schema.sql
--
-- WHY THIS FILE EXISTS
-- These tables were created directly against D1 and lived nowhere in the repo,
-- so the only copy of their definition was the database itself. This file is
-- that definition, captured verbatim from sqlite_master after the 2026-07-31
-- migration, so it is reviewable in a diff and recoverable from a clone.
--
-- IMPORTANT: `IF NOT EXISTS` means running this against a database that already
-- has an OLDER version of these tables changes nothing. SQLite cannot alter a
-- CHECK or a DEFAULT in place; correcting one means rebuild-and-rename
-- (create _new, INSERT..SELECT with explicit column lists, DROP, RENAME).
-- Before any such RENAME, drop dependent views and triggers first --
-- ALTER TABLE .. RENAME validates the WHOLE schema, and a view or trigger that
-- merely references the table will abort the rename. Find them with:
--   SELECT name, type, sql FROM sqlite_master
--    WHERE type IN ('trigger','view') AND sql LIKE '%<table>%';
-- Filtering on tbl_name is NOT enough: a view's tbl_name is its own name, and a
-- trigger's tbl_name is the table it fires ON, not the tables its body reads.

-- ── Profile ──────────────────────────────────────────────────────────────
-- One row per merchant. Created the moment a claim verifies (claim/onboard.mjs)
-- so the defaults below are what a real signup actually gets.
--
-- `vertical` holds the same 21 values agents/worker.js VERTICALS accepts. They
-- must stay in sync: when the list here was the older 9 values, a cafe -- the
-- 5th most common category in the GB/IE directory -- failed the CHECK outright.
--
-- `timezone` defaults to Etc/UTC, not a guess. A neutral-wrong default is under
-- an hour off for Britain and visibly a fallback; the previous Asia/Bangkok
-- default was seven hours off and looked deliberate.
CREATE TABLE IF NOT EXISTS num_business_profiles (
  business_id       TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  vertical          TEXT NOT NULL CHECK (vertical IN (
                      'restaurant','cafe','bar','hotel','guesthouse','hostel','spa','massage',
                      'boat','tour','market','shop','transport','taxi','event','clinic',
                      'salon','gym','attraction','nightclub','other')),
  commerce_status   TEXT NOT NULL DEFAULT 'pending' CHECK (commerce_status IN (
                      'pending','verifying','active','paused','suspended','churned')),
  country           TEXT, city TEXT, area TEXT, address TEXT,
  lat               REAL, lng REAL,
  timezone          TEXT NOT NULL DEFAULT 'Etc/UTC',
  place_id          TEXT,
  phone_e164        TEXT,
  email             TEXT,
  website           TEXT,
  notify_channel    TEXT NOT NULL DEFAULT 'none' CHECK (notify_channel IN (
                      'none','sms','whatsapp','line')),
  notify_address    TEXT,
  owner_agent       TEXT,
  verified_by       TEXT,
  verified_at       INTEGER,
  rating            REAL, reviews_count INTEGER DEFAULT 0,
  custom_fields     TEXT NOT NULL DEFAULT '{}',
  default_locale    TEXT NOT NULL DEFAULT 'en',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_numbizprof_vertical ON num_business_profiles(vertical, commerce_status);
CREATE INDEX IF NOT EXISTS idx_numbizprof_agent    ON num_business_profiles(owner_agent);
CREATE INDEX IF NOT EXISTS idx_numbizprof_area     ON num_business_profiles(city, area);


-- -------------------------------------------------------------------------
-- num_business_settings . one row per business, created in the same batch as
-- the profile above (claim/onboard.mjs, inside the verification transaction).
--
-- Every column has a DEFAULT, which is the whole point: a merchant who signs
-- up and touches nothing still lands on a coherent, chargeable configuration.
-- The f_* flags all start at 0 because a business that has just proved it
-- controls a phone number has not thereby agreed to take bookings, hold
-- deposits, or settle in Stars. The money columns start at the numbers NUM has
-- published, so the defaults and the merchant invite say the same thing.
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "num_business_settings" (
  business_id        TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  f_bookings         INTEGER NOT NULL DEFAULT 0 CHECK (f_bookings        IN (0,1)),
  f_booking_fee      INTEGER NOT NULL DEFAULT 0 CHECK (f_booking_fee     IN (0,1)),
  f_deposits         INTEGER NOT NULL DEFAULT 0 CHECK (f_deposits        IN (0,1)),
  f_orders           INTEGER NOT NULL DEFAULT 0 CHECK (f_orders          IN (0,1)),
  f_delivery         INTEGER NOT NULL DEFAULT 0 CHECK (f_delivery        IN (0,1)),
  f_sms_commerce     INTEGER NOT NULL DEFAULT 0 CHECK (f_sms_commerce    IN (0,1)),
  f_guest_list       INTEGER NOT NULL DEFAULT 0 CHECK (f_guest_list      IN (0,1)),
  f_cabanas          INTEGER NOT NULL DEFAULT 0 CHECK (f_cabanas         IN (0,1)),
  f_bottle_service   INTEGER NOT NULL DEFAULT 0 CHECK (f_bottle_service  IN (0,1)),
  f_perks            INTEGER NOT NULL DEFAULT 0 CHECK (f_perks           IN (0,1)),
  f_auto_confirm     INTEGER NOT NULL DEFAULT 0 CHECK (f_auto_confirm    IN (0,1)),

  booking_fee_cs     INTEGER NOT NULL DEFAULT 200  CHECK (booking_fee_cs     >= 0),
  fee_creditable     INTEGER NOT NULL DEFAULT 1    CHECK (fee_creditable     IN (0,1)),
  deposit_cs         INTEGER NOT NULL DEFAULT 0    CHECK (deposit_cs         >= 0),
  -- 1000bp = 10%. The merchant invite promises "10% only on completed bookings",
  -- so 10% is what a row must be worth when nobody sets it explicitly. A 0 here
  -- meant every self-serve signup silently earned NUM nothing.
  commission_bp      INTEGER NOT NULL DEFAULT 1000 CHECK (commission_bp BETWEEN 0 AND 10000),
  delivery_fee_cs    INTEGER NOT NULL DEFAULT 500  CHECK (delivery_fee_cs    >= 0),
  delivery_radius_m  INTEGER NOT NULL DEFAULT 5000 CHECK (delivery_radius_m  >= 0),

  cancel_window_min  INTEGER NOT NULL DEFAULT 120 CHECK (cancel_window_min  >= 0),
  confirm_window_min INTEGER NOT NULL DEFAULT 15  CHECK (confirm_window_min >  0),
  hold_ttl_min       INTEGER NOT NULL DEFAULT 10  CHECK (hold_ttl_min       >  0),

  max_booking_fee_cs INTEGER NOT NULL DEFAULT 5000,
  updated_at         INTEGER NOT NULL,
  updated_by         TEXT,
  f_stars_settle     INTEGER NOT NULL DEFAULT 0,
  f_crypto_settle    INTEGER NOT NULL DEFAULT 0,
  stars_approved_at  INTEGER,
  stars_approved_by  TEXT,
  CHECK (booking_fee_cs <= max_booking_fee_cs)
) STRICT;

-- -------------------------------------------------------------------------
-- v_num_business_proof . what a merchant's proof state looks like from outside.
-- Read-only, so the console and the agent API can both select it and neither
-- can assert a proof that was never earned.
-- -------------------------------------------------------------------------

CREATE VIEW IF NOT EXISTS v_num_business_proof AS
SELECT b.id AS business_id, b.name,
       p.vertical, p.city, p.country, p.commerce_status,
       (SELECT COUNT(DISTINCT e.member_ref) FROM num_business_events e
         WHERE e.business_id = b.id AND e.guest_level >= 3)              AS verified_humans_served,
       (SELECT COUNT(DISTINCT e.member_ref) FROM num_business_events e
         WHERE e.business_id = b.id)                                     AS people_served,
       (SELECT COUNT(*) FROM num_business_events e
         WHERE e.business_id = b.id AND e.event_type='booking_made')     AS bookings_made,
       (SELECT COUNT(*) FROM num_business_events e
         WHERE e.business_id = b.id AND e.event_type='booking_honoured') AS bookings_honoured,
       ROUND(100.0 *
         (SELECT COUNT(*) FROM num_business_events e
           WHERE e.business_id = b.id AND e.event_type='booking_honoured')
         / NULLIF((SELECT COUNT(*) FROM num_business_events e
                    WHERE e.business_id = b.id AND e.event_type='booking_made'),0), 1)
                                                                          AS kept_promises_pct,
       (SELECT COUNT(*) FROM num_business_proof x
         WHERE x.business_id = b.id AND x.is_test = 0 AND x.revoked_at IS NULL
           AND (x.expires_at IS NULL OR x.expires_at > strftime('%s','now'))) AS live_claims
FROM businesses b
LEFT JOIN num_business_profiles p ON p.business_id = b.id;

-- -------------------------------------------------------------------------
-- Stars settlement guards.
--
-- Settling a bill in Stars moves real value to a merchant, so it may only
-- happen for a business that signed up, was approved, and carries
-- f_stars_settle=1. That is enforced here rather than in a Worker, because a
-- Worker can be bypassed by a direct D1 write and a trigger cannot. They fire
-- on INSERT into num_bills, on UPDATE OF rail on num_bills (so a non-Stars
-- bill cannot be quietly switched to Stars afterwards), and on INSERT into
-- num_bill_shares.
--
-- These are also why ALTER TABLE .. RENAME on num_business_settings aborts
-- unless they are dropped first: their bodies reference that table even though
-- sqlite_master.tbl_name for all three reads num_bills / num_bill_shares.
-- -------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_bill_stars_requires_approved_merchant
BEFORE INSERT ON num_bills
WHEN NEW.rail = 'stars'
 AND COALESCE((SELECT f_stars_settle FROM num_business_settings
                WHERE business_id = NEW.business_id), 0) <> 1
BEGIN
  SELECT RAISE(ABORT, 'stars settlement requires a signed-up, approved merchant');
END;

CREATE TRIGGER IF NOT EXISTS trg_bill_stars_requires_approved_merchant_upd
BEFORE UPDATE OF rail ON num_bills
WHEN NEW.rail = 'stars'
 AND COALESCE((SELECT f_stars_settle FROM num_business_settings
                WHERE business_id = NEW.business_id), 0) <> 1
BEGIN
  SELECT RAISE(ABORT, 'stars settlement requires a signed-up, approved merchant');
END;

CREATE TRIGGER IF NOT EXISTS trg_share_stars_requires_approved_merchant
BEFORE INSERT ON num_bill_shares
WHEN NEW.rail = 'stars'
 AND COALESCE((SELECT s.f_stars_settle FROM num_business_settings s
                 JOIN num_bills b ON b.business_id = s.business_id
                WHERE b.id = NEW.bill_id), 0) <> 1
BEGIN
  SELECT RAISE(ABORT, 'stars settlement requires a signed-up, approved merchant');
END;

-- -------------------------------------------------------------------------
-- NOT IN THIS FILE, deliberately: num_agent_clients.commission_bp.
--
-- It defaults to 0 and stays there. num_agent_clients is defined in
-- agents/schema.sql, which says of it: "a human sales agent's client book
-- (stage, commission_bp)" that "has nothing to do with software agents".
--
-- Unlike num_business_settings.commission_bp, where a 0 default contradicted
-- the published "10% only on completed bookings" and silently earned NUM
-- nothing on every self-serve signup, there is no published agent revenue
-- share for a 0 here to contradict. 0 means "nothing agreed yet", which is
-- true. Defaulting it to anything else would invent a commitment to a person
-- nobody has negotiated with.
-- -------------------------------------------------------------------------

-- -------------------------------------------------------------------------
-- ALSO IN D1, WIRED TO NOTHING (checked 2026-07-31).
--
-- Three more tables sit in this family and are referenced by no code in this
-- repo -- a grep for each name across every .js/.mjs/.sql/.html returns only
-- this file, and only because v_num_business_proof contains the substring:
--
--   num_business_users   1 row   owner/manager/staff/readonly per business
--   num_business_events  2 rows
--   num_business_proof   0 rows  verified_operator / served_humans /
--                                kept_promises, with a jti into num_proofs
--
-- Their DDL is deliberately NOT copied below. Writing it here would file them
-- alongside the profile and settings tables as though they were part of the
-- working merchant layer, and they are not: merchant ownership is carried by
-- num_place_owners, and worker/console.mjs authenticates on ADMIN_KEY, not on
-- num_business_users. A reader who needs them can recover the exact text:
--
--   npx wrangler d1 execute num-db --remote --command \
--     "SELECT sql FROM sqlite_master WHERE name LIKE 'num_business_%'"
--
-- Worth knowing before building merchant login or merchant-facing proof: the
-- shape someone intended already exists, and num_business_proof in particular
-- lines up with the three claims 5arz issues.
-- -------------------------------------------------------------------------
