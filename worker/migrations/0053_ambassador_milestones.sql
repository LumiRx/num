-- 0053 — sign-up milestones and the mystery bonus behind each one.
--
-- Dre's call, 19 Sep 2026: the bonus is a MYSTERY and nothing is guaranteed.
-- NUM chooses what each milestone is worth when somebody reaches it — a trip,
-- a ride, clothes, something from a brand, Stars — and gets in touch.
--
-- ══ THE FAILURE MODE THIS TABLE EXISTS TO PREVENT ══════════════════════
--
-- With nothing guaranteed, the risk is not the promise. It is the SILENCE.
-- An ambassador hits 25 sign-ups, nobody at NUM notices, and three weeks
-- later they tell the other ambassadors that the milestones are decoration.
-- That costs more than any prize would have.
--
-- So reaching a milestone is a ROW, not an event that scrolls past. Every row
-- is a piece of work someone at NUM owes a person, and it sits in `reached`
-- until a human moves it. "What do we owe, and to whom" is answerable with
-- one query, which is the only thing that makes a discretionary reward
-- honest rather than a way of never paying.
--
-- The state is deliberately short. `declined` exists because sometimes the
-- answer is no — a farm, a duplicate, a person who broke the terms — and a
-- no that is recorded is a different thing from a no that is silence.
CREATE TABLE IF NOT EXISTS num_ambassador_milestones (
  id             TEXT PRIMARY KEY,
  ambassador_id  TEXT NOT NULL,
  -- How many sign-ups this rung is. The ladder lives in growth/milestones.mjs
  -- and a test binds the two, so a rung can be added without a migration and
  -- cannot be added in only one place.
  tier           INTEGER NOT NULL,
  -- What they had actually reached when it fired. Kept because the ladder may
  -- change later and a row must still say what was true on the day.
  referred_count INTEGER NOT NULL,
  state          TEXT NOT NULL DEFAULT 'reached'
                 CHECK (state IN ('reached','chosen','sent','declined')),
  -- Filled in by a person, not by code. NULL while it is still a mystery,
  -- which is most of the time and is the point.
  reward_kind    TEXT,
  reward_note    TEXT,
  decided_by     TEXT,
  reached_at     TEXT NOT NULL,
  chosen_at      TEXT,
  sent_at        TEXT,
  created_at     TEXT NOT NULL
);
-- One row per ambassador per rung, for ever. Without this a recount on a
-- Tuesday fires every milestone they have ever passed all over again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_amb_ms_pair
  ON num_ambassador_milestones(ambassador_id, tier);
-- The work queue: everything anybody is still owed, oldest first.
CREATE INDEX IF NOT EXISTS idx_amb_ms_open
  ON num_ambassador_milestones(state, reached_at);
