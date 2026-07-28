-- NUM — invite ledger
-- ------------------------------------------------------------------
-- One row per business we invite. Written BEFORE the send so a crash
-- mid-batch can never produce a silent double-send: the token is the
-- receipt. Also the suppression list, which is the only table that is
-- allowed to be permanent — an unsubscribe must survive every rebuild.
--
--   npx wrangler@latest d1 execute num-db --remote --file=sql/invites.sql -y

CREATE TABLE IF NOT EXISTS num_invites (
  token           TEXT PRIMARY KEY,          -- also the unsub / pixel / claim key
  lead_id         TEXT NOT NULL,
  email           TEXT NOT NULL,
  business_name   TEXT,
  category        TEXT,
  dest            TEXT,
  country         TEXT,
  risk            TEXT,                      -- ok | care | hold  (jurisdiction tier)
  subject         TEXT,
  batch           TEXT,                      -- e.g. 2026-07-27-gb-01
  status          TEXT NOT NULL DEFAULT 'queued',  -- queued|sent|failed|unsubscribed|bounced
  provider_id     TEXT,                      -- Resend message id
  error           TEXT,
  queued_at       TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at         TEXT,
  opened_at       TEXT,
  open_count      INTEGER NOT NULL DEFAULT 0,
  clicked_at      TEXT,
  click_count     INTEGER NOT NULL DEFAULT 0,
  unsubscribed_at TEXT,
  claimed_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_invites_email   ON num_invites(email);
CREATE INDEX IF NOT EXISTS idx_invites_status  ON num_invites(status);
CREATE INDEX IF NOT EXISTS idx_invites_batch   ON num_invites(batch);
CREATE INDEX IF NOT EXISTS idx_invites_lead    ON num_invites(lead_id);
CREATE INDEX IF NOT EXISTS idx_invites_sent    ON num_invites(sent_at);

-- Never email these again. Reasons: unsub | bounce | complaint | manual | wave1
CREATE TABLE IF NOT EXISTS num_suppressions (
  email      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Console views ─────────────────────────────────────────────────
-- GROUP BY shapes only: D1 caps SQLITE_MAX_COMPOUND_SELECT at 5.

DROP VIEW IF EXISTS v_invite_funnel;
CREATE VIEW v_invite_funnel AS
SELECT
  COUNT(*)                                                   AS invited,
  SUM(CASE WHEN status='sent'         THEN 1 ELSE 0 END)      AS sent,
  SUM(CASE WHEN status='failed'       THEN 1 ELSE 0 END)      AS failed,
  SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END)      AS opened,
  SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END)     AS clicked,
  SUM(CASE WHEN claimed_at IS NOT NULL THEN 1 ELSE 0 END)     AS claimed,
  SUM(CASE WHEN unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END) AS unsubscribed,
  ROUND(100.0 * SUM(CASE WHEN opened_at  IS NOT NULL THEN 1 ELSE 0 END)
        / NULLIF(SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END),0), 1) AS open_pct,
  ROUND(100.0 * SUM(CASE WHEN claimed_at IS NOT NULL THEN 1 ELSE 0 END)
        / NULLIF(SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END),0), 1) AS claim_pct
FROM num_invites;

DROP VIEW IF EXISTS v_invite_daily;
CREATE VIEW v_invite_daily AS
SELECT
  substr(sent_at,1,10) AS day,
  COUNT(*)             AS sent,
  SUM(CASE WHEN opened_at  IS NOT NULL THEN 1 ELSE 0 END) AS opened,
  SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
  SUM(CASE WHEN claimed_at IS NOT NULL THEN 1 ELSE 0 END) AS claimed,
  SUM(CASE WHEN unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END) AS unsubscribed
FROM num_invites
WHERE sent_at IS NOT NULL
GROUP BY substr(sent_at,1,10);

DROP VIEW IF EXISTS v_invite_by_market;
CREATE VIEW v_invite_by_market AS
SELECT
  country,
  dest,
  risk,
  COUNT(*)                                                AS invited,
  SUM(CASE WHEN status='sent'          THEN 1 ELSE 0 END) AS sent,
  SUM(CASE WHEN opened_at  IS NOT NULL THEN 1 ELSE 0 END) AS opened,
  SUM(CASE WHEN claimed_at IS NOT NULL THEN 1 ELSE 0 END) AS claimed,
  SUM(CASE WHEN unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END) AS unsubscribed
FROM num_invites
GROUP BY country, dest, risk;

DROP VIEW IF EXISTS v_invite_by_category;
CREATE VIEW v_invite_by_category AS
SELECT
  category,
  COUNT(*)                                                AS invited,
  SUM(CASE WHEN status='sent'          THEN 1 ELSE 0 END) AS sent,
  SUM(CASE WHEN opened_at  IS NOT NULL THEN 1 ELSE 0 END) AS opened,
  SUM(CASE WHEN claimed_at IS NOT NULL THEN 1 ELSE 0 END) AS claimed
FROM num_invites
GROUP BY category;

-- How much of the pool is still reachable, by market and jurisdiction tier.
DROP VIEW IF EXISTS v_invite_pool;
CREATE VIEW v_invite_pool AS
SELECT
  l.country,
  COUNT(*) AS emailable,
  SUM(CASE WHEN i.token IS NULL AND s.email IS NULL THEN 1 ELSE 0 END) AS remaining
FROM leads l
LEFT JOIN num_invites     i ON lower(i.email) = lower(l.email)
LEFT JOIN num_suppressions s ON lower(s.email) = lower(l.email)
WHERE l.email IS NOT NULL AND l.email <> ''
GROUP BY l.country;
