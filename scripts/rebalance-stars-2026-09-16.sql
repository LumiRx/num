-- REBALANCING THE WELCOME GRANT: ★100 → ★5 · 16 Sep 2026
--
-- Dre, 16 Sep 2026: "lets also make everyone stars that has 100 stars rn
-- other than nico 5 stars."
--
-- 94 accounts sit on exactly ★100, every one of them a single `welcome` move
-- that reconciles to the balance exactly. This brings them to ★5, which is the
-- new WELCOME_STARS in worker/social.mjs.
--
-- ── WHY THE REVERSAL IS A `welcome` MOVE AND NOT AN `adjustment` ─────────
--
-- starmembership.mjs `spendable()` splits a balance by ORIGIN: it sums every
-- move whose kind is NOT in PROMO_KINDS (['welcome']) and calls that the
-- member's own money. An `adjustment` of -95 would land on the OWN side of
-- that sum. For a member holding only the grant it happens to come out right,
-- because the sum is clamped at zero — but the moment that member buys Stars
-- the -95 nets against their purchase and they are told 95 of the Stars they
-- paid for are promotional and cannot be spent.
--
-- Booking the reversal as `welcome` keeps it on the promotional side of the
-- ledger, where the Stars came from. The arithmetic then stays right at every
-- later balance. Proven in worker/rebalance.test.mjs.
--
-- ── NICO ─────────────────────────────────────────────────────────────────
--
-- mem_8f6b04ed879a4c2a86c9 paid $150 for ★500 and sits on ★600. He is not on
-- ★100, so `WHERE stars = 100` never reaches him. No special case is needed
-- and none is written: a hard-coded exclusion is a thing that rots.
--
-- ── SAFE TO RUN TWICE ────────────────────────────────────────────────────
--
-- The move id is the guard, exactly as it is for the grant itself. A second
-- run inserts nothing and updates nothing.
--
--   npx wrangler d1 execute num-db --remote --file=scripts/rebalance-stars-2026-09-16.sql

INSERT OR IGNORE INTO num_star_moves (id, member_id, delta, kind, note)
SELECT 'rebal20260916_' || member_id, member_id, 5 - stars, 'welcome',
       'Welcome balance rebalanced to ★5'
FROM num_star_balances
WHERE stars = 100;

UPDATE num_star_balances
SET stars = 5
WHERE stars = 100
  AND EXISTS (
    SELECT 1 FROM num_star_moves mv
    WHERE mv.id = 'rebal20260916_' || num_star_balances.member_id
  );
