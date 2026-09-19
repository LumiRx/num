-- 0047 — tracking every step of a bill, not just the scan.
--
-- WHAT WAS MISSING
-- num_pay_events recorded a scan and little else: scan, tap_through,
-- retired_view, receipt_view, unknown_token. Every one of those happens on
-- num-growth, on the /p/ page. The half where the money actually moves lives
-- on num-app -- the rail a guest chose, the Checkout session that opened, the
-- webhook that settled it, the till that closed or refused -- and NONE of it
-- was written down anywhere. So "how many people who scanned actually paid,
-- and by what" was a question the system could not answer about itself, which
-- is the same shape of blindness as a bill with no payer.
--
-- These columns turn the table into the funnel it was already halfway to
-- being. rail is which way they paid or tried to, member_id is who when we
-- know, and detail is the reason on a refusal -- a funnel that says 40 people
-- dropped is interesting, one that says 40 people dropped because Pay by Bank
-- is not switched on in that venue's Stripe account is actionable.
--
-- Additive, nullable, and read behind a fallback, so this runs before or after
-- the deploy without a broken pay page in between.

-- Which rail the event is about: card, pay_by_bank, promptpay_sticker, autopay.
ALTER TABLE num_pay_events ADD COLUMN rail TEXT;
-- Who, when a signed-in member did it. NULL for a browser, which is most scans.
ALTER TABLE num_pay_events ADD COLUMN member_id TEXT;
-- The reason, on anything that did not go through. Never free-form from a
-- caller we do not control, and never a card number or a token secret.
ALTER TABLE num_pay_events ADD COLUMN detail TEXT;
-- Minor units, on the events where an amount is the point.
ALTER TABLE num_pay_events ADD COLUMN amount_minor INTEGER;

-- The funnel is always read per venue over a date range, and the existing
-- index is (business_id, day) which already serves that. This one serves the
-- other question: everything that happened to ONE bill, in order, which is
-- what a person asks when a single guest says they paid and the venue says
-- they did not.
CREATE INDEX IF NOT EXISTS idx_pay_events_token_kind ON num_pay_events(token, kind, created_at);
