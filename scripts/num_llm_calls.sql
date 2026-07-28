-- NUM · LLM call metering
--
-- Every model call the concierge makes, including the ones that cost nothing.
-- Logging the free tier is the point: a router that claims to save money is
-- only believable if the messages it answered for free are counted in the same
-- table as the ones it paid for.
--
-- created_at is epoch seconds, matching the other num_* tables. (The places /
-- leads / businesses side of the database stores TEXT datetimes — that split is
-- pre-existing and deliberate, not an oversight here.)

CREATE TABLE IF NOT EXISTS num_llm_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  tier        TEXT    NOT NULL,          -- t0 template · t1 small model · t2 full concierge
  model       TEXT,                      -- null on t0, because no model ran
  kind        TEXT,                      -- greeting, thanks, place, arranging, trouble, sea…
  lang        TEXT,
  dest        TEXT,
  in_tokens   INTEGER NOT NULL DEFAULT 0,
  out_tokens  INTEGER NOT NULL DEFAULT 0,
  estimated   INTEGER NOT NULL DEFAULT 0, -- 1 = we counted characters, the model gave us no usage block
  escalated   INTEGER NOT NULL DEFAULT 0, -- 1 = this call was a t1 answer we threw away and re-ran at t2
  ms          INTEGER NOT NULL DEFAULT 0,
  ok          INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON num_llm_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_calls_tier    ON num_llm_calls(tier, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_calls_kind    ON num_llm_calls(kind);

-- The mix. One row per tier — how much traffic each one absorbed and what it
-- cost. `escalated` is the honest column: those are t1 answers we paid for,
-- threw away, and paid for again at t2.
DROP VIEW IF EXISTS v_llm_tier_mix;
CREATE VIEW v_llm_tier_mix AS
SELECT
  tier,
  COUNT(*)                                   AS calls,
  SUM(in_tokens)                             AS in_tokens,
  SUM(out_tokens)                            AS out_tokens,
  SUM(in_tokens + out_tokens)                AS tokens,
  SUM(escalated)                             AS escalated,
  SUM(estimated)                             AS rows_estimated,
  CAST(ROUND(AVG(ms)) AS INTEGER)            AS avg_ms,
  SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END)    AS failures
FROM num_llm_calls
GROUP BY tier;

-- What the router actually saved, calibrated against our own traffic rather
-- than against a number I typed in. The baseline is the mean cost of a real t2
-- call in this database, so as the prompt changes the comparison changes with
-- it. Before any t2 call exists the baseline is null and every figure here is
-- null — which is correct. An unmeasured saving should read as unknown, not
-- as zero and not as a guess.
DROP VIEW IF EXISTS v_llm_savings;
CREATE VIEW v_llm_savings AS
SELECT
  (SELECT COUNT(*)                    FROM num_llm_calls)                      AS messages,
  (SELECT COUNT(*)                    FROM num_llm_calls WHERE tier='t0')      AS t0_calls,
  (SELECT COUNT(*)                    FROM num_llm_calls WHERE tier='t1')      AS t1_calls,
  (SELECT COUNT(*)                    FROM num_llm_calls WHERE tier='t2')      AS t2_calls,
  (SELECT SUM(in_tokens + out_tokens) FROM num_llm_calls)                      AS tokens_spent,
  CAST(ROUND(
    (SELECT COUNT(*) FROM num_llm_calls) *
    (SELECT AVG(in_tokens + out_tokens) FROM num_llm_calls WHERE tier='t2' AND ok=1)
  ) AS INTEGER)                                                                AS tokens_if_all_t2,
  CAST(ROUND(
    (SELECT COUNT(*) FROM num_llm_calls) *
    (SELECT AVG(in_tokens + out_tokens) FROM num_llm_calls WHERE tier='t2' AND ok=1)
    - (SELECT SUM(in_tokens + out_tokens) FROM num_llm_calls)
  ) AS INTEGER)                                                                AS tokens_saved,
  (SELECT SUM(escalated)              FROM num_llm_calls)                      AS escalations,
  (SELECT SUM(estimated)              FROM num_llm_calls)                      AS rows_estimated,
  (SELECT MIN(created_at)             FROM num_llm_calls)                      AS since,
  (SELECT MAX(created_at)             FROM num_llm_calls)                      AS until;

-- Which intents dominate. This is the list that tells us where to aim next:
-- a `kind` with heavy t2 volume and a narrow answer shape is the next
-- candidate for a template or a cheaper prompt.
DROP VIEW IF EXISTS v_llm_kinds;
CREATE VIEW v_llm_kinds AS
SELECT
  COALESCE(kind, '(none)')                   AS kind,
  tier,
  COUNT(*)                                   AS calls,
  SUM(in_tokens + out_tokens)                AS tokens,
  CAST(ROUND(AVG(in_tokens + out_tokens)) AS INTEGER) AS avg_tokens,
  SUM(escalated)                             AS escalated
FROM num_llm_calls
GROUP BY COALESCE(kind, '(none)'), tier
ORDER BY tokens DESC;
