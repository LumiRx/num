-- 0045 — who paid a bill, what was on it, and splitting it between friends.
--
-- WHY A PAYER COLUMN HAS TO EXIST AT ALL
-- Until now a bill recorded issued_by and settled_by, and BOTH are staff ids.
-- Nothing anywhere recorded which member paid, and the Stripe session carried
-- the bill token and the business id and nothing about the guest. So a member
-- could pay twenty bills through NUM and we could not show them one of them.
-- That is not a missing screen, it is a fact nobody ever wrote down.
--
-- WHY SPLITTING MINTS REAL CODES RATHER THAN TRACKING SHARES
-- NUM never holds or moves money between people. The only way four friends can
-- each pay their part is for each part to be its own charge on the venue's own
-- Stripe account. So a split mints one real bill code per person, each paid
-- directly to the venue, and the parent is closed to direct payment so the
-- same dinner cannot be paid twice.
--
-- Everything here is additive. Existing rows keep working with NULLs, and the
-- code that reads these columns does so behind a defined fallback, so this can
-- run before or after the deploy without a broken pay page in between.

-- Which member paid. NULL means a walk-in, a browser, or a bill settled by
-- staff — all still true bills, just not anybody's history.
ALTER TABLE num_paylinks ADD COLUMN paid_by_member TEXT;
-- A share of a bigger bill. Carries the parent's token.
ALTER TABLE num_paylinks ADD COLUMN split_parent TEXT;
-- The member this share was sent to. They are not the only person who may pay
-- it, because a code is a code, but it is who it was meant for.
ALTER TABLE num_paylinks ADD COLUMN split_for_member TEXT;
-- Set on the PARENT when it is split. A split parent is never paid directly.
ALTER TABLE num_paylinks ADD COLUMN split_at TEXT;

CREATE INDEX IF NOT EXISTS idx_paylinks_payer ON num_paylinks(paid_by_member, settled_at);
CREATE INDEX IF NOT EXISTS idx_paylinks_split ON num_paylinks(split_parent);

-- What was actually on the bill. Optional: a venue that types a total still
-- types a total, and a bill with no rows here is exactly the bill we had
-- yesterday. line_minor is stored rather than computed so a later change to a
-- product's price cannot rewrite what a guest was charged last Tuesday.
CREATE TABLE IF NOT EXISTS num_bill_items (
  id          TEXT PRIMARY KEY,
  token       TEXT NOT NULL,
  pos         INTEGER NOT NULL DEFAULT 0,
  name        TEXT NOT NULL,
  qty         INTEGER NOT NULL DEFAULT 1,
  unit_minor  INTEGER NOT NULL,
  line_minor  INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bill_items_token ON num_bill_items(token, pos);

-- The venue's own list of things it sells, so staff tap instead of retype.
-- Archived rather than deleted: a product that priced a bill last month must
-- still be readable when somebody asks what that bill was.
CREATE TABLE IF NOT EXISTS num_business_products (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  price_minor INTEGER NOT NULL,
  currency    TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_biz_products ON num_business_products(business_id, archived_at, sort);
