-- Extend num_venue_scans.outcome for the guessing lock.
--
-- WHY THIS EXISTS. The lock shipped and worked — a brute-force run against a
-- throwaway venue was refused on the tenth distinct code, exactly as designed.
-- But its log line never appeared, because `outcome` carries a CHECK constraint
-- listing the seven outcomes that existed before it, and `logScan` wraps its
-- INSERT in a try/catch. So the refusal was real and INVISIBLE: nobody could
-- see an attack in progress, and the alert that reads this table would never
-- fire on the one event that means somebody is attacking a venue right now.
--
-- That is the same silent-catch failure this project caught in bizpages.mjs and
-- again in the settle mail. It is worth saying plainly: a guard nobody can
-- observe is half a guard, and a swallowed write is how you get one.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt. 26 rows at the time of
-- writing, and it is a log, so the copy is cheap and losing nothing.
PRAGMA foreign_keys = OFF;

CREATE TABLE num_venue_scans_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT NOT NULL,
  business_id TEXT NOT NULL,
  booking_id  TEXT,
  outcome     TEXT NOT NULL CHECK (outcome IN (
                'completed','already_completed','no_booking','out_of_window',
                'wrong_venue','revoked','unknown_token',
                -- added 12 Sep 2026 with the guessing lock
                'guess_locked',   -- one network refused after too many wrong codes
                'guess_brake')),  -- a correct code welcomed but not billed, venue under attack
  member_ref  TEXT,
  country     TEXT,
  device      TEXT,
  ip_hash     TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO num_venue_scans_new
  (id,token,business_id,booking_id,outcome,member_ref,country,device,ip_hash,detail,created_at)
  SELECT id,token,business_id,booking_id,outcome,member_ref,country,device,ip_hash,detail,created_at
    FROM num_venue_scans;

DROP TABLE num_venue_scans;
ALTER TABLE num_venue_scans_new RENAME TO num_venue_scans;

CREATE INDEX IF NOT EXISTS idx_venue_scans_token_time
  ON num_venue_scans (token, created_at);
CREATE INDEX IF NOT EXISTS idx_venue_scans_token_ip_outcome
  ON num_venue_scans (token, ip_hash, outcome, created_at);

PRAGMA foreign_keys = ON;
