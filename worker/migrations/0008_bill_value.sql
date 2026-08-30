-- Can this venue tell NUM what the guest actually spent?
--
-- Written 26 Aug 2026, with the 10% / $2 split in worker/commission.mjs.
--
-- The business page, the merchant invite and the Thai rate card have all
-- promised "10% on completed bookings" since the beginning. The ledger charged
-- $2 flat everywhere except Thailand. Two prices in public, one in the code.
-- 10% is now the rate everywhere — but only where there is a bill to take ten
-- percent OF.
--
-- ── WHY THIS IS A CAPABILITY, NOT A COUNTRY ──────────────────────────────
--
-- The old override was keyed on country: TH got 10% because Thai venues were
-- the ones being signed onto NUM's bill QR. That was never really about
-- Thailand. It was about whether anything in the venue reports a total, and a
-- Bali warung with a connected POS and a Bangkok bar with none are on the
-- wrong side of a country flag.
--
-- So the question is asked directly. 1 means something the venue uses tells us
-- the bill: the NUM bill QR, a connected POS, or a merchant who reports
-- totals. 0 — the default, and the honest default — means it does not, and the
-- $2 floor applies instead.
--
-- ── WHY THE FLOOR IS NOT ZERO ────────────────────────────────────────────
--
-- Ten percent of a bill nobody reported is nothing. Before today a venue in
-- Thailand that took fifty NUM tables and never once scanned the QR was
-- invoiced zero, for ever, and the ledger showed fifty healthy accruals the
-- whole time. $2 also sits inside the $1–3 per cover OpenTable and TheFork
-- charge, so a venue with no system is paying a rate it can check against a
-- competitor rather than a number we invented.
--
-- Setting this to 1 is therefore a real commitment on NUM's side as much as
-- the venue's: it switches that venue from a fee we can always collect to one
-- that depends on them reporting. Do not set it optimistically.

ALTER TABLE num_business_settings
  ADD COLUMN f_bill_value INTEGER NOT NULL DEFAULT 0
  CHECK (f_bill_value IN (0,1));
