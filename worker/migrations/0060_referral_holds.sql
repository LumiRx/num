-- 0060 — referral earnings that were NOT paid automatically, and why.
--
-- ══ THE THING THIS EXISTS FOR ══════════════════════════════════════════
--
-- Flagged in the 19 Sep review and confirmed: create a second member account,
-- sign it up through your own referral link, then do all your NUM booking
-- from it. Every commission NUM collects on your own spending pays you 20%
-- back in cashable Stars, for ever, uncapped. Nothing in the anti-farming
-- rules touches it, because the account is real, verified and active — it is
-- one person, not a farm.
--
-- ══ AND THE REASON IT IS A HOLD RATHER THAN A REFUSAL ══════════════════
--
-- A husband referring his wife, who then books dinners, is EXACTLY what the
-- programme is for. The signals cannot tell that apart from one person with
-- two accounts: both are two accounts on one sofa, one router, sometimes one
-- tablet.
--
-- The only evidence that truly separates them is a 5arz identity, because
-- /verify/5arz refuses to link one identity to two Num accounts — so two real
-- people can both verify and one person cannot. Everything short of that is
-- suspicion, and a wrongly refused payment is worse than a wrongly counted
-- referral: it is somebody's money, taken silently, by a rule they cannot see.
--
-- So a suspicious credit is HELD, not dropped. The row records exactly what
-- would have been paid and why it was not, a person decides, and releasing it
-- pays the original amount under the original ref — which the idempotency key
-- in creditMemberReferral makes safe to do once and only once.
--
-- An empty table means nothing was ever suspicious. A row that sits here for
-- weeks is somebody NUM owes an answer to, which is the same rule the
-- milestone queue works by.
CREATE TABLE IF NOT EXISTS num_referral_holds (
  id            TEXT PRIMARY KEY,
  -- The caller's settlement ref. Releasing replays exactly this, so the
  -- payment cannot be made twice.
  ref           TEXT NOT NULL,
  -- Who would have been paid, and whose activity produced it.
  referrer_id   TEXT NOT NULL,
  member_id     TEXT NOT NULL,
  stars         INTEGER NOT NULL CHECK (stars > 0),
  pct           INTEGER,
  reason        TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'held'
                CHECK (state IN ('held','released','refused')),
  decided_by    TEXT,
  decided_at    TEXT,
  created_at    TEXT NOT NULL
);
-- One hold per settlement. Without this a retried settle writes a second hold
-- for money that was already held once, and releasing both would pay twice —
-- except that the star move id would refuse the second, leaving a released
-- row that paid nothing and a ledger that disagrees with the queue.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hold_ref ON num_referral_holds(ref);
CREATE INDEX IF NOT EXISTS idx_hold_open ON num_referral_holds(state, created_at);
