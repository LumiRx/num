-- ═══════════════════════════════════════════════════════════════════════════
-- 0019_suppliers.sql — the supplier layer
--
-- A host has a book of clients. A host ALSO has people who do the actual
-- work: the person who preps and delivers the cars, the villa housekeeper,
-- the boat captain, the florist. Until now NUM had no idea those people
-- existed, so every dispatch happened in the host's phone and none of it
-- was tracked. This migration gives that half of the business the same
-- treatment the client half already has.
--
-- THE WALL. One rule governs every table below and every check that reads
-- them: the client never learns the supplier exists, and the supplier never
-- learns who the client is. The host stands between the two. It is the same
-- rule already written into host-to-host work (num_host_requests.network_*),
-- and it is the reason a job carries a CONTACT LABEL rather than a client_id.
-- A job row has no column that can hold a client's identity, which is the
-- only way to be sure one never ends up there.
--
-- WHO A SUPPLIER IS. A NUM member. Not a new kind of account, not a second
-- signup, not a separate app. The person who manages a host's cars probably
-- already uses NUM to book their own dinner. They get a supplier profile on
-- top of the account they have, they can work for many hosts at once, and
-- they can operate in many locations. Nothing here is exclusive.
--
-- WHO PAYS. The host pays the supplier directly. NUM records the amount,
-- the invoice and the receipt so nothing is lost and both sides can see the
-- same number — but NUM holds no funds, moves no money and takes no cut.
-- Same rule as host-to-host. The settle_* columns on num_jobs are a LEDGER,
-- not a payment rail.
--
-- Semicolons never appear inside a comment in this file — the migration
-- runner splits on them, so a semicolon in prose would cut a statement in
-- half. Em dashes are used instead.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── THE SUPPLIER ───────────────────────────────────────────────────────────
-- One row per person or business doing work for hosts. member_id is UNIQUE
-- because a person is one supplier, however many hosts they serve.
CREATE TABLE IF NOT EXISTS num_suppliers (
  id            TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL,
  display_name  TEXT NOT NULL,             -- how hosts see them in the console
  business_name TEXT,
  kind          TEXT NOT NULL DEFAULT 'other',
                -- car|driver|stay|boat|chef|flowers|courier|maintenance|other
  about         TEXT,
  currency      TEXT NOT NULL DEFAULT 'GBP',
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','paused','closed')),
  -- Whether this supplier will take work from a host they have never worked
  -- with. DEFAULT 0 — off. Same reasoning as accepts_intros on num_hosts:
  -- being discoverable is a thing you switch on, never a thing that happened
  -- because we shipped a feature.
  open_to_hosts INTEGER NOT NULL DEFAULT 0 CHECK (open_to_hosts IN (0,1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  closed_at     TEXT,
  closed_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_member ON num_suppliers(member_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_open ON num_suppliers(open_to_hosts, status);


-- ── THE RELATIONSHIP ───────────────────────────────────────────────────────
-- A host and a supplier are linked only when BOTH have agreed, and either
-- side can end it. This is the same two-directional consent num_host_clients
-- got in 0015, for the same reason: a relationship only one party can leave
-- is not a relationship, it is a trap.
--
-- ended_by is recorded because "who ended it" changes what happens to the
-- jobs still open on the link, and because the other side is told the same
-- day either way.
CREATE TABLE IF NOT EXISTS num_supplier_links (
  id           TEXT PRIMARY KEY,
  host_id      TEXT NOT NULL,
  supplier_id  TEXT NOT NULL,
  asked_by     TEXT NOT NULL CHECK (asked_by IN ('host','supplier')),
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','accepted','declined','ended')),
  -- What the host calls this supplier in their own head. Never shown to the
  -- supplier — it is the host's private label, like a note on a contact.
  host_label   TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL,
  decided_at   TEXT,
  ended_at     TEXT,
  ended_by     TEXT CHECK (ended_by IN ('host','supplier','num')),
  ended_note   TEXT,
  notified_at  TEXT,                       -- the other side was told about the ending
  CHECK (status <> 'ended' OR (ended_at IS NOT NULL AND ended_by IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_links_pair
  ON num_supplier_links(host_id, supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_links_sup
  ON num_supplier_links(supplier_id, status);


-- ── WHERE THEY WORK ────────────────────────────────────────────────────────
-- A supplier who manages cars in three cities is one supplier with three
-- locations, not three suppliers. A job is dispatched to a supplier AT a
-- location, so the brief can say which yard the car is sitting in.
CREATE TABLE IF NOT EXISTS num_supplier_locations (
  id          TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL,
  label       TEXT NOT NULL,               -- "LAX yard", "Beverly Hills garage"
  address     TEXT,
  city        TEXT,
  country     TEXT,
  lat         REAL,
  lon         REAL,
  notes       TEXT,                        -- gate code, which bay, who to ask for
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_supplier_locations_sup
  ON num_supplier_locations(supplier_id, active);


-- ── WHAT THEY DO, AND WHAT THEY CHARGE THE HOST ────────────────────────────
-- The price here is supplier-to-host. It is not the client's price and it is
-- never shown to a client. A host marks up, bundles or absorbs it however
-- they like — that is their business, and NUM does not get an opinion.
--
-- unit 'quote' means there is no standing number. When a service is 'quote'
-- the job carries no cost until the supplier puts one on it, and the console
-- shows "agreed per job" rather than inventing a figure someone could later
-- be held to. Same rule as num_host_products.
CREATE TABLE IF NOT EXISTS num_supplier_services (
  id            TEXT PRIMARY KEY,
  supplier_id   TEXT NOT NULL,
  service_key   TEXT NOT NULL,             -- car|driver|stay|activity|delivery|other
  title         TEXT NOT NULL,
  detail        TEXT,
  price_minor   INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'GBP',
  unit          TEXT NOT NULL DEFAULT 'quote'
                CHECK (unit IN ('fixed','hour','day','quote')),
  lead_time_min INTEGER NOT NULL DEFAULT 0, -- minutes of notice they need
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  CHECK (unit = 'quote' OR price_minor > 0)
);
CREATE INDEX IF NOT EXISTS idx_supplier_services_sup
  ON num_supplier_services(supplier_id, active);


-- ── THE JOB ────────────────────────────────────────────────────────────────
-- The centre of this migration. A job is one instruction from one host to
-- one supplier: get this ready, and either hand it over here or have it
-- collected there.
--
-- request_id is NULLABLE on purpose. Most jobs hang off a client request,
-- but a host also needs to say "move the car to the airport lot tonight"
-- with no client attached, and refusing that would push the work back into
-- WhatsApp — which is the exact thing this table exists to stop.
--
-- THE WALL, in columns. There is no client_id here and there never will be.
-- What the supplier gets is contact_label ("Mr H's guest") and, only if the
-- host explicitly chose to share it, contact_phone. A host who shares a real
-- name types it themselves, knowingly, into a field that is labelled as
-- visible to the supplier.
CREATE TABLE IF NOT EXISTS num_jobs (
  id            TEXT PRIMARY KEY,
  host_id       TEXT NOT NULL,
  supplier_id   TEXT NOT NULL,
  link_id       TEXT NOT NULL,             -- the accepted link this job travels on
  request_id    TEXT,                      -- the client request, when there is one
  location_id   TEXT,                      -- where the supplier starts from
  service_key   TEXT NOT NULL,
  title         TEXT NOT NULL,             -- "Black S-Class, airport pickup"
  brief         TEXT,                      -- what to prepare, in the host's words

  -- Is the supplier delivering it, or is someone collecting from them?
  fulfilment    TEXT NOT NULL DEFAULT 'deliver'
                CHECK (fulfilment IN ('deliver','collect')),

  ready_by      TEXT,                      -- ISO8601 — when it must be ready
  starts_at     TEXT,
  ends_at       TEXT,

  -- Drop-off, for fulfilment = 'deliver'. A deliver job with no address is
  -- an instruction nobody can follow, so it is a breach, checked in code and
  -- enforced below at the point the job leaves draft.
  dropoff_address  TEXT,
  dropoff_note     TEXT,                   -- "kerbside at Terminal 5 arrivals, bay 3"
  dropoff_at       TEXT,
  contact_label    TEXT,                   -- what the supplier is told to look for
  contact_phone    TEXT,                   -- only if the host chose to share one

  -- What the supplier charges the HOST. Never the client's number.
  cost_minor    INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'GBP',
  unit          TEXT NOT NULL DEFAULT 'quote'
                CHECK (unit IN ('fixed','hour','day','quote')),

  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','sent','accepted','declined','expired',
                                  'in_progress','ready','delivered','done','cancelled')),
  decline_reason TEXT,
  cancel_reason  TEXT,
  cancelled_by   TEXT CHECK (cancelled_by IN ('host','supplier','num')),

  -- Proof that the thing actually happened. A photo of the car at the kerb
  -- settles an argument before it starts, which is why it is a column and
  -- not a message.
  proof_url     TEXT,
  proof_at      TEXT,

  -- THE LEDGER. NUM records what is owed and what was paid. NUM does not
  -- hold, move or take any of it.
  settle_status TEXT NOT NULL DEFAULT 'unbilled'
                CHECK (settle_status IN ('unbilled','invoiced','paid','disputed','written_off')),
  invoice_ref   TEXT,
  invoiced_at   TEXT,
  paid_at       TEXT,
  paid_note     TEXT,

  supplier_notified_at TEXT,
  host_notified_at     TEXT,

  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  sent_at       TEXT,
  accepted_at   TEXT,
  started_at    TEXT,
  ready_at      TEXT,
  delivered_at  TEXT,
  done_at       TEXT,
  cancelled_at  TEXT,

  -- Every terminal and near-terminal state must carry its timestamp, so a
  -- row can never claim something happened without saying when.
  CHECK (status <> 'declined'  OR decline_reason IS NOT NULL),
  CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)),
  CHECK (status <> 'done'      OR done_at IS NOT NULL),
  CHECK (status <> 'delivered' OR delivered_at IS NOT NULL),
  -- A job that has left draft and is a delivery must say where it is going.
  CHECK (fulfilment <> 'deliver'
         OR status = 'draft' OR status = 'cancelled'
         OR dropoff_address IS NOT NULL),
  -- A priced job must carry a number. A quote job must not pretend to.
  CHECK (unit = 'quote' OR cost_minor > 0),
  -- You cannot record money against work that was never accepted.
  CHECK (settle_status = 'unbilled'
         OR status IN ('accepted','in_progress','ready','delivered','done'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_host     ON num_jobs(host_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_supplier ON num_jobs(supplier_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_request  ON num_jobs(request_id);
CREATE INDEX IF NOT EXISTS idx_jobs_settle   ON num_jobs(host_id, settle_status);


-- ── THE TRAIL ──────────────────────────────────────────────────────────────
-- Every status change writes a row here, with who did it and when. This is
-- what "make no mistakes" actually means in a system: not that nothing goes
-- wrong, but that when something does, there is one place that says exactly
-- what happened and in what order.
--
-- A status change with no event row is treated as a breach by the integrity
-- checker, because a silent change is indistinguishable from a bug.
CREATE TABLE IF NOT EXISTS num_job_events (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  at          TEXT NOT NULL,
  actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('host','supplier','num','client')),
  actor_id    TEXT,
  event       TEXT NOT NULL,               -- sent|accepted|declined|ready|delivered|...
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT                         -- JSON, for what changed
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON num_job_events(job_id, at);


-- ── THE CONVERSATION ───────────────────────────────────────────────────────
-- One thread per job, between the host and the supplier only. Mirrors
-- num_host_messages, which is the host-to-client thread. The two threads
-- never join — that is the wall again, in table form.
CREATE TABLE IF NOT EXISTS num_job_messages (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL,
  from_kind  TEXT NOT NULL CHECK (from_kind IN ('host','supplier','num')),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at    TEXT,
  -- A message we failed to deliver says so, rather than looking like one
  -- that arrived.
  delivery   TEXT NOT NULL DEFAULT 'ok' CHECK (delivery IN ('ok','pending','failed'))
);
CREATE INDEX IF NOT EXISTS idx_job_messages_job ON num_job_messages(job_id, created_at);


-- ── RECEIPTS ───────────────────────────────────────────────────────────────
-- The supplier issues, the host keeps. Both see the same row, which is the
-- entire point: two people looking at one number is how disputes stop
-- happening. NUM issues nothing and is party to none of it.
CREATE TABLE IF NOT EXISTS num_receipts (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL,
  host_id      TEXT NOT NULL,
  supplier_id  TEXT NOT NULL,
  issued_by    TEXT NOT NULL CHECK (issued_by IN ('supplier','host')),
  kind         TEXT NOT NULL DEFAULT 'receipt' CHECK (kind IN ('invoice','receipt')),
  amount_minor INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'GBP',
  ref          TEXT,
  note         TEXT,
  file_url     TEXT,
  issued_at    TEXT NOT NULL,
  CHECK (amount_minor >= 0)
);
CREATE INDEX IF NOT EXISTS idx_receipts_job  ON num_receipts(job_id, issued_at);
CREATE INDEX IF NOT EXISTS idx_receipts_host ON num_receipts(host_id, issued_at);


-- ── NEW COLUMNS ────────────────────────────────────────────────────────────
-- Whether this host wants a photo at drop-off before a job can be closed.
-- DEFAULT 0 — a host who wants proof asks for it.
ALTER TABLE num_hosts ADD COLUMN requires_proof INTEGER NOT NULL DEFAULT 0;

-- How long a sent job waits before NUM marks it expired and tells the host
-- to try someone else. DEFAULT 120 minutes. A job nobody answered is worse
-- than a job that was declined, because the host does not know to move on.
ALTER TABLE num_hosts ADD COLUMN job_expiry_min INTEGER NOT NULL DEFAULT 120;
