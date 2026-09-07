-- SIX BUSINESSES ARE MARKED "TOLD" AND WERE NEVER TOLD.
--
-- 30 Aug 2026, 19:46 — the mail selftest passed "via cloudflare".
-- 30 Aug 2026, 20:26 — six approved businesses were handed to that same
-- transport. The Cloudflare binding ACCEPTED all six and returned ok, so
-- num_claim_decisions.onboarded was set to 1 on every one of them.
--
-- The binding only delivers to verified destination addresses on the account.
-- reception@hieedinburgh.co.uk is not one. Nothing was delivered, nothing
-- bounced, nothing threw, and the retry sweep in bizonboard.onboardApproved
-- filters on `COALESCE(d.onboarded, 0) = 0` — so all six are skipped forever.
--
-- Turning BIZ_ONBOARD_EMAIL on without running this first sends ZERO emails
-- and looks like success.
--
-- Run it against the LIVE database, in this order, and read the SELECTs.

-- 1. WHAT YOU ARE ABOUT TO CHANGE. Six rows, all decided in the same
--    three-second batch by auto:unverified, none of them ever verified.
SELECT c.id, c.business_name, c.email, d.decision, d.decided_by, d.onboarded
  FROM claims c
  JOIN num_claim_decisions d ON d.claim_id = CAST(c.id AS TEXT)
 WHERE d.decision = 'approved'
   AND d.onboarded = 1
   AND c.email IS NOT NULL AND c.email <> ''
 ORDER BY c.id;

-- 2. Undo the claim. `onboarded` should mean "a transport that can reach a
--    stranger carried this", and none of these were.
UPDATE num_claim_decisions
   SET onboarded = 0
 WHERE claim_id IN (
   SELECT CAST(c.id AS TEXT) FROM claims c
    WHERE c.email IS NOT NULL AND c.email <> ''
 )
   AND decision = 'approved'
   AND onboarded = 1;

-- 3. CONFIRM: six rows now waiting to be told, and the sweep will pick them up
--    on the next five-minute tick once BIZ_ONBOARD_EMAIL is on AND Resend can
--    actually send. If Resend is still returning 401, they will NOT be marked
--    told — the failure lands in num_failures and on /api/health instead.
SELECT COUNT(*) AS waiting_to_be_told
  FROM claims c
  JOIN num_claim_decisions d ON d.claim_id = CAST(c.id AS TEXT)
 WHERE d.decision = 'approved' AND COALESCE(d.onboarded,0) = 0
   AND c.email IS NOT NULL AND c.email <> '';
