-- 0018 — a client's request reaches their host without the host typing it.
--
-- Until 4 Sep 2026 the only writer of num_host_requests was the host's own
-- console. `source` says who typed it — `host_notified_at` is the receipt that
-- the host has been told (worker/hostaware.mjs notifyHosts keys on it).
--
-- worker/hostaware.mjs adds these lazily on first use as well, so a database
-- that has not run this file still works — running it makes the columns exist
-- before the first relay rather than during it.
ALTER TABLE num_host_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'host';
ALTER TABLE num_host_requests ADD COLUMN host_notified_at TEXT;
CREATE INDEX IF NOT EXISTS idx_host_requests_untold
  ON num_host_requests(source, host_notified_at, created_at);
