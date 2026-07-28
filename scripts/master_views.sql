-- NUM · master database
--
-- D1 holds 63 tables. Nobody, including us, can hold that in their head, and a
-- dashboard that queries them ad hoc drifts the moment someone adds a column.
-- These views are the contract: one curated surface over everything NUM knows,
-- read by /api/master and by the console. Tables stay normalised; the views do
-- the joining and the naming, in one place, once.
--
-- Re-runnable. Drops and recreates. No data is written.

-- ---------------------------------------------------------------- supply ---
-- What we hold, per destination. Built from `destinations` rather than from
-- `places` so that a destination we have not ingested yet shows as a zero row
-- instead of vanishing — the gap is the useful part.
DROP VIEW IF EXISTS v_master_destination;
CREATE VIEW v_master_destination AS
SELECT
  d.slug AS dest, d.name, d.country, d.region, d.tz, d.live,
  COALESCE(s.places,0)       AS places,
  COALESCE(s.with_phone,0)   AS with_phone,
  COALESCE(s.with_email,0)   AS with_email,
  COALESCE(s.with_website,0) AS with_website,
  COALESCE(s.with_rating,0)  AS with_rating,
  COALESCE(s.with_hygiene,0) AS with_hygiene,
  COALESCE(s.with_local,0)   AS with_local_name,
  COALESCE(s.claimed,0)      AS claimed,
  COALESCE(t.ranked,0)       AS ranked,
  COALESCE(l.leads,0)        AS leads,
  d.last_ingest_at
FROM destinations d
LEFT JOIN (
  SELECT dest,
    COUNT(*) AS places,
    SUM(CASE WHEN phone      IS NOT NULL AND phone      <> '' THEN 1 ELSE 0 END) AS with_phone,
    SUM(CASE WHEN email      IS NOT NULL AND email      <> '' THEN 1 ELSE 0 END) AS with_email,
    SUM(CASE WHEN website    IS NOT NULL AND website    <> '' THEN 1 ELSE 0 END) AS with_website,
    SUM(CASE WHEN name_local IS NOT NULL AND name_local <> '' THEN 1 ELSE 0 END) AS with_local,
    SUM(CASE WHEN rating     IS NOT NULL THEN 1 ELSE 0 END) AS with_rating,
    SUM(CASE WHEN hygiene    IS NOT NULL THEN 1 ELSE 0 END) AS with_hygiene,
    SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END)     AS claimed
  FROM places GROUP BY dest
) s ON s.dest = d.slug
LEFT JOIN (SELECT dest, COUNT(*) AS ranked FROM top_places GROUP BY dest) t ON t.dest = d.slug
LEFT JOIN (SELECT dest, COUNT(*) AS leads  FROM leads      GROUP BY dest) l ON l.dest = d.slug;

-- Provenance. Every source carries the attribution string it must be published
-- with, so the console cannot render a listing without its licence: anything
-- arriving from an unrecognised source is labelled "do not publish" rather
-- than quietly appearing on a page.
DROP VIEW IF EXISTS v_master_source;
CREATE VIEW v_master_source AS
SELECT
  COALESCE(source,'unknown') AS source,
  COUNT(*)                   AS places,
  COUNT(DISTINCT dest)       AS dests,
  SUM(CASE WHEN phone   IS NOT NULL AND phone   <> '' THEN 1 ELSE 0 END) AS with_phone,
  SUM(CASE WHEN email   IS NOT NULL AND email   <> '' THEN 1 ELSE 0 END) AS with_email,
  SUM(CASE WHEN rating  IS NOT NULL THEN 1 ELSE 0 END) AS with_rating,
  SUM(CASE WHEN hygiene IS NOT NULL THEN 1 ELSE 0 END) AS with_hygiene,
  CASE COALESCE(source,'unknown')
    WHEN 'osm'           THEN '© OpenStreetMap contributors (ODbL)'
    WHEN 'overture'      THEN '© Overture Maps Foundation (CDLA-Permissive-2.0, Apache-2.0, CC0-1.0)'
    WHEN 'fhrs'          THEN 'Contains public sector information licensed under the Open Government Licence v3.0'
    WHEN 'google_places' THEN 'Google Places API'
    ELSE 'unattributed — do not publish'
  END AS attribution
