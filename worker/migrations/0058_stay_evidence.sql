-- 0058 — the evidence behind a stay, not just its price.
--
-- 0052 stored what the guest paid and what the supplier called the public
-- price. That was enough to answer "what did this cost" and not enough to
-- answer the two questions that actually get asked later:
--
--   "Was that saving real?"      — one reference is an assertion. 0058 stores
--                                  the SECOND one and whether they agreed.
--   "Did we tell them?"          — a chain booking through NUM loses the
--                                  guest's points and, at some chains, their
--                                  elite benefits. Whether that was disclosed
--                                  before they booked is a fact about NUM's
--                                  conduct, and it is worth being able to
--                                  prove rather than remember.
--
-- ══ WHY THIS IS A NEW FILE AND NOT AN EDIT TO 0052 ══════════════════════
--
-- 0052 is sealed. A sealed migration must never change again: re-running an
-- edited file whose CREATE TABLE IF NOT EXISTS already matched is a silent
-- no-op, so the edit reaches fresh databases and no existing one. That is how
-- booking_fee_minor went missing for weeks while every test passed.
--
-- ══ ONE ALTER PER STATEMENT ═════════════════════════════════════════════
--
-- Deliberate, and enforced by migrationhygiene.test.mjs: a duplicate-column
-- error on the first ALTER would roll back every one that followed it.

-- The price-index figure for the same property, by a different route.
ALTER TABLE num_stay_bookings ADD COLUMN public_ref_cs INTEGER;

-- agreed | disagreed | one_sided | nonsense. Stored as the supplier's own
-- verdict rather than a boolean, because "we only ever had one number" and
-- "we had two and they contradicted each other" are different situations and
-- a boolean would flatten them into the same row.
ALTER TABLE num_stay_bookings ADD COLUMN public_ref_verdict TEXT;

-- How far apart, as a percentage. Kept so a pattern of small disagreements is
-- visible before it becomes a large one.
ALTER TABLE num_stay_bookings ADD COLUMN public_ref_gap_pct REAL;

-- The chain, where there is one. This is what decides whether the loyalty
-- disclosure applied at all — an independent has no points to lose.
ALTER TABLE num_stay_bookings ADD COLUMN hotel_chain TEXT;

-- 1 when NUM showed the guest the loyalty warning before they confirmed.
-- NULL means the question did not arise, because it was not a chain property.
-- 0 means it did arise and the warning was not shown, which is the row
-- somebody should be unhappy about.
ALTER TABLE num_stay_bookings ADD COLUMN loyalty_disclosed INTEGER;

-- The two timestamps a concierge is asked about more than any others, and
-- which NUM has never held: "the room is not ready until 3pm, so leave the
-- bags and go and eat" is the whole job.
ALTER TABLE num_stay_bookings ADD COLUMN checkin_from TEXT;

ALTER TABLE num_stay_bookings ADD COLUMN checkout_before TEXT;

-- Which of the six ways of naming a place this search actually used. A search
-- that fell back to a city name when a neighbourhood was asked for is a worse
-- answer, and until it is recorded nobody can tell how often that happens.
ALTER TABLE num_stay_bookings ADD COLUMN place_resolution TEXT;

-- Where a disagreement or a disclosure is worth finding again in bulk.
CREATE INDEX IF NOT EXISTS idx_stay_bookings_ref_verdict
  ON num_stay_bookings (public_ref_verdict);
