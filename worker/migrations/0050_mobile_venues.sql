-- 0050 - a venue that moves, and where it is standing right now.
--
-- WHY THIS EXISTS
-- Every place in NUM is a fixed point. places.lat/lng are NOT NULL, the
-- concierge finds things with a grid-cell prefilter and a haversine, and both
-- assume the answer is still true tomorrow. That is right for a restaurant and
-- false for a taco truck, a market stall, a beach vendor, or a boat that
-- changes mooring.
--
-- Hugo's Tacos is the first. The two Hugo's Restaurant sites run on Resy and the
-- taco side has no booking system because there is nothing to book. The only
-- question a guest has is where the truck is standing, and that is a question
-- a pin on a map cannot answer - nobody updates a listing at 11am because they
-- parked on Abbot Kinney, and nobody removes it at 3pm when they leave.
--
-- THE RULE THESE TABLES ENFORCE
-- A stale pin is a lie, and a lie about a location costs somebody a journey.
-- So a position is not a coordinate, it is a coordinate WITH AN EXPIRY that
-- the operator set themselves. Past it, the application returns no coordinates
-- at all - not stale ones behind a flag, absent ones. What survives is the
-- history, which is honest: "not parked anywhere right now, last time it was
-- in Venice".
--
-- The operator sets the expiry because a fixed timeout would be a guess about
-- somebody else's day. A lunch pitch is two hours, a festival is ten. The only
-- opinion the code has is a twelve-hour ceiling, because "parked here till
-- next Tuesday" is a typo rather than a plan.

-- Which venues move. Registered deliberately, never inferred from a category:
-- plenty of places called "truck" do not move and plenty of carts do.
CREATE TABLE IF NOT EXISTS num_mobile_venues (
  place_id     TEXT PRIMARY KEY,
  business_id  TEXT,
  name         TEXT,
  kind         TEXT NOT NULL DEFAULT 'truck',
  home_dest    TEXT,
  social_url   TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Where they are now. One row per venue, replaced each time they park.
-- valid_until is the whole safety property and is never defaulted by us.
CREATE TABLE IF NOT EXISTS num_venue_positions (
  place_id    TEXT PRIMARY KEY,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  accuracy_m  REAL,
  label       TEXT,
  valid_until TEXT NOT NULL,
  set_by      TEXT,
  set_via     TEXT NOT NULL DEFAULT 'link',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only. This answers "where were they yesterday" once the current
-- position has expired, and it is the operator's own record of where they have
-- stood, which is worth more to them than it is to us.
CREATE TABLE IF NOT EXISTS num_venue_position_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id    TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  label       TEXT,
  valid_until TEXT NOT NULL,
  set_by      TEXT,
  set_via     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vposlog_place ON num_venue_position_log(place_id, created_at DESC);
