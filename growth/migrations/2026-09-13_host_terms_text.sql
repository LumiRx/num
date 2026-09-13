-- num_hosts.agreed_ip has been holding the TERMS TEXT since the column existed.
--
-- The INSERT in hostJoin lists 16 columns and binds 14 values against 14
-- placeholders, and the values slid: `String(b.terms_text).slice(0, 1200)`
-- landed in `agreed_ip`, because there was never a terms_text column to put it
-- in. Live row confirms it — agreed_ip reads "I have read the terms and the
-- privacy policy...".
--
-- Two consequences, and the second is why it surfaced now:
--   · The legal record is missing. agreed_ip exists to say WHO agreed, and it has
--     never held an address. The terms text was captured, which is the more
--     important half, but in the wrong box and unlabelled.
--   · Anything keyed on agreed_ip silently matches nothing. The new host-signup
--     rate limit counts accounts per network off this column, and would have
--     compared a hash against a paragraph of prose and never fired — a limit
--     that looks present in code review and does nothing in production, which
--     is the failure mode this whole review has been about.
--
-- agreed_ip is stored HASHED, not raw. It is the same per-IP hash used across
-- num_venue_scans and num_key_events: enough to prove two agreements came from
-- one network and to enforce a daily cap, without keeping a log of addresses.
ALTER TABLE num_hosts ADD COLUMN terms_text TEXT;

UPDATE num_hosts
   SET terms_text = agreed_ip,
       agreed_ip  = NULL
 WHERE terms_text IS NULL
   AND agreed_ip IS NOT NULL
   AND length(agreed_ip) > 45;

CREATE INDEX IF NOT EXISTS idx_hosts_agreed_ip_created
  ON num_hosts (agreed_ip, created_at);
