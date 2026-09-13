-- Cap partner-key minting per network.
--
-- POST /api/partner/signup is unauthenticated and instant, and BOTH its reply
-- and the email it sends contain a live API key. The only guard was one active
-- key per email address, which stops one address minting ten thousand
-- identities and does nothing about one script using ten thousand addresses --
-- each one mailing a working credential from partners@itsnum.com to an inbox
-- the attacker chose. That spends the sending reputation the booking
-- confirmations depend on.
--
-- Hashed, like every other per-network counter here. Enough to cap a script,
-- not a log of who visited.
ALTER TABLE num_partner_keys ADD COLUMN signup_ip TEXT;

CREATE INDEX IF NOT EXISTS idx_partner_signup_ip
  ON num_partner_keys (signup_ip, created_at);
