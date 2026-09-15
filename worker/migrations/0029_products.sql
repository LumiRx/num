-- A venue's own menu — what it sells, at what price, and how much is left.
--
-- WHY A TABLE AND NOT A JSON BLOB ON THE BUSINESS
--
-- Stock changes far more often than anything else about a venue, and a blob
-- means every stock decrement rewrites the whole menu. Two staff marking two
-- different items out of stock in the same minute would then lose one of the
-- two edits, silently, and the first anyone knows is a guest ordering
-- something that ran out an hour ago.
--
-- price_cs is minor units of THIS ROW'S currency, stored on the row rather
-- than read from the venue at display time. A venue that later corrects its
-- country must not silently reprice its entire menu -- 1200 meaning twelve
-- dollars must not quietly become twelve hundred baht.
--
-- stock NULL means NOT TRACKED, which is a different fact from 0. Most venues
-- never count stock at all, and showing them "0 left" on every item would be
-- both wrong and alarming.
CREATE TABLE IF NOT EXISTS num_products (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  blurb       TEXT,
  category    TEXT,
  price_cs    INTEGER NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL,
  stock       INTEGER,
  available   INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_products_business ON num_products (business_id, archived_at, sort);
