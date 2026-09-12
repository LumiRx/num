-- ═══════════════════════════════════════════════════════════════════════════
-- 0021_luxury_assets.sql — yachts, jets, cars, and the photos of them
--
-- WHAT THIS IS FOR. A member asks for a week on a boat out of Antibes, a jet
-- to Nice, a car at the dock, and the fridge stocked before they board. Every
-- one of those is already a JOB in the supplier layer (0019): a host dispatches
-- it to whoever operates the thing, at a location, for a price, with proof and
-- a receipt. Nothing about that needs rebuilding.
--
-- What 0019 cannot hold is THE THING ITSELF. A job says "black S-Class" in a
-- title field. A charter cannot work that way: the member is choosing between
-- two specific boats, by their photos, their berths, their year, and whether
-- that exact hull is free that exact week. So:
--
--   num_assets         the boat, the jet, the car — once, with its spec
--   num_asset_photos   what it actually looks like
--   num_asset_holds    when it is already taken  ← the one that prevents ruin
--   num_inbound_media  a photo that arrived by text before we knew its job
--
-- THE ONE CATASTROPHIC FAILURE. Two members chartering the same hull the same
-- week is not a bug you apologise for, it is a bug that ends the relationship
-- and possibly the company. num_asset_holds exists so availability is a row
-- with a date range, not a note in somebody's head, and the integrity checker
-- reads it for overlaps as a breach.
--
-- WHO MAY LIST. Decided 12 Sep: suppliers now, members behind a switch later.
-- owner_kind carries both from day one so the later change is a flag and not a
-- migration — but a member-owned asset CANNOT be listable until a human has
-- verified it, enforced by a CHECK below. Letting someone list a Ferrari they
-- do not own, to a member who then pays for it, is the failure that makes this
-- a different and much worse company.
--
-- WHO TAKES THE MONEY. Decided 12 Sep: NUM collects and settles, no
-- commission. That is the second radio button that already exists in the host
-- console, and it is honest there. It is recorded per asset below because a
-- yacht week is not a dinner bill and the answer may not be the same for both.
--
-- Semicolons never appear inside a comment in this file — the migration runner
-- splits on them, so one in prose would cut a statement in half. Em dashes
-- are used instead.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── THE ASSET ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS num_assets (
  id            TEXT PRIMARY KEY,

  -- WHO OWNS IT. 'supplier' is the only one that can list today. 'member' is
  -- the door left open, gated by the CHECK at the foot of this table.
  owner_kind    TEXT NOT NULL DEFAULT 'supplier'
                CHECK (owner_kind IN ('supplier','member')),
  owner_id      TEXT NOT NULL,
  -- The host who may offer it. An asset with no host is inventory nobody can
  -- reach, which is fine while it is being set up and not fine once listable.
  host_id       TEXT,

  kind          TEXT NOT NULL
                CHECK (kind IN ('yacht','boat','jet','helicopter','car','villa','other')),
  name          TEXT NOT NULL,              -- "M/Y Serenity", "Ferrari 296 GTB"
  make          TEXT,
  model         TEXT,
  year          INTEGER,
  registration  TEXT,                       -- tail number, hull or plate. Never shown to a member.

  -- Kind-specific numbers as JSON rather than forty mostly-null columns: a
  -- yacht has berths and a beam, a jet has range and seats, a car has neither.
  spec          TEXT,

  -- WHERE IT LIVES. A boat in Antibes cannot serve a member in Palma, and the
  -- coordinate match is what answers "what is near me" — see the host-coverage
  -- geocoding note in 0019's sibling work. Coordinates are enrichment, so they
  -- are nullable and a missing one never blocks a save.
  home_port     TEXT,
  home_city     TEXT,
  home_country  TEXT,
  lat           REAL,
  lon           REAL,

  guests        INTEGER,                    -- how many people it carries
  crew          INTEGER,

  -- What it costs, supplier to host. Never the member's number — the host
  -- prices their own client, as everywhere else in this system.
  currency      TEXT NOT NULL DEFAULT 'GBP',
  rate_minor    INTEGER NOT NULL DEFAULT 0,
  rate_unit     TEXT NOT NULL DEFAULT 'quote'
                CHECK (rate_unit IN ('hour','day','week','trip','quote')),
  -- Charter reality: a week on a boat is a base rate plus fuel, food, berths
  -- and tax. Quoting the base as the price is how a client is surprised by a
  -- bill that is half again as large.
  extras_note   TEXT,

  -- Who moves the money for THIS asset. Recorded per asset because the answer
  -- for a 200k charter may not be the answer for a car to the airport.
  settle_mode   TEXT NOT NULL DEFAULT 'host_direct'
                CHECK (settle_mode IN ('host_direct','num_collects')),

  notes         TEXT,                       -- what the booker should know

  -- A human looked at the paperwork and believes this owner owns this thing.
  verified_at   TEXT,
  verified_by   TEXT,
  verify_note   TEXT,

  -- May a member be shown this at all. DEFAULT 0 — off. Inventory becomes
  -- offerable when somebody decides it is ready, never because a row appeared.
  listable      INTEGER NOT NULL DEFAULT 0 CHECK (listable IN (0,1)),

  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','paused','retired')),

  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  retired_at    TEXT,

  -- THE GATE ON THE MARKETPLACE DOOR. A member-owned asset cannot be shown to
  -- anybody until a human has verified it. Suppliers arrive through a host who
  -- already accepted them — a member arrives through a text message.
  CHECK (owner_kind <> 'member' OR listable = 0 OR verified_at IS NOT NULL),
  -- Listable inventory needs a host who can actually offer it.
  CHECK (listable = 0 OR host_id IS NOT NULL),
  -- A priced asset carries a number. A quote asset must not pretend to.
  CHECK (rate_unit = 'quote' OR rate_minor > 0),
  CHECK (status <> 'retired' OR retired_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_assets_owner ON num_assets(owner_kind, owner_id);
CREATE INDEX IF NOT EXISTS idx_assets_host  ON num_assets(host_id, status);
CREATE INDEX IF NOT EXISTS idx_assets_offer ON num_assets(listable, status, kind);
CREATE INDEX IF NOT EXISTS idx_assets_geo   ON num_assets(lat, lon);


-- ── WHAT IT LOOKS LIKE ─────────────────────────────────────────────────────
-- A charter is chosen on photographs. These are the photographs.
--
-- MODERATION IS NOT OPTIONAL HERE. A supplier texts in a picture and it goes
-- in front of a paying member. Left unmoderated, the first accident is a
-- number plate, somebody's face at the rail, or last season's boat. Default is
-- 'new' and nothing but 'ok' is ever shown — enforced in code and readable
-- here, so nobody has to guess which state means published.
CREATE TABLE IF NOT EXISTS num_asset_photos (
  id           TEXT PRIMARY KEY,
  asset_id     TEXT NOT NULL,
  r2_key       TEXT NOT NULL,               -- where the bytes actually are
  content_type TEXT NOT NULL,
  bytes        INTEGER,
  width        INTEGER,
  height       INTEGER,
  -- How it arrived. 'mms' is a supplier texting it in, which is the whole
  -- point of the feature and also the least controlled path.
  source       TEXT NOT NULL DEFAULT 'console'
               CHECK (source IN ('mms','upload','console','whatsapp')),
  caption      TEXT,
  -- A supplier who texts the same photo three times should not get three rows.
  sha256       TEXT,
  moderation   TEXT NOT NULL DEFAULT 'new'
               CHECK (moderation IN ('new','ok','rejected')),
  reject_note  TEXT,
  position     INTEGER NOT NULL DEFAULT 0,  -- the order a member sees them in
  created_at   TEXT NOT NULL,
  decided_at   TEXT,
  decided_by   TEXT,
  CHECK (moderation <> 'rejected' OR reject_note IS NOT NULL),
  CHECK (moderation = 'new' OR decided_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_photos_dedupe
  ON num_asset_photos(asset_id, sha256);
CREATE INDEX IF NOT EXISTS idx_asset_photos_asset
  ON num_asset_photos(asset_id, moderation, position);


-- ── WHEN IT IS ALREADY TAKEN ───────────────────────────────────────────────
-- The table that stops the unrecoverable mistake. Every hold is a date range
-- against one asset. Two overlapping 'booked' holds on one hull is a breach,
-- not a warning, and the integrity checker treats it that way.
--
-- job_id is nullable because an owner also needs to say "out of the water in
-- January" with no booking attached.
CREATE TABLE IF NOT EXISTS num_asset_holds (
  id         TEXT PRIMARY KEY,
  asset_id   TEXT NOT NULL,
  job_id     TEXT,
  kind       TEXT NOT NULL DEFAULT 'booked'
             CHECK (kind IN ('booked','provisional','blocked','maintenance')),
  starts_at  TEXT NOT NULL,
  ends_at    TEXT NOT NULL,
  note       TEXT,
  -- A provisional hold that nobody confirms has to expire, or the calendar
  -- silently fills with options somebody took and forgot.
  expires_at TEXT,
  created_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT,
  CHECK (ends_at > starts_at),
  CHECK (kind <> 'provisional' OR expires_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_asset_holds_asset
  ON num_asset_holds(asset_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_asset_holds_job ON num_asset_holds(job_id);


-- ── A PHOTO THAT ARRIVED BEFORE WE KNEW WHY ────────────────────────────────
-- "They can just text in a image." That means the picture lands before anybody
-- has said which boat it is of, so it cannot go straight into
-- num_asset_photos. It lands here, the conversation resolves it, and only then
-- is it attached.
--
-- The sender's number is stored HASHED. We need to know two photos came from
-- the same supplier without keeping a phone number in a media table that a
-- moderation screen will one day render.
CREATE TABLE IF NOT EXISTS num_inbound_media (
  id           TEXT PRIMARY KEY,
  from_hash    TEXT NOT NULL,               -- HMAC of the sending number
  from_last4   TEXT,                        -- enough for a human to recognise
  supplier_id  TEXT,                        -- resolved when we know them
  asset_id     TEXT,                        -- set when it is attached
  r2_key       TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes        INTEGER,
  sha256       TEXT,
  provider     TEXT NOT NULL DEFAULT 'twilio'
               CHECK (provider IN ('twilio','whatsapp','upload')),
  provider_sid TEXT,
  body         TEXT,                        -- whatever they typed with it
  status       TEXT NOT NULL DEFAULT 'new'
               CHECK (status IN ('new','attached','discarded','unknown_sender')),
  note         TEXT,
  created_at   TEXT NOT NULL,
  decided_at   TEXT,
  CHECK (status <> 'attached' OR asset_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_inbound_media_status
  ON num_inbound_media(status, created_at);
CREATE INDEX IF NOT EXISTS idx_inbound_media_from
  ON num_inbound_media(from_hash, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_media_sid
  ON num_inbound_media(provider, provider_sid);


-- ── NEW COLUMNS ────────────────────────────────────────────────────────────
-- A job can now be against a specific hull rather than a description, which is
-- what lets the hold, the photos and the booking all point at one thing.
ALTER TABLE num_jobs ADD COLUMN asset_id TEXT;

-- Whether this supplier may text photographs in at all. DEFAULT 0 — a supplier
-- turns it on, because an open inbound media path attached to an account
-- nobody asked is a liability rather than a feature.
ALTER TABLE num_suppliers ADD COLUMN accepts_mms INTEGER NOT NULL DEFAULT 0;
