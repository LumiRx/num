-- 0013 — the VIP host's COMMERCIAL profile. What they sell, and who charges.
--
-- STATUS: apply with `wrangler d1 execute num-db --file=...`, one statement at
-- a time. SQLite has no ADD COLUMN IF NOT EXISTS, so a second run fails
-- harmlessly per statement with "duplicate column name" — do NOT wrap these in
-- a transaction, or one duplicate rolls the whole thing back.
--
-- ══ WHAT ALREADY EXISTS — DO NOT REBUILD IT ═════════════════════════════
-- num_hosts, num_host_uploads, num_host_contacts and num_host_earnings are
-- LIVE IN PRODUCTION and held 0 rows on 1 Sep 2026 — not because the system
-- failed, but because it never had a front door: /hosts/ offered a mailto:
-- link and /host/?k= (the console URL every welcome email sends) was a 404.
-- growth/worker.js already serves /api/host/join, /api/host/summary and
-- /api/host/contacts, and already enforces the consent attestation, the
-- suppression check and double opt-in. None of that is re-created here.
--
-- worker/migrations/0004_hosts.sql specifies services_json, areas_json and
-- verified_at and was never applied. The three ALTERs below use those EXACT
-- names and types so that applying 0004 afterwards fails on "duplicate column"
-- rather than silently diverging. If you are about to add a column that
-- another migration already names: stop, and reconcile instead.

-- ── from 0004, folded in so the two files cannot disagree ────────────────
-- What they can take. JSON array of service keys from the num_commissions
-- vocabulary: 'car','reservation','stay','activity','appointment','delivery'.
ALTER TABLE num_hosts ADD COLUMN services_json TEXT NOT NULL DEFAULT '[]';

-- Where. JSON array of {country, city, lat, lng, radius_km}. Coarse on
-- purpose: dispatch is a phone call, not a delivery grid.
ALTER TABLE num_hosts ADD COLUMN areas_json TEXT NOT NULL DEFAULT '[]';

-- Set when a human has actually spoken to them. A host is a supplier we put in
-- front of paying guests, so "signed up" and "trusted" must be separate facts.
ALTER TABLE num_hosts ADD COLUMN verified_at TEXT;

-- ── the commercial profile ──────────────────────────────────────────────
-- What each service costs and how it is quoted. JSON array of
-- {key, label, price_minor, currency, unit, fulfilment, notes}.
--
-- `unit` is 'hour' | 'day' | 'trip' | 'person' | 'item' | 'quote' — 'quote'
-- meaning the price is agreed per request and price_minor is ignored. A host
-- who cannot say "it depends" will invent a number, and an invented number is
-- one their client will hold them to.
--
-- `fulfilment` is 'delivered' | 'on_site' | 'either'. This is the delivery /
-- non-delivery split: a florist delivers, a masseuse comes to you, a driver is
-- neither. Stored per SERVICE, not per host, because most hosts do both.
ALTER TABLE num_hosts ADD COLUMN pricing_json TEXT NOT NULL DEFAULT '[]';

-- WHO TAKES THE MONEY. 'own' = the client pays the host directly and NUM never
-- touches it — 'num' = NUM collects and settles to the host.
--
-- DEFAULT IS 'own' AND THAT IS DELIBERATE. Collecting on someone's behalf makes
-- us a payment intermediary for their business, with their refunds, their
-- chargebacks and their tax position attached. A host must ASK for that — it
-- must never be what happens because they skipped a field. The same instinct
-- that keeps NUM out of the traveller's money in worker/preflight.mjs applies
-- here for the same reason.
ALTER TABLE num_hosts ADD COLUMN charge_mode TEXT NOT NULL DEFAULT 'own'
  CHECK (charge_mode IN ('own','num'));

-- The currency they quote in. Their clients' money, not ours, so it is theirs
-- to set and we never convert it silently.
ALTER TABLE num_hosts ADD COLUMN currency TEXT NOT NULL DEFAULT 'GBP';

-- Which NUM for Business plan they are on, same vocabulary as bizbilling.mjs
-- (free | small | pro | full). A host manages clients exactly the way a
-- business manages locations, so they buy the same shelf rather than a second
-- price list nobody maintains.
ALTER TABLE num_hosts ADD COLUMN tier TEXT NOT NULL DEFAULT 'free';

-- An ICS feed we can write their confirmed requests into. Read-only from our
-- side: we publish, their calendar subscribes. Nothing of ours ever needs
-- write access to a person's calendar, and asking for it would be the single
-- most invasive permission in the product.
ALTER TABLE num_hosts ADD COLUMN calendar_token TEXT;

-- Where the coordinating texts go, and whether they are wanted at all.
-- Separate from `phone`, because the number on the application is often a
-- landline or an office and the person who needs the 6am message is not
-- always at it.
ALTER TABLE num_hosts ADD COLUMN notify_phone TEXT;
ALTER TABLE num_hosts ADD COLUMN sms_opt_in INTEGER NOT NULL DEFAULT 0
  CHECK (sms_opt_in IN (0,1));

-- Last time the host themselves saved the profile. A profile nobody has
-- touched since signup is a profile whose prices are wrong, and the dashboard
-- should be able to say so out loud rather than quoting stale money.
ALTER TABLE num_hosts ADD COLUMN profile_updated_at TEXT;

-- Only ever queried by console key, which is a unique random token — the index
-- is what stops that lookup being a table scan once there are hosts.
CREATE INDEX IF NOT EXISTS idx_hosts_console_key ON num_hosts(console_key);
