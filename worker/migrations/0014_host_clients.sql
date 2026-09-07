-- 0014 — the VIP host's BOOK. Their clients, their client work, the things they
-- sell, and the other hosts they can reach.
--
-- STATUS: apply with `wrangler d1 execute num-db --remote --file=...`.
-- 0013 must be applied FIRST — this file assumes num_hosts.tier exists.
-- The CREATE TABLEs are IF NOT EXISTS and safe to re-run — the ALTERs are not
-- (SQLite has no ADD COLUMN IF NOT EXISTS), so do NOT wrap this in a
-- transaction — a duplicate-column error must fail one statement, not all.
--
-- ══ THE MODEL THIS FILE ENCODES ═════════════════════════════════════════
-- The host is NUM's customer. The client is the HOST's customer. NUM is the
-- back office the host pays a monthly plan for, and the client pays NUM
-- nothing and is never billed by NUM. Every table below is shaped by that:
-- there is no client-side price, no client-side payment method, and no path
-- by which NUM can contact a host's client without the host having asked.
--
-- The earlier model — host as referrer, 3% of NUM's commission for 12 months —
-- is NOT what these tables describe. num_hosts.host_bps and term_months
-- survive from it and are left alone: they are historical fact for any row
-- signed under the old wording, and rewriting history to match a new plan is
-- how you lose a dispute.

