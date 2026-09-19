-- 0051 — ambassadors.
--
-- WHAT THIS IS NOT. It is not a new economics. The money was decided on
-- 13 Sep 2026 and built in worker/memberreferral.mjs: 20% of the commission
-- NUM actually collected, for life, with the member to referrer edge held as a
-- column on num_members. That file's own header reasons about "an influencer
-- with 500 good referrals". The engine is finished and paid.
--
-- What was missing is a DOOR. An ambassador today is indistinguishable from a
-- member who happens to hold a referral code: no account, no console, nowhere
-- to say who they are or what they reach, and no way for a business to find
-- them. That is what these four tables add, and nothing else.
--
-- THE CODE IS THE JOIN. num_referral_codes already permits owner_type
-- 'ambassador' and has since it was written. An ambassador's code IS a
-- referral code, so /r/CODE, the signup attribution, the star ledger and
-- referralSummary() all work the moment a row exists. No parallel system.
--
-- ══ WHY THIS DROPS A TABLE, WHICH MIGRATIONS HERE OTHERWISE NEVER DO ═════
--
-- A `num_ambassadors` table already existed in production when this was
-- written, created by the university programme and never once used. Measured
-- on 19 Sep 2026, before this ran:
--
--     num_universities                                0 rows
--     num_ambassadors                                 0 rows
--     num_referral_codes WHERE owner_type='ambassador' 0 rows
--     num_referral_codes WHERE university_id NOT NULL  0 rows
--
-- It had one writer, `claim/worker.js`, and that writer disagreed with this
-- one about what an ambassador code MEANS: it set the code's `owner_id` to
-- the MEMBER's ref and then wrote the ambassador row under a different id of
-- its own. So `linkReferral`, which resolves an ambassador code by looking up
-- `num_ambassadors.id = owner_id`, would never have found it — the university
-- programme would have minted codes that could not pay. Two writers, one
-- table, two meanings.
--
-- `CREATE TABLE IF NOT EXISTS` against that table is a silent no-op, which is
-- exactly how a schema quietly ends up being two different things. So this
-- rebuilds it, once, while it is empty, and `claim/worker.js` was changed in
-- the same commit to agree: for owner_type 'ambassador', `owner_id` IS the
-- num_ambassadors id, always, everywhere.
--
-- The university columns are KEPT. That programme is not being deleted, it is
-- being folded into one table with one meaning, which is what it should have
-- been. If it ever ships, its ambassadors are these ambassadors.
--
-- Nothing is lost by the drop because there was nothing in it. If you are
-- reading this because it failed, check the counts above first: if any of
-- them is no longer zero, DO NOT run this — write an ALTER instead.

DROP TABLE IF EXISTS num_ambassadors;