FROM places GROUP BY COALESCE(source,'unknown');

-- The recommendation set the concierge actually reads.
DROP VIEW IF EXISTS v_master_top_places;
CREATE VIEW v_master_top_places AS
SELECT bucket,
  COUNT(*) AS ranked, COUNT(DISTINCT dest) AS dests,
  ROUND(AVG(score),1) AS avg_score, ROUND(MAX(score),1) AS max_score,
  SUM(CASE WHEN rating  IS NOT NULL THEN 1 ELSE 0 END) AS backed_by_rating,
  SUM(CASE WHEN hygiene IS NOT NULL THEN 1 ELSE 0 END) AS backed_by_hygiene,
  MAX(built_at) AS built_at
FROM top_places GROUP BY bucket;

-- ------------------------------------------------------------- outreach ---
DROP VIEW IF EXISTS v_master_leads;
CREATE VIEW v_master_leads AS
SELECT
  COALESCE(channel,'unknown') AS channel,
  COALESCE(status,'new')      AS status,
  COALESCE(priority,9)        AS priority,
  COUNT(*)                    AS leads,
  COUNT(DISTINCT dest)        AS dests,
  SUM(CASE WHEN owner IS NOT NULL AND owner <> '' THEN 1 ELSE 0 END) AS assigned
FROM leads GROUP BY 1,2,3;

-- ---------------------------------------------------------------- demand ---
-- Guest-side activity. Everything here is one row so the dashboard can render
-- it without looping. The 7d/30d windows are computed against epoch seconds
-- because the num_* tables store INTEGER time, unlike places/leads which store
-- TEXT — a difference worth keeping in one place rather than in every query.
DROP VIEW IF EXISTS v_master_demand;
CREATE VIEW v_master_demand AS
SELECT
  (SELECT COUNT(*) FROM num_guest_profiles)                          AS guests,
  (SELECT COUNT(*) FROM num_guest_profiles
     WHERE last_seen_at >= strftime('%s','now') - 604800)            AS guests_7d,
  (SELECT COUNT(*) FROM num_guest_profiles WHERE consent_memory = 1) AS guests_consented,
  (SELECT COUNT(*) FROM num_messages)                                AS messages,
  (SELECT COUNT(*) FROM num_messages
     WHERE created_at >= strftime('%s','now') - 604800)              AS messages_7d,
  (SELECT COUNT(*) FROM num_requests)                                AS requests,
  (SELECT COUNT(*) FROM num_requests WHERE status = 'fulfilled')     AS requests_fulfilled,
  (SELECT COUNT(*) FROM num_requests WHERE status = 'unfulfilled')   AS requests_unfulfilled,
  (SELECT COUNT(*) FROM num_unmet_demand)                            AS unmet_demand,
  (SELECT COUNT(*) FROM num_bookings)                                AS bookings,
  (SELECT COUNT(*) FROM num_bookings WHERE status = 'confirmed')     AS bookings_confirmed,
  (SELECT COUNT(*) FROM num_orders)                                  AS orders,
  (SELECT COUNT(*) FROM num_taps)                                    AS taps,
  (SELECT COUNT(*) FROM num_taps WHERE converted = 1)                AS taps_converted,
  (SELECT COUNT(*) FROM businesses)                                  AS businesses,
  (SELECT COUNT(*) FROM claims)                                      AS claims,
  (SELECT COUNT(*) FROM users)                                       AS accounts;

-- ----------------------------------------------------------------- money ---
-- Currency is stored in integer minor units (…_cs) everywhere. These views
-- keep it that way. Do not divide by 100 in SQL — the caller formats.
DROP VIEW IF EXISTS v_master_money;
CREATE VIEW v_master_money AS
SELECT
  (SELECT COALESCE(SUM(total_cs),0)      FROM num_orders)   AS order_value_cs,
  (SELECT COALESCE(SUM(commission_cs),0) FROM num_orders)   AS order_commission_cs,
  (SELECT COALESCE(SUM(value_cs),0)      FROM num_bookings) AS booking_value_cs,
  (SELECT COALESCE(SUM(commission_cs),0) FROM num_bookings) AS booking_commission_cs,
  (SELECT COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END),0) FROM stars_ledger) AS stars_issued,
  (SELECT COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END),0) FROM stars_ledger) AS stars_spent,
  (SELECT COALESCE(SUM(delta),0) FROM stars_ledger)         AS stars_outstanding;

