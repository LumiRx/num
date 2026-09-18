-- How they liked it — the reaction ledger.
--
-- The five emoji under every NUM answer (😍 👍 😐 👎 🥱) have shaped each
-- guest's own style profile since they shipped, and nothing else: the tap
-- stayed on the phone. So the one signal people actually give — no typing, no
-- form — never reached the team. "Are the answers getting better" was
-- answered from anecdote.
--
-- One row per (person, message). A second tap on the same message REPLACES
-- the first (ON CONFLICT in worker/reactions.mjs) — a change of mind is not
-- two opinions. Everything the dashboard needs rides on the row itself
-- (lane, brain, place, the ask, the reply's opening), so a rating can be read
-- without joining back to num_asks, whose id the app never sees.
--
-- `asked` and `reply` are scrubbed with the same scrubAsk() as num_asks — a
-- phone number or an email in a question does not become a phone number in a
-- dashboard.

CREATE TABLE IF NOT EXISTS num_reactions (
  id         TEXT PRIMARY KEY,
  ts         TEXT NOT NULL DEFAULT (datetime('now')),
  day        TEXT NOT NULL,
  who        TEXT NOT NULL,            -- m:<member id> or a:<anon id>
  member_id  TEXT,
  anon_id    TEXT,
  msg_index  INTEGER NOT NULL,
  reaction   TEXT NOT NULL,            -- love | like | meh | no | long
  subject    TEXT,                     -- the suggestion being rated (card title or opening clause)
  asked      TEXT,                     -- the guest's question, scrubbed
  reply      TEXT,                     -- the answer's opening, scrubbed
  place      TEXT,
  lane       TEXT,
  brain      TEXT,
  model      TEXT,
  lang       TEXT
);
CREATE INDEX IF NOT EXISTS idx_reactions_day  ON num_reactions(day);
CREATE INDEX IF NOT EXISTS idx_reactions_lane ON num_reactions(lane, reaction);
CREATE INDEX IF NOT EXISTS idx_reactions_who  ON num_reactions(who, ts);
