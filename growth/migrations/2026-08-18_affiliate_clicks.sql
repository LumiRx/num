-- Affiliate handoff log: what Num sent away, to whom, and whether we were paid
-- for it. Follows growth/migrations/2026-08-16_paylinks.sql in the sequence.
--
-- Written by worker/affiliateclicks.mjs (recordHandoffs), from two call sites:
--   worker/index.mjs         — service_option, every provider link in a reply
--   worker/openapi.mjs       — book_link, POST /api/book/link
--
-- Run BEFORE deploying the worker that references it:
--   cd ~/num-worktrees/app-main/growth
--   npx wrangler@latest d1 execute num-db --remote --file=./migrations/2026-08-18_affiliate_clicks.sql
--
-- The worker also creates this table lazily (same CREATE ... IF NOT EXISTS, in
-- affiliateclicks.mjs) so a missed migration costs a cold-start round trip
-- rather than a silent hole in the data. Running this makes that a no-op.
--
-- READ `event` BEFORE READING ANY COUNT FROM THIS TABLE:
--   handoff — Num put this link in front of a guest. Every row today.
--   tap     — the guest is known to have followed it. Nothing writes this yet.
-- A handoff is NOT a click. The tap happens on somebody else's domain and we
-- never see it. Summing the two would restate "links offered" as "traffic
-- delivered", which is the exact overstatement num_place_impressions exists to
-- avoid. The affiliate network's dashboard remains the only source of truth
-- for money; this table says what we sent, so a payout can be checked against
-- it and so an untagged host with real volume becomes a visible to-do.

CREATE TABLE IF NOT EXISTS num_affiliate_clicks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  host       TEXT NOT NULL,                     -- registrable host, www. stripped
  programme  TEXT,                              -- the NUM_AFFILIATES key that matched: a host, '*', or NULL
  tagged     INTEGER NOT NULL DEFAULT 0,        -- 1 = a ref parameter actually landed on the URL
  event      TEXT NOT NULL DEFAULT 'handoff',   -- 'handoff' | 'tap' — see above, never sum them
  surface    TEXT,                              -- 'service_option' | 'book_link'
  kind       TEXT,                              -- ride | food | table | wellness | flight | hotel | rail | platform id
  member_id  TEXT,                              -- null on ~99% of rows by design; most people asking Num are not members
  dest       TEXT,                              -- destination slug, e.g. 'phuket'
  ts         INTEGER NOT NULL                   -- unix SECONDS, like num_place_impressions
);

-- "which host do we hand the most traffic to, and are we paid for it" — the
-- one question this table exists to answer, and the one the nightly run asks.
CREATE INDEX IF NOT EXISTS idx_affclick_host_ts ON num_affiliate_clicks(host, ts);
-- Without this the nightly 14-day window scans the whole table.
CREATE INDEX IF NOT EXISTS idx_affclick_ts ON num_affiliate_clicks(ts);
