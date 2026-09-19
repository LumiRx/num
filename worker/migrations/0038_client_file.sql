-- 0038 — the client file.
--
-- A host's book held a name, an email, a city and one free-text note. That is
-- an address book. What a host actually keeps in their head — she will not fly
-- before nine, he is allergic to shellfish, they always take the corner table,
-- her birthday is in March, this trip is already in her own calendar — had
-- nowhere to live, so it lived in the host's head and left with them.
--
-- Everything here is ALTER or a new table. 0014 is sealed.

-- ══ WHAT THEY LIKE ══════════════════════════════════════════════════════
-- Three columns rather than one, because they are read at different moments.
-- `likes` is what to lean into when there is a choice to make. `dislikes` is
-- what NOT to do, and it is the one worth having on its own: a note saying
-- "no boats" buried in the middle of a paragraph about her favourite hotels is
-- a note somebody will miss.
ALTER TABLE num_host_clients ADD COLUMN likes TEXT;
ALTER TABLE num_host_clients ADD COLUMN dislikes TEXT;

-- A JSON array of short tags — golf, opera, diving, wine. Structured on
-- purpose. A free-text sentence cannot answer "which of my clients would want
-- to know about this", which is the question a host with sixty people in their
-- book actually has.
ALTER TABLE num_host_clients ADD COLUMN interests TEXT NOT NULL DEFAULT '[]';

-- ══ THE ONES THAT ARE NOT PREFERENCES ═══════════════════════════════════
-- Allergies and access needs are kept apart from "likes" deliberately. Getting
-- a favourite wine wrong is a bad evening. Getting shellfish wrong is an
-- ambulance, and it must never be one line among ten in a notes field.
ALTER TABLE num_host_clients ADD COLUMN dietary TEXT;
ALTER TABLE num_host_clients ADD COLUMN access_needs TEXT;

ALTER TABLE num_host_clients ADD COLUMN company TEXT;
-- Stored as written, because a client who gives a day and a month has not
-- given a year and we are not going to invent one.
ALTER TABLE num_host_clients ADD COLUMN birthday TEXT;

-- Their own page at /my-host/?t=<member_token> already exists. This is the
-- host's switch for how much of the file it shows. Default 1: the page is
-- already live for every client and already shows them who holds their
-- details, which is the part that must never be switchable off.
ALTER TABLE num_host_clients ADD COLUMN portal_trips INTEGER NOT NULL DEFAULT 1
  CHECK (portal_trips IN (0,1));

-- ══ THEIR CALENDAR ══════════════════════════════════════════════════════
-- Distinct from num_host_requests, and the distinction is the point: a request
-- is work the host is doing. An event is something that is happening to the
-- client — a flight they booked themselves, a board meeting, a birthday —
-- which the host needs to see so they do not put a dinner on top of it.
CREATE TABLE IF NOT EXISTS num_client_events (
  id          TEXT PRIMARY KEY,
  host_id     TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  -- host    typed in by the host
  -- import  came from an .ics the client sent
  -- request mirrored from a confirmed num_host_requests row
  source      TEXT NOT NULL DEFAULT 'host'
              CHECK (source IN ('host','import','request')),
  -- The originating calendar's own id. It is what makes re-importing the same
  -- trip an UPDATE rather than a second copy of every event, which is the
  -- single most common way a calendar import turns into a mess.
  uid         TEXT,
  title       TEXT NOT NULL,
  detail      TEXT,
  location    TEXT,
  starts_at   TEXT NOT NULL,
  ends_at     TEXT,
  all_day     INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0,1)),
  -- Recorded, never applied. See the header of growth/icsparse.mjs: converting
  -- without a timezone database is inventing an offset.
  tz          TEXT,
  -- True when the source said RRULE. We show the first occurrence and say it
  -- repeats rather than expanding a recurrence we cannot get right.
  repeats     INTEGER NOT NULL DEFAULT 0 CHECK (repeats IN (0,1)),
  request_id  TEXT,
  import_id   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_events_client
  ON num_client_events(client_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_client_events_host
  ON num_client_events(host_id, starts_at);
-- One row per (client, source calendar id). A client who sends the same trip
-- twice gets one calendar, not two.
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_events_uid
  ON num_client_events(client_id, uid) WHERE uid IS NOT NULL;

-- ══ WHAT THEY OWE ═══════════════════════════════════════════════════════
-- No invoices table. A confirmed request already carries what it was, who it
-- was for, what it cost and in which currency — an invoice table would be a
-- second copy of all four, free to drift out of step with the first.
--
-- What was missing is only the money's own state: whether the host has billed
-- it and whether it has been paid. Three columns, on the row that already
-- exists.
ALTER TABLE num_host_requests ADD COLUMN invoiced_at TEXT;
ALTER TABLE num_host_requests ADD COLUMN paid_at TEXT;
-- The host's own reference, as it appears on their own paperwork. NUM does not
-- generate invoice numbers: a host has an accounting system with its own
-- sequence, and a second sequence of ours in the same conversation with the
-- same client is how a payment gets applied to the wrong thing.
ALTER TABLE num_host_requests ADD COLUMN invoice_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_host_requests_money
  ON num_host_requests(host_id, invoiced_at, paid_at);