-- ── WHO THE HOST LOOKS AFTER ────────────────────────────────────────────
-- One row per person in a host's book. This is the table the monthly plan is
-- priced on, so what counts as "a client" has to be unambiguous: a row with
-- status 'active'. Paused and removed rows stay for continuity — a host who
-- pauses a client in January and brings them back in June should not lose the
-- history — but they do not count toward the cap and are not billed.
--
-- consent_text is stored in FULL, not as a version string. The host is
-- asserting a lawful basis to hold someone else's contact details, and the
-- only defensible record of that is the exact words they were shown.
CREATE TABLE IF NOT EXISTS num_host_clients (
  id            TEXT PRIMARY KEY,
  host_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT,
  email_lc      TEXT,
  phone         TEXT,
  home_city     TEXT,
  home_country  TEXT,
  languages     TEXT,                       -- free text — the host's own note
  notes         TEXT,                       -- preferences, allergies-as-written, the usual table
  member_id     TEXT,                       -- set only if this person is ALSO a NUM member
  source        TEXT NOT NULL DEFAULT 'host_added'
                CHECK (source IN ('host_added','num_offer','self_joined')),
  consent_basis TEXT NOT NULL DEFAULT 'host_asserted',
  consent_text  TEXT NOT NULL,              -- the exact attestation the host ticked
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','paused','removed')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);
-- The cap query. Counting a host's active clients is the single most frequent
-- read in the billing path, so it must never be a table scan.
CREATE INDEX IF NOT EXISTS idx_host_clients_host   ON num_host_clients(host_id, status);
-- Dedupe. A host pasting the same list twice must not double their own bill.
CREATE UNIQUE INDEX IF NOT EXISTS idx_host_clients_email
  ON num_host_clients(host_id, email_lc) WHERE email_lc IS NOT NULL;

-- ── THE WORK ────────────────────────────────────────────────────────────
-- A host's own client work. Deliberately NOT num_dispatch_requests: that
-- table routes work OUT from NUM to suppliers. This one holds work that
-- belongs to the host and that NUM only ever drafts, prices and reminds on.
--
-- status has no 'auto_confirmed'. There is no state in which NUM commits a
-- host to a client without the host saying yes, and the absence of the value
-- is the enforcement.
CREATE TABLE IF NOT EXISTS num_host_requests (
  id             TEXT PRIMARY KEY,
  host_id        TEXT NOT NULL,
  client_id      TEXT,
  service_key    TEXT NOT NULL,             -- car|reservation|stay|activity|appointment|delivery
  title          TEXT NOT NULL,
  detail         TEXT,
  city           TEXT,
  country        TEXT,
  starts_at      TEXT,                      -- ISO8601 local to the request
  ends_at        TEXT,
  party_size     INTEGER,
  price_minor    INTEGER NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL DEFAULT 'GBP',
  unit           TEXT NOT NULL DEFAULT 'quote',
  quote_only     INTEGER NOT NULL DEFAULT 0 CHECK (quote_only IN (0,1)),
  status         TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','drafted','awaiting_host','confirmed','declined','done','cancelled')),
  draft_text     TEXT,                      -- what NUM proposes the host sends
  -- Host-to-host: set when this request is being fulfilled by ANOTHER host's
  -- service. The client never learns this — the two hosts settle between them.
  network_host_id TEXT,
  network_status  TEXT CHECK (network_status IN ('offered','accepted','declined','done')),
  network_fee_minor INTEGER NOT NULL DEFAULT 0,  -- NUM's flat fee, in the host's currency
  -- NUM's booking fee, charged to THE HOST and never to their client. Set on
  -- confirm, not on creation: a request that was logged and then declined is
  -- work we did not complete, and charging for it teaches hosts to stop
  -- logging the ones they are unsure about. 0 until confirmed, and the
  -- writer only sets it when it is still 0, so a repeated confirm cannot
  -- stack a second fee onto one booking.
  booking_fee_minor INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT,
  confirmed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_host_requests_host ON num_host_requests(host_id, status);
CREATE INDEX IF NOT EXISTS idx_host_requests_net  ON num_host_requests(network_host_id, network_status);

-- ── WHAT THE HOST SELLS ─────────────────────────────────────────────────
-- Three kinds in one table, because the host thinks of them as one shelf:
--   'own'   — the host's own product: gift baskets, packaged experiences
--   'num'   — a NUM product the host resells to their client (Num Tab, membership)
--   'ghost' — a Ghost Message listing: a SKU + keyword a client can text
--
-- The Resolution Rule from num-GHOST-MESSAGE-SPEC.md applies to 'ghost' rows
-- and only to them: a ghost row with no sku, no photo or no price cannot go
-- active, because a code that resolves to nothing is the one failure that
-- makes the whole primitive untrustworthy. That is enforced in code AND by
-- the CHECK below, which is why the CHECK is written per-kind.
CREATE TABLE IF NOT EXISTS num_host_products (
  id            TEXT PRIMARY KEY,
  host_id       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('own','num','ghost')),
  sku           TEXT,                       -- ghost: the digits after the dot. THE BARCODE.
  keyword       TEXT,                       -- ghost: the human-readable handle
  name          TEXT NOT NULL,
  description   TEXT,
  category      TEXT,
  price_minor   INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'GBP',
  unit          TEXT NOT NULL DEFAULT 'item',
  photo_url     TEXT,
  num_product   TEXT,                       -- 'num' kind: which NUM product ('tab','membership','concierge')
  ghost_listing_id TEXT,                    -- set once mirrored into ghost_listings
  moderation    TEXT NOT NULL DEFAULT 'pending'
                CHECK (moderation IN ('pending','approved','rejected','flagged')),
  active        INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  -- A ghost listing that is live must resolve. No exceptions, no placeholders.
  CHECK (kind <> 'ghost' OR active = 0
         OR (sku IS NOT NULL AND keyword IS NOT NULL AND photo_url IS NOT NULL AND price_minor > 0))
);
CREATE INDEX IF NOT EXISTS idx_host_products_host ON num_host_products(host_id, kind, active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_host_products_kw
  ON num_host_products(host_id, keyword) WHERE keyword IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_host_products_sku
  ON num_host_products(host_id, sku) WHERE sku IS NOT NULL;

-- ── WHERE THE HOST WORKS ────────────────────────────────────────────────
-- areas_json on num_hosts stays the host's own editable copy — this is the
-- indexed shadow of it, rewritten on every profile save. Nearest-host
-- matching has to be a bounding-box query against real columns — a JSON
-- LIKE scan across every host is the version of this that quietly stops
-- working at a few hundred rows and is never noticed.
CREATE TABLE IF NOT EXISTS num_host_areas (
  id         TEXT PRIMARY KEY,
  host_id    TEXT NOT NULL,
  city       TEXT,
  country    TEXT,
  lat        REAL,
  lng        REAL,
  radius_km  INTEGER NOT NULL DEFAULT 50,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_host_areas_host ON num_host_areas(host_id);
CREATE INDEX IF NOT EXISTS idx_host_areas_geo  ON num_host_areas(lat, lng);

-- ── THE INTRODUCTION ────────────────────────────────────────────────────
-- A NUM member with no host, and the nearest host who might take them.
--
-- This table exists so that an introduction is a RECORD, not a side effect.
-- Nothing about the member reaches the host until member_said = 'yes' AND
-- host_said = 'yes'. Both columns default to 'pending' and there is no code
-- path that sets either on the other's behalf.
CREATE TABLE IF NOT EXISTS num_host_offers (
  id          TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL,
  host_id     TEXT NOT NULL,
  city        TEXT,
  distance_km REAL,
  member_said TEXT NOT NULL DEFAULT 'pending'
              CHECK (member_said IN ('pending','yes','no')),
  host_said   TEXT NOT NULL DEFAULT 'pending'
              CHECK (host_said IN ('pending','yes','no')),
  client_id   TEXT,                        -- the num_host_clients row, once both said yes
  created_at  TEXT NOT NULL,
  decided_at  TEXT,
  expires_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_host_offers_member ON num_host_offers(member_id, member_said);
CREATE INDEX IF NOT EXISTS idx_host_offers_host   ON num_host_offers(host_id, host_said);
-- One live offer per member per host. Re-offering the same host to the same
-- person after they declined is how a helpful feature becomes harassment.
CREATE UNIQUE INDEX IF NOT EXISTS idx_host_offers_pair ON num_host_offers(member_id, host_id);

-- ── HOST TO HOST ────────────────────────────────────────────────────────
-- A standing connection between two hosts. Host B invoices Host A directly —
-- NUM takes a flat network fee and never enters the client relationship.
-- Directionless by convention: store the pair with host_a < host_b so the
-- unique index actually prevents duplicates.
CREATE TABLE IF NOT EXISTS num_host_links (
  id         TEXT PRIMARY KEY,
  host_a     TEXT NOT NULL,
  host_b     TEXT NOT NULL,
  asked_by   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','accepted','declined','ended')),
  note       TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_host_links_pair ON num_host_links(host_a, host_b);

-- ── NEW COLUMNS ON num_hosts ────────────────────────────────────────────
-- Whether this host will take an introduction to a NUM member who has no
-- host. DEFAULT 0 — off. A host's book is the thing they have spent years
-- building, and putting a stranger in it must be something they switched on,
-- never something that happened because we shipped a feature.
ALTER TABLE num_hosts ADD COLUMN accepts_intros INTEGER NOT NULL DEFAULT 0
  CHECK (accepts_intros IN (0,1));

-- Whether other hosts may see this host in the network directory and ask to
-- connect. Also default off, for the same reason.
ALTER TABLE num_hosts ADD COLUMN in_network INTEGER NOT NULL DEFAULT 0
  CHECK (in_network IN (0,1));

-- A one-line public description used in the network directory and in an
-- introduction offer. Never their email, never their number.
ALTER TABLE num_hosts ADD COLUMN blurb TEXT;

-- Stripe subscription for the host's own monthly plan. Mirrors the biztier
-- path in worker/bizbilling.mjs rather than inventing a second billing story.
ALTER TABLE num_hosts ADD COLUMN plan_sub_id TEXT;
ALTER TABLE num_hosts ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'none'
  CHECK (plan_status IN ('none','trialing','active','past_due','cancelled'));
ALTER TABLE num_hosts ADD COLUMN plan_renews_at TEXT;

-- ── THE MONEY, FOR THE RECORD ───────────────────────────────────────────
-- THERE IS NO CLIENT CAP ON ANY TIER. A host may hold as many clients as they
-- like on the free plan. This is a commercial decision, not an omission: a
-- per-head price charges a concierge for their own success and makes their
-- first instinct to keep clients OUT of NUM, which breaks the product long
-- before it improves the invoice. If you are about to add a cap here, that is
-- the argument you are overturning.
--
-- What money buys instead is CAPABILITY, gated in growth/worker.js
-- (FEATURE_MIN_TIER):
--   free   £0        unlimited clients, services and prices, requests, drafts
--   small  £9.99/mo  + text alerts, calendar feed
--   pro    £19.99/mo + the host network, introductions from NUM
--   full   £50/mo    + products and Ghost Message, services promoted
--
-- And per booking: £5 to THE HOST on confirm (booking_fee_minor above).
-- A host's client is never billed by NUM, for anything, at any tier. A NUM
-- member with NO host pays that same £5 themselves — see worker/servicefee.mjs
-- for why the two numbers must stay identical.
