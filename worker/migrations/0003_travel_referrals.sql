-- 0003 — the travel referral. The handoff record for a booking Num does NOT make.
--
-- WHY THIS TABLE EXISTS
-- Num finds the itinerary and hands a qualified request to a travel agency. The
-- AGENCY quotes, takes the traveller's payment and issues the confirmation. Num
-- never touches the money and never issues anything. That single property is
-- what sizes Num's California surety bond at zero — §17550.11 sizes the bond to
-- the passenger money the seller HOLDS, and this structure holds none. The
-- reasoning is HQ/divisions/num/REFERRAL_STRUCTURE_ANALYSIS.md §1.
--
-- WHY IT IS NUMBERED
-- Same reason as 0002_passengers.sql: most of Num's schema arrives through lazy
-- CREATE TABLE IF NOT EXISTS plus ALTERs that swallow their own errors
-- (worker/social.mjs:88-121). That is right for a nullable display column. It is
-- wrong for a table that is the only record of what a member was promised and
-- what an agency owes us. 0001 is still reserved for 0001_consent.sql, which is
-- approved and unbuilt.
--
-- worker/travelreferral.mjs inlines these statements verbatim, because a Worker
-- has no filesystem. THIS FILE IS THE READABLE COPY AND THE ONE TO EDIT FIRST;
-- worker/travelreferral.test.mjs fails if the two ever disagree, using the same
-- statementsOf() comparison passengers.test.mjs:637 uses.
--
-- ── WHAT MAY NEVER APPEAR IN THIS TABLE ──────────────────────────────────
-- No card number, no CVV, no PAN, no payment token, no bank account, no
-- gateway customer id — nothing that could be used to charge a traveller. The
-- moment such a column exists, somebody fills it, and the bond is back. There
-- is no column here for it and worker/travelreferral.mjs refuses a request body
-- that carries one (see PAYMENT_KEYS). The traveller pays the AGENCY, on the
-- agency's own rail, on the agency's own statement.
--
-- Nor is there a column for a Num-computed price. `quote_amount_cs` holds the
-- number the PARTNER sent back, verbatim, alongside the partner's currency —
-- it is a quote we relay, never a price we calculated.

CREATE TABLE IF NOT EXISTS num_travel_referrals (
  id                     TEXT PRIMARY KEY,          -- tr_<uuid>, internal
  -- The human-readable handle. It goes in the email subject, the WhatsApp
  -- message and the agency's own system, and a human reads it aloud on the
  -- phone — so it is short, unambiguous and has no letter that can be confused
  -- with a digit (no I, O, 0, 1). Unique index, because two referrals sharing a
  -- reference is an argument about money in month two.
  ref                    TEXT NOT NULL,
  member_id              TEXT NOT NULL,             -- num_members.id

  -- ── who it went to ────────────────────────────────────────────────────
  -- Copied ONTO THE ROW at send time, never re-read from config. An agency
  -- that changes its handoff address next quarter must not silently rewrite
  -- where last quarter's referrals went — that is the bizreferral.mjs rule
  -- about recording a rate on the row, applied to an address.
  partner_id             TEXT NOT NULL,
  partner_name           TEXT,
  partner_email          TEXT,

  -- ── the request ───────────────────────────────────────────────────────
  product                TEXT NOT NULL DEFAULT 'flight',
  origin                 TEXT,
  destination            TEXT,
  depart_on              TEXT,
  return_on              TEXT,
  adults                 INTEGER NOT NULL DEFAULT 1,
  children               INTEGER NOT NULL DEFAULT 0,
  cabin                  TEXT,
  -- The TRAVELLER's budget, in the traveller's own currency. Their number, not
  -- ours: a ceiling the agency prices against, never a price Num quoted.
  budget_cs              INTEGER,
  budget_currency        TEXT,
  notes                  TEXT,

  -- ── how the agency reaches the traveller ──────────────────────────────
  -- The minimum the booking needs, and nothing else. No member export, no list
  -- sharing — LETSGO2TRIP_MEETING_BRIEF.md §5, hard rule #4.
  contact_name           TEXT,
  contact_email          TEXT,
  contact_phone          TEXT,

  -- ── the state machine ─────────────────────────────────────────────────
  -- draft → sent → quoted → accepted → confirmed
  -- and from any live state → declined | cancelled | expired.
  -- Enforced by the CHECK here and by the WHERE-clause guard on every UPDATE
  -- in travelreferral.mjs, exactly as bookdesk.mjs guards its one transition.
  state                  TEXT NOT NULL DEFAULT 'draft'
                         CHECK (state IN ('draft','sent','quoted','accepted','confirmed','declined','cancelled','expired')),

  -- ── what the partner sent back ────────────────────────────────────────
  quote_amount_cs        INTEGER,                   -- the PARTNER's number
  quote_currency         TEXT,
  quote_note             TEXT,
  quote_url              TEXT,                      -- the partner's own payment/quote page
  -- The agency's own booking reference, once they issue it. This is the field
  -- that proves the agency — not Num — made the booking.
  partner_ref            TEXT,

  -- ── the money, which is Num's only revenue line here ──────────────────
  commission_bp          INTEGER,                   -- recorded at send time
  commission_expected_cs INTEGER,
  commission_received_cs INTEGER NOT NULL DEFAULT 0,

  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at                TEXT,
  quoted_at              TEXT,
  accepted_at            TEXT,
  confirmed_at           TEXT,
  cancelled_at           TEXT,
  commission_paid_at     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_travelref_ref ON num_travel_referrals (ref);
CREATE INDEX IF NOT EXISTS idx_travelref_member ON num_travel_referrals (member_id, created_at);
CREATE INDEX IF NOT EXISTS idx_travelref_partner ON num_travel_referrals (partner_id, state, created_at);