-- ---------------------------------------------------------------- totals ---
-- One row, wide. This started life as a tall (section, metric, value) view
-- built with UNION ALL, which is the natural shape for a dashboard — and D1
-- rejects it: SQLITE_MAX_COMPOUND_SELECT is 5 there, so any unpivot longer
-- than five rows dies with "too many terms in compound SELECT". Wide is the
-- shape that survives. /api/master transposes it into sections for display.
--
-- The places aggregate is computed once in a subquery and cross-joined rather
-- than repeated as nine scalar subqueries, so this costs a single pass over
-- the 350k-row table instead of nine.
DROP VIEW IF EXISTS v_master_snapshot;
DROP VIEW IF EXISTS v_master_totals;
CREATE VIEW v_master_totals AS
SELECT
  p.places, p.destinations_ingested, p.with_phone, p.with_email, p.with_website,
  p.with_rating, p.with_hygiene, p.with_local_name, p.claimed,
  (SELECT COUNT(*) FROM destinations WHERE live = 1)  AS destinations_live,
  (SELECT COUNT(*) FROM top_places)                   AS ranked_places,
  (SELECT COUNT(*) FROM leads)                        AS leads,
  (SELECT COUNT(*) FROM leads WHERE status <> 'new')  AS leads_worked,
  d.guests, d.guests_7d, d.messages, d.messages_7d, d.requests,
  d.requests_fulfilled, d.unmet_demand, d.bookings, d.orders, d.taps,
  d.businesses, d.claims, d.accounts,
  m.order_value_cs, m.order_commission_cs, m.booking_value_cs,
  m.booking_commission_cs, m.stars_issued, m.stars_outstanding
FROM (
  SELECT
    COUNT(*) AS places, COUNT(DISTINCT dest) AS destinations_ingested,
    SUM(CASE WHEN phone      IS NOT NULL AND phone      <> '' THEN 1 ELSE 0 END) AS with_phone,
    SUM(CASE WHEN email      IS NOT NULL AND email      <> '' THEN 1 ELSE 0 END) AS with_email,
    SUM(CASE WHEN website    IS NOT NULL AND website    <> '' THEN 1 ELSE 0 END) AS with_website,
    SUM(CASE WHEN name_local IS NOT NULL AND name_local <> '' THEN 1 ELSE 0 END) AS with_local_name,
    SUM(CASE WHEN rating     IS NOT NULL THEN 1 ELSE 0 END) AS with_rating,
    SUM(CASE WHEN hygiene    IS NOT NULL THEN 1 ELSE 0 END) AS with_hygiene,
    SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END)     AS claimed
  FROM places
) p, v_master_demand d, v_master_money m;

-- ---------------------------------------------------------------- alarms ---
-- The eleven v_num_* invariant views already in this database each return the
-- rows that should not exist. Counting them gives one line that should read
-- all zeros; anything else is a bug with a name.
DROP VIEW IF EXISTS v_master_alarms;
CREATE VIEW v_master_alarms AS
SELECT
  (SELECT COUNT(*) FROM v_num_wallet_unbalanced)       AS wallet_unbalanced,
  (SELECT COUNT(*) FROM v_num_wallet_drift)            AS wallet_drift,
  (SELECT COUNT(*) FROM v_num_stale_holds)             AS stale_holds,
  (SELECT COUNT(*) FROM v_num_orphan_claims)           AS orphan_claims,
  (SELECT COUNT(*) FROM v_num_charged_not_confirmed)   AS charged_not_confirmed,
  (SELECT COUNT(*) FROM v_num_bookings_without_claims) AS bookings_without_claims,
  (SELECT COUNT(*) FROM v_num_silent_failures)         AS silent_failures,
  (SELECT COUNT(*) FROM v_num_tenant_violations)       AS tenant_violations,
  (SELECT COUNT(*) FROM v_num_template_coverage_gaps)  AS template_gaps,
  (SELECT COUNT(*) FROM v_num_lessons_underperforming) AS lessons_underperforming;
