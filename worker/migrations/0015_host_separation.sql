-- 0015 — ENDING THE RELATIONSHIP. Both directions, on the record.
--
-- Apply AFTER 0014. Statement-by-statement, no transaction.
--
-- ══ WHY THIS EXISTS ═════════════════════════════════════════════════════
-- 0014 built the relationship between a VIP host and a client and gave only
-- the HOST a way to end it, silently, by setting a status. That is the wrong
-- shape twice over.
--
-- First, the person with the least power in the arrangement had no way out.
-- A NUM member introduced to a host could not see who held their details, let
-- alone withdraw. "You may leave" is not a feature you bolt on later — it is
-- the thing that makes the introduction consentful in the first place, and
-- without it the earlier consent was worth less than it looked.
--
-- Second, an ending that nobody is told about is not an ending. The host goes
-- on believing they have a client, the client goes on believing they have a
-- host, and the £5 booking fee keeps landing on whichever of them the stale
-- row says it should. Every ending below notifies the other side and writes a
-- row saying who ended it and when.

-- ── THE MEMBER'S OWN KEY ────────────────────────────────────────────────
-- Same pattern as the host's console key, for the same reason: NUM members
-- introduced to a host may have no NUM login at all, and an ending that
-- requires an account is an ending most people will never reach. This token
-- opens exactly one page — who your host is, and a button to leave.
--
-- It is minted for EVERY client row, not only introduced ones, so a host can
-- hand their own client the same link. A host who says "here is how to remove
-- yourself from this" is making an argument for themselves.
ALTER TABLE num_host_clients ADD COLUMN member_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_host_clients_token
  ON num_host_clients(member_token) WHERE member_token IS NOT NULL;

-- Who ended it, and when. `ended_by` is not decoration: a host removing a
-- client and a client walking away are different facts with different
-- consequences — see the offer rule in growth/worker.js — and a single
-- status of 'removed' cannot tell them apart.
ALTER TABLE num_host_clients ADD COLUMN ended_at TEXT;
ALTER TABLE num_host_clients ADD COLUMN ended_by TEXT
  CHECK (ended_by IS NULL OR ended_by IN ('host','member','host_closed','num'));

-- Whether the other side was actually told. Set only after the mail is
-- queued. A NULL here on an ended row is a real defect the integrity check
-- reports, not a cosmetic gap: it means somebody still thinks they have a
-- relationship that ended.
ALTER TABLE num_host_clients ADD COLUMN notified_at TEXT;

-- ── THE HOST LEAVING ────────────────────────────────────────────────────
-- num_hosts.status already carries 'ended'. What it never carried was WHEN
-- and WHY, which is exactly what you need when a host asks to come back or
-- disputes a charge.
ALTER TABLE num_hosts ADD COLUMN closed_at TEXT;
ALTER TABLE num_hosts ADD COLUMN closed_reason TEXT;

-- ── THE RECORD ──────────────────────────────────────────────────────────
-- Append-only. Every ending, from either direction, with who was told.
--
-- This is the table that answers "you kept contacting my client after I left"
-- and "nobody told me". Both are accusations that cannot be answered with a
-- status column, because a status column only holds the present tense.
CREATE TABLE IF NOT EXISTS num_host_separations (
  id            TEXT PRIMARY KEY,
  host_id       TEXT NOT NULL,
  client_id     TEXT,
  member_id     TEXT,
  ended_by      TEXT NOT NULL CHECK (ended_by IN ('host','member','host_closed','num')),
  reason        TEXT,                       -- free text, whichever side gave one
  host_notified INTEGER NOT NULL DEFAULT 0 CHECK (host_notified IN (0,1)),
  member_notified INTEGER NOT NULL DEFAULT 0 CHECK (member_notified IN (0,1)),
  at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_host_sep_host   ON num_host_separations(host_id, at);
CREATE INDEX IF NOT EXISTS idx_host_sep_client ON num_host_separations(client_id);

-- ── WHAT THEY TOLD US AT SIGNUP ─────────────────────────────────────────
-- The signup form asks "who you look after, and where they travel" and says,
-- in its own hint, "it is what we read first". The browser sent it as
-- `notes` and hostJoin never read it — so since the form went live, the one
-- piece of writing a founding host actually composes for us has been dropped
-- on the floor. Asking a question and discarding the answer is worse than
-- not asking, because they think we know.
-- CORRECTED 6 Sep 2026. This line used to read
--   ALTER TABLE num_hosts ADD COLUMN about TEXT   (semicolon omitted on
--   purpose: a semicolon inside a comment splits a statement in half in a
--   naive runner, which a test in growth/hostseparation.test.mjs pins.)
-- It was never run in production. Meanwhile hostJoin was already writing
-- `UPDATE num_hosts SET about = ?`, so every founding host signup threw
-- `no such column: about` and, because a D1 batch is atomic, the host row and
-- the referral code rolled back too. The endpoint 500'd and the page told the
-- person their CONNECTION had failed. num_hosts held zero rows.
--
-- Production num_hosts already carries a `notes` column (read from D1,
-- 6 Sep 2026). Adding `about` would give one answer two homes and leave the
-- reader guessing which is current, so this migration adds nothing and
-- hostJoin writes `notes` instead. Nothing ever read `about`.
-- (No statement here on purpose.)

-- ── THE THREAD ──────────────────────────────────────────────────────────
-- One request, two people, and the messages between them.
--
-- This is the piece that makes the rest of the system a service rather than
-- a database. A host confirms a booking, the client needs to hear about it,
-- the client asks for a change, and the host needs to hear that — and none
-- of it can happen through a status column.
--
-- THE RULE THAT SHAPES THE TABLE: `author` is 'host' | 'client' | 'num', and
-- every message NUM sends to a client is sent OVER THE HOST'S NAME. A 'num'
-- row is therefore an operational note (a reminder, a confirmation echo),
-- never NUM introducing itself into the relationship. If you are about to add
-- a path where NUM messages a client in its own voice, that is the promise on
-- /hosts/ you would be breaking.
CREATE TABLE IF NOT EXISTS num_host_messages (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL,
  host_id     TEXT NOT NULL,
  client_id   TEXT,
  author      TEXT NOT NULL CHECK (author IN ('host','client','num')),
  body        TEXT NOT NULL,
  -- Whether the other side has been emailed about this message yet. The cron
  -- that drains this is what turns a note into a conversation — an unsent row
  -- is a message somebody is waiting on and does not know exists.
  delivered_at TEXT,
  read_at      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_host_msg_req  ON num_host_messages(request_id, created_at);
CREATE INDEX IF NOT EXISTS idx_host_msg_host ON num_host_messages(host_id, created_at);
CREATE INDEX IF NOT EXISTS idx_host_msg_undelivered
  ON num_host_messages(delivered_at) WHERE delivered_at IS NULL;

-- The client a request belongs to needs to be reachable from the request
-- itself for the calendar feed and the thread. client_id already exists on
-- num_host_requests — this index is what stops the join being a scan.
CREATE INDEX IF NOT EXISTS idx_host_requests_client ON num_host_requests(client_id);

-- When the host was last told about this request, so a notification cannot be
-- sent twice for the same event and a request cannot sit unnoticed with
-- nobody able to tell that it did.
ALTER TABLE num_host_requests ADD COLUMN host_notified_at TEXT;
ALTER TABLE num_host_requests ADD COLUMN client_notified_at TEXT;
