-- Num Expert onboarding paperwork.
--
-- ── WHAT IS AND IS NOT STORED HERE ───────────────────────────────────────
--
-- There is NO COLUMN FOR A TAXPAYER IDENTIFICATION NUMBER, and there must
-- never be one. A W-9 carries an SSN. An SSN is the single most valuable thing
-- an attacker could take from NUM, it is useless to us day to day, and holding
-- one turns an ordinary security incident into a notifiable breach under
-- California Civil Code 1798.82 and its equivalents in most other states.
--
-- So: the signed W-9 goes to object storage as an opaque file, behind admin
-- access, and NOTHING is parsed out of it into this table. What lives here is
-- the fact that a document exists, who signed it, and when.
--
-- If you ever find yourself adding a `tin` column to make a report easier,
-- the answer is a payer-of-record (Stripe Connect and its peers collect the
-- W-9, verify the TIN and file the 1099s) so the number never touches NUM at
-- all. That is the better architecture and it is one integration away.
--
-- ── THE NDA IS SIGNED IN THE BROWSER, NOT UPLOADED ───────────────────────
--
-- Under the US ESIGN Act an electronic signature is valid where there is
-- intent to sign, consent to do business electronically, and a retained
-- record associating the signature with the document. All three are captured
-- below: the typed name, the consent, and body_sha256 — the hash of the exact
-- text they saw. Storing the hash rather than a copy means a later edit to the
-- template cannot silently change what somebody agreed to.

CREATE TABLE IF NOT EXISTS num_expert_docs (
  id           TEXT PRIMARY KEY,
  scout_id     TEXT NOT NULL REFERENCES num_scouts(id),

  -- 'nda' — signed in the browser, no file
  -- 'w9'  — the IRS form, filled by them, uploaded back as a file
  kind         TEXT NOT NULL CHECK (kind IN ('nda', 'w9')),

  -- pending  → we are waiting on them
  -- signed   → the NDA is signed (nda only)
  -- uploaded → a file arrived and nobody has looked at it (w9 only)
  -- accepted → a person at NUM checked it
  -- rejected → wrong form, illegible, or unsigned. reject_reason says which
  state        TEXT NOT NULL DEFAULT 'pending'
               CHECK (state IN ('pending', 'signed', 'uploaded', 'accepted', 'rejected')),
  reject_reason TEXT,

  -- ── the e-signature record (nda) ───────────────────────────────────────
  -- The version of the template, and the hash of the exact bytes they were
  -- shown. Version alone is not enough: a template edited in place would
  -- leave everyone pointing at text they never read.
  doc_version  TEXT,
  body_sha256  TEXT,
  signed_name  TEXT,          -- what they typed, which is the signature
  signed_at    TEXT,
  signed_ip    TEXT,
  signed_ua    TEXT,

  -- ── the uploaded file (w9) ─────────────────────────────────────────────
  -- A key into object storage. Never a URL: a URL in a database gets pasted
  -- into a browser, and this file has somebody's SSN in it.
  object_key   TEXT,
  bytes        INTEGER CHECK (bytes IS NULL OR (bytes > 0 AND bytes <= 10485760)),
  content_type TEXT,
  uploaded_at  TEXT,

  reviewed_by  TEXT,
  reviewed_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),

  -- One live row per document per Expert.
  UNIQUE (scout_id, kind),

  -- An NDA has a signature and no file. A W-9 has a file and no typed
  -- signature. Enforced here so a half-built flow cannot write a shape that
  -- later code will misread.
  CHECK (kind <> 'nda' OR object_key IS NULL),
  CHECK (kind <> 'w9'  OR signed_name IS NULL),
  -- Nothing reaches a terminal state without its evidence.
  CHECK (state <> 'signed'   OR (signed_name IS NOT NULL AND body_sha256 IS NOT NULL)),
  CHECK (state <> 'uploaded' OR object_key IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_num_expert_docs_scout ON num_expert_docs (scout_id);
CREATE INDEX IF NOT EXISTS idx_num_expert_docs_state ON num_expert_docs (state);
