-- 0010 — the venue's own switches, and the undertaking that comes with tips.
--
-- 0009 gave the schema f_priority_seating and priority_max_cs, and 0008 gave
-- it f_bill_value. Between them they decide what a venue is charged and what
-- a guest is offered. Until today NOTHING IN THE REPO COULD WRITE ANY OF
-- THEM: there was no UPDATE num_business_settings anywhere — not in a venue
-- route, not in an admin route, not in worker/console.mjs. Every flag was
-- created at 0 by claim/onboard.mjs and stayed 0 forever unless somebody ran
-- raw SQL against production by hand.
--
-- So the settings existed, the consumers existed, and the branch that reads
-- "the venue turned this on" had never once been taken. growth/venuesettings.mjs
-- is the missing writer. This migration adds the one column it needs that
-- 0008 and 0009 did not already provide.
--
-- ── f_tips ───────────────────────────────────────────────────────────────
--
-- Whether NUM ASKS a guest to leave something for the server. It does not
-- gate aftertable.tip(), and that separation is deliberate: tip() records a
-- tip that has already happened, and a fact about money that moved must be
-- recorded whatever a flag says. The flag gates the OFFER.
--
-- Default 0, and it stays 0 until a human turns it on, for two reasons:
--
--   1. A tip NUM records that nobody can pay out is worse than no tip prompt.
--      The rail is the venue's — their paylink, their bill QR, or cash in a
--      hand. NUM never holds it (see 0009). A venue with no rail configured
--      cannot receive one.
--   2. Tipping is not universal. Prompting for a tip in a country where
--      service is included reads as an American platform exporting an
--      American habit, and at a venue that has told its staff not to accept
--      tips it is worse than rude.
--
-- ── tips_terms_at / tips_terms_by ────────────────────────────────────────
--
-- Turning tips on is a written undertaking, not a preference: 29 U.S.C.
-- §203(m)(2)(B) — no employer, manager or supervisor may keep any part of an
-- employee's tips. NUM cannot enforce that inside a venue. What it can do is
-- record that the person who switched it on was shown the sentence and
-- accepted it, with a timestamp, so the undertaking is evidence rather than
-- an assumption. A venue that turns tips off does not lose the record that it
-- once accepted — the acceptance is a historical fact.

ALTER TABLE num_business_settings
  ADD COLUMN f_tips INTEGER NOT NULL DEFAULT 0 CHECK (f_tips IN (0,1));

ALTER TABLE num_business_settings ADD COLUMN tips_terms_at INTEGER;
ALTER TABLE num_business_settings ADD COLUMN tips_terms_by TEXT;

-- Who changed a setting, when, and what it was before.
--
-- num_business_settings holds only the current value, and the current value
-- cannot answer "we were charged 10% of the bill in March, who agreed to
-- that". A merchant is entitled to that answer, and so is NUM the first time
-- a venue disputes an invoice. One row per field per change, keyed to nothing
-- else, so it survives the settings row being rewritten.
CREATE TABLE IF NOT EXISTS num_business_setting_log (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  field       TEXT NOT NULL,
  was         TEXT,
  now         TEXT,
  changed_by  TEXT,          -- 'key' for the console link, else a staff email
  via         TEXT,          -- 'key' | 'session' | 'admin'
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bizsetlog ON num_business_setting_log(business_id, created_at);
