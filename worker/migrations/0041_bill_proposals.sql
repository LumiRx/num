-- 0041 — a figure a model read off a photograph of a bill, waiting for a
-- member of staff to say yes.
--
-- WHY A TABLE AND NOT JUST A MINTED BILL
-- Because the model proposes and staff confirm, and the gap between those two
-- things is where the safety lives. billqr.mjs's argument that a venue cannot
-- under-report rests on a human being accountable for the number on the code.
-- A row here is that pause, made durable.
--
-- WHAT IS DELIBERATELY ABSENT: the photograph. A restaurant bill can carry a
-- guest's name, a card's last four, a room number. What a dispute needs is
-- what the reader SAID and which image it said it about, so this keeps the raw
-- answer, the confidence and a hash. The bytes never land anywhere.
--
-- `corrected` is the honesty column. Over a few hundred bills it is the only
-- real measure of whether reading a photo beats typing four digits, and it is
-- recorded whether or not anybody asks for it.

CREATE TABLE IF NOT EXISTS num_bill_proposals (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL,
  resource_id      TEXT,
  booking_id       TEXT,
  amount_minor     INTEGER,
  currency         TEXT NOT NULL,
  confidence       REAL,
  note             TEXT,
  raw              TEXT,
  image_sha        TEXT,
  state            TEXT NOT NULL DEFAULT 'proposed'
                   CHECK (state IN ('proposed','unreadable','confirmed','discarded')),
  confirmed_minor  INTEGER,
  corrected        INTEGER NOT NULL DEFAULT 0 CHECK (corrected IN (0,1)),
  token            TEXT,
  created_by       TEXT,
  confirmed_by     TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_bill_proposals_biz ON num_bill_proposals(business_id, created_at);
