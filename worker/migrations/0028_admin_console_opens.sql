-- The admin door into the two consoles NUM does not own the sign-in for.
--
-- WHY THIS TABLE EXISTS
--
-- /ops is the operator console and it could not open either of the other two.
-- A business console is entered with a venue's own email session or its
-- permanent `console_key` — a host console is entered with the host's
-- `console_key`. An operator checking "does this actually work for a venue"
-- held neither, so the honest answer was to go and find a real venue's
-- permanent key and paste it into a URL -- which puts a forever-credential in
-- browser history, in referrer headers and in any screenshot.
--
-- This table is the handoff instead. /ops mints a row, the operator is sent to
-- itsnum.com/o/<token>, and that route burns the row and grants a SHORT,
-- SCOPED session. The permanent key is never the thing being handled.
--
-- Only the SHA-256 of the token is stored. A database backup cannot mint an
-- open link, exactly as num_biz_logins already refuses to.
--
-- Every row is kept after it is used. This is the audit trail for "who opened
-- whose console, and when" -- an admin who can enter any venue's console is a
-- real power, and an unlogged one is the kind nobody notices being misused.
CREATE TABLE IF NOT EXISTS num_admin_console_opens (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  target_name TEXT,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL,
  created_ip  TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_console_opens_created
  ON num_admin_console_opens (created_at DESC);
