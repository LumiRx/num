-- 0042 — a member's standing permission for NUM to pay a bill without a tap,
-- and a record of every time it was used.
--
-- This is the most dangerous table in the product, so it is also the most
-- written-down. cap_minor is the member own ceiling and is clamped
-- server-side - `mandate_text` is the exact sentence they agreed to, stored
-- with the row rather than living only in a screen somebody redesigns next
-- quarter -- card network rules require the mandate to state what is
-- authorised, how often, and how the amount is decided, and a mandate you
-- cannot produce afterwards is a mandate you did not take.
--
-- num_autopay_attempts exists because a standing instruction to move somebody
-- money has to be auditable by the person whose money it is. Every attempt
-- lands here, paid or refused, with the reason. It is also what enforces the
-- per-day ceiling, so a compromised session cannot drain a card.
--
-- NOTE ON WHAT IS NOT HERE: no card number, no last four, no expiry. The
-- payment method lives at Stripe and this holds its id.

CREATE TABLE IF NOT EXISTS num_member_autopay (
  member_id           TEXT PRIMARY KEY,
  stripe_customer_id  TEXT,
  payment_method_id   TEXT,
  cap_minor           INTEGER,
  currency            TEXT,
  state               TEXT NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending','on','off')),
  mandate_text        TEXT,
  mandate_at          TEXT,
  last_used_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS num_autopay_attempts (
  id                 TEXT PRIMARY KEY,
  member_id          TEXT NOT NULL,
  token              TEXT,
  business_id        TEXT,
  amount_minor       INTEGER,
  currency           TEXT,
  state              TEXT NOT NULL CHECK (state IN ('paid','failed')),
  reason             TEXT,
  payment_intent_id  TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_autopay_attempts_member ON num_autopay_attempts(member_id, created_at);
