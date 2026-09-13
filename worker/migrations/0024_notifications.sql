-- 0023 — notifications that can actually arrive, and that a member controls.
--
-- WHY THIS EXISTS, from production on 12 Sep 2026:
--
--   148 members. 2 web-push subscriptions. 117 notifications written for 42
--   different people over six weeks, of which ONE was ever delivered. Nothing
--   has ever been marked read, because nothing writes read_at.
--
--   And on iOS — the app that just cleared review — src/lib/native.ts asks the
--   person for notification permission, receives an APNs token, and POSTs it to
--   /api/push/native, which has no handler. The catch swallows the failure. So
--   every iPhone user who said yes had that yes thrown away, and permission on
--   iOS is close to one-shot: once declined it is very hard to win back.
--
-- This migration is the storage half of fixing that.
--
-- EVERY ALTER IS ITS OWN STATEMENT, and no comment on any line contains a
-- semicolon. Both are house rules with incidents behind them.

-- ── Native device tokens ────────────────────────────────────────────────
--
-- Separate from num_push_subs because a web-push subscription and an APNs token
-- are different things with different lifecycles, different failure codes and
-- different kill switches. Putting both in one table would mean one column
-- meaning two things, and a query that is right for one and wrong for the other.
CREATE TABLE IF NOT EXISTS num_push_tokens (
  id            TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL,

  -- The device token itself, hex from Apple. UNIQUE: a device that re-registers
  -- must update its row, not add a second one, or every notification goes twice.
  token         TEXT NOT NULL UNIQUE,

  platform      TEXT NOT NULL CHECK (platform IN ('ios','android')),

  -- Which APNs host to use. A sandbox token sent to the production host fails
  -- with BadDeviceToken and vice versa, and that is the commonest reason a
  -- developer concludes "push is broken" when it is simply pointed at the wrong
  -- door. Stored per token because a TestFlight build and an App Store build
  -- can both be installed on the same person's phone.
  environment   TEXT NOT NULL DEFAULT 'production'
                CHECK (environment IN ('production','sandbox')),

  -- The app that registered it. APNs requires this as apns-topic and rejects a
  -- mismatch, so it is evidence rather than decoration.
  bundle_id     TEXT,

  app_version   TEXT,
  device_model  TEXT,

  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  last_ok       TEXT,
  fails         INTEGER NOT NULL DEFAULT 0,

  -- A token Apple has told us is dead. Disabled rather than deleted, so a
  -- person who reinstalls can be recognised, and so "we stopped sending because
  -- Apple said this token is gone" stays answerable months later.
  disabled_at     TEXT,
  disabled_reason TEXT,

  CHECK (disabled_at IS NULL OR disabled_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_member
  ON num_push_tokens(member_id, disabled_at);

-- ── What a member has agreed to receive ─────────────────────────────────
--
-- The default for every one of these is the CAUTIOUS value. A member who has
-- never opened this screen gets the quiet version, not the loud one. Defaults
-- are the setting almost everybody lives with, so they are a product decision
-- and not a technical one.
CREATE TABLE IF NOT EXISTS num_notify_prefs (
  member_id     TEXT PRIMARY KEY,

  -- The master switch. Off means nothing proactive, ever, whatever any other
  -- row in this schema says.
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),

  -- Their night, in their timezone. 21:00-08:00 matches what nudge.mjs already
  -- enforces for Phuket, now per member rather than hardcoded.
  quiet_from    INTEGER NOT NULL DEFAULT 21 CHECK (quiet_from BETWEEN 0 AND 23),
  quiet_to      INTEGER NOT NULL DEFAULT 8  CHECK (quiet_to BETWEEN 0 AND 23),
  tz            TEXT NOT NULL DEFAULT 'Asia/Bangkok',

  -- THE CEILING. Three a week, by default, for everything proactive combined.
  --
  -- This number is the difference between a concierge and a marketing list. It
  -- is deliberately low and deliberately enforced in one place, so no future
  -- feature can add "just one more kind" of message without either fitting
  -- inside the budget or visibly raising it.
  weekly_cap    INTEGER NOT NULL DEFAULT 3 CHECK (weekly_cap BETWEEN 0 AND 50),

  -- "Not right now." A date, not a boolean, so it expires by itself and nobody
  -- has to remember to turn themselves back on.
  paused_until  TEXT,

  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

-- ── Which kinds they want ───────────────────────────────────────────────
--
-- A row per topic per member, absent meaning "the default for that topic".
-- Storing only what they have actually chosen means we never have to guess
-- whether a 0 was their decision or our migration.
CREATE TABLE IF NOT EXISTS num_notify_topics (
  member_id   TEXT NOT NULL,
  topic       TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('on','off')),
  decided_at  TEXT NOT NULL,
  PRIMARY KEY (member_id, topic)
);

-- ── What they like ──────────────────────────────────────────────────────
--
-- Asked in plain language, once, and editable. `source` is the honest part: a
-- thing the member SAID is not the same as a thing we guessed from a tap, and a
-- suggestion built on a guess should be phrased less confidently than one built
-- on their own words. Keeping the distinction means we can.
CREATE TABLE IF NOT EXISTS num_taste (
  member_id   TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'stated'
              CHECK (source IN ('stated','observed')),
  confidence  REAL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (member_id, key),
  CHECK (source <> 'observed' OR confidence IS NOT NULL)
);

-- ── Every proactive message, and why it was or was not sent ─────────────
--
-- The suppression log is as important as the send log. "Why did NUM not tell me
-- about that" and "why did NUM tell me that twice" are both unanswerable without
-- a row for the decision, and both are questions a real member will ask.
CREATE TABLE IF NOT EXISTS num_notify_log (
  id          TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL,
  topic       TEXT NOT NULL,
  decision    TEXT NOT NULL
              CHECK (decision IN ('sent','suppressed')),
  reason      TEXT,
  notif_id    TEXT,
  created_at  TEXT NOT NULL,
  CHECK (decision <> 'suppressed' OR reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_notify_log_member
  ON num_notify_log(member_id, created_at);

-- ── num_notifications gains the columns that make it measurable ─────────
--
-- read_at already exists and has never had a writer. These are what turn a
-- write-only log into something we can judge: did it arrive, was it opened, did
-- the person act, and did they turn us off because of it.
--
-- One ALTER per statement. A column added inside a CREATE TABLE IF NOT EXISTS
-- on a table that already exists is a silent no-op that reaches fresh databases
-- and no live one, which is how booking_fee_minor went missing for weeks.

ALTER TABLE num_notifications ADD COLUMN topic TEXT;

ALTER TABLE num_notifications ADD COLUMN acted_at TEXT;

ALTER TABLE num_notifications ADD COLUMN channel TEXT;

ALTER TABLE num_notifications ADD COLUMN dismissed_at TEXT;