CREATE TABLE IF NOT EXISTS num_ambassadors (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  -- Nullable at the schema, required at /api/amb/join. A student ambassador
  -- signed up by a university may genuinely not have given one. The endpoint
  -- a person applies through refuses without it, and says why, which is a
  -- better place to enforce it than a constraint that returns a 500.
  email         TEXT,
  phone         TEXT,
  country       TEXT,
  city          TEXT,
  -- Their referral code. The seam to everything that already works.
  code          TEXT NOT NULL UNIQUE REFERENCES num_referral_codes(code),
  -- If they are also a NUM member, this is the edge referralSummary() reads.
  -- Nullable: somebody can be accepted as an ambassador before they install.
  member_id     TEXT,
  -- From the university programme, kept so that it is one table rather than
  -- two. Null for everybody who is not a student ambassador, which is
  -- everybody today.
  university_id TEXT,
  -- One line they write about themselves, shown in the directory.
  bio           TEXT,
  status        TEXT NOT NULL DEFAULT 'applied'
                CHECK (status IN ('applied','active','paused','ended')),
  -- OPT IN, DEFAULT OFF. Being listed means a business can see their name,
  -- their city and the reach they claim. Nobody is put in a shop window
  -- because a field was left blank.
  listed        INTEGER NOT NULL DEFAULT 0 CHECK (listed IN (0,1)),
  -- Same credential model as hosts and Experts: the link is the key, there is
  -- no password. Documented so nobody "improves" it into a login later
  -- without deciding to.
  console_key   TEXT,
  terms_version TEXT,
  agreed_at     TEXT,
  agreed_ip     TEXT,
  applied_note  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  ended_at      TEXT,
  ended_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_amb_status ON num_ambassadors(status, listed);
CREATE INDEX IF NOT EXISTS idx_amb_member ON num_ambassadors(member_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_amb_key ON num_ambassadors(console_key);

-- ══ WHAT THEY REACH ═════════════════════════════════════════════════════
-- Dre's call, 19 Sep 2026: self-declared, clearly labelled, until a platform
-- connection can verify it.
--
-- THE TWO NUMBERS ARE SEPARATE COLUMNS AND THAT IS THE WHOLE POINT. A figure
-- somebody typed and a figure a platform confirmed are different facts, and a
-- page that shows a brand one while implying the other is lying on somebody
-- else's behalf. `followers_claimed` is what they said. `followers_verified`
-- is null until an OAuth connection fills it, and every surface that renders
-- a claimed figure must say so in words.
CREATE TABLE IF NOT EXISTS num_ambassador_socials (
  id             TEXT PRIMARY KEY,
  ambassador_id  TEXT NOT NULL,
  platform       TEXT NOT NULL
                 CHECK (platform IN ('instagram','tiktok','youtube','x','facebook','twitch','blog','other')),
  handle         TEXT NOT NULL,
  url            TEXT,
  followers_claimed  INTEGER,
  claimed_at         TEXT,
  followers_verified INTEGER,
  verified_at        TEXT,
  -- How it was verified, when it ever is. 'oauth' is the only one that should
  -- ever set followers_verified without a human.
  verified_by    TEXT CHECK (verified_by IN ('oauth','human','post_code')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_amb_soc ON num_ambassador_socials(ambassador_id, platform);
CREATE UNIQUE INDEX IF NOT EXISTS idx_amb_soc_handle
  ON num_ambassador_socials(ambassador_id, platform, handle);

-- ══ WHAT IS ON OFFER ════════════════════════════════════════════════════
-- Posted by NUM today. `posted_by_kind` is the hinge that lets a business post
-- one later without a second table and without rewriting anything that reads
-- this one.
CREATE TABLE IF NOT EXISTS num_ambassador_offers (
  id             TEXT PRIMARY KEY,
  posted_by_kind TEXT NOT NULL DEFAULT 'num'
                 CHECK (posted_by_kind IN ('num','business','host')),
  posted_by_id   TEXT,
  title          TEXT NOT NULL,
  -- What the ambassador gets, in words, and what is asked of them in return.
  -- Deliberately prose rather than a structured contract: the first fifty of
  -- these will each be different and a schema guessed now would be wrong.
  they_get       TEXT NOT NULL,
  we_ask         TEXT NOT NULL,
  city           TEXT,
  country        TEXT,
  -- How many can claim it. NULL means no cap.
  slots          INTEGER,
  starts_at      TEXT,
  ends_at        TEXT,
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','open','paused','closed')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_amb_offers ON num_ambassador_offers(status, ends_at);

-- ══ WHO TOOK IT, AND WHAT THEY POSTED ═══════════════════════════════════
-- The state machine is short on purpose: claimed → posted → done, or
-- withdrawn at any point. Anything longer invents an approval process nobody
-- has agreed to run.
CREATE TABLE IF NOT EXISTS num_ambassador_claims (
  id             TEXT PRIMARY KEY,
  offer_id       TEXT NOT NULL,
  ambassador_id  TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'claimed'
                 CHECK (state IN ('claimed','posted','done','withdrawn')),
  -- Where the content went. The evidence the offer was honoured.
  post_url       TEXT,
  posted_at      TEXT,
  note           TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT,
  -- Posted means there is something to look at. Without this the state is a
  -- claim about a claim.
  CHECK (state <> 'posted' OR post_url IS NOT NULL)
);
-- One claim per ambassador per offer. Claiming twice is a double booking.
CREATE UNIQUE INDEX IF NOT EXISTS idx_amb_claim_pair
  ON num_ambassador_claims(offer_id, ambassador_id);
CREATE INDEX IF NOT EXISTS idx_amb_claim_amb
  ON num_ambassador_claims(ambassador_id, state);
