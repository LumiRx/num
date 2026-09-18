-- 0044 — "this week in <city>": headlines from city what's-on publishers
-- that publish a public RSS feed, kept as title + link + date + source only.
--
-- Dre, 18 Sep 2026: research pages like @secret.losangeles "every major city
-- has one" and add them to suggestions. The research (project doc
-- NUM-secret-city-sources-2026-09-18.md) found the Secret Media Network is
-- Fever's and its terms forbid scraping, aggregating and linking without
-- consent. Time Out's terms forbid AI use of its content. Resident Advisor
-- forbids commercial extraction. None of those is here. What IS here is the
-- set of independents that publish an RSS feed — the conventional signal that
-- headline + link + credit syndication is welcome — and the table holds
-- exactly that: no body text, no images, nothing a publisher could call a
-- copy. Every row links out with the source named.
--
-- EVERY LINE IS ITS OWN STATEMENT.

CREATE TABLE IF NOT EXISTS num_whatson (
  id           TEXT PRIMARY KEY,
  dest         TEXT NOT NULL,
  source       TEXT NOT NULL,
  title        TEXT NOT NULL,
  url          TEXT NOT NULL,
  published_at TEXT,
  fetched_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatson_url ON num_whatson(url);

CREATE INDEX IF NOT EXISTS idx_whatson_dest ON num_whatson(dest, published_at);

CREATE TABLE IF NOT EXISTS num_whatson_fetch (
  source     TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 1,
  note       TEXT
);
