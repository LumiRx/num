-- 0039 — two things a guest and a venue each need, and neither of which NUM
-- may hold carelessly: a member's own crypto wallet, and a venue's POS tokens.
--
-- num_member_wallets
--   A Privy embedded wallet, pregenerated against the member's verified phone
--   number. Privy holds the key material in a TEE and splits it, and NUM stores
--   only the public address and the Privy ids. There is deliberately NO
--   balance column: a balance in two places is a balance that disagrees, and
--   the chain is the truth. And there is no link of any kind to
--   num_star_balances — Stars and this wallet are different assets and the
--   moment they are added together NUM is running an exchange.
--
-- num_business_pos
--   A venue's point-of-sale connection. The access token here can create
--   payments on that merchant's own account, so it is stored ENCRYPTED
--   (AES-GCM under POS_TOKEN_KEY, see growth/pos/index.mjs) rather than in
--   the clear. A D1 export with plaintext merchant tokens in it would be a
--   breach of every venue at once.
--
-- The paylink columns let a bill code remember which POS check it came from,
-- so settling the bill can close the check in the venue's own till.

CREATE TABLE IF NOT EXISTS num_member_wallets (
  member_id      TEXT PRIMARY KEY,
  privy_user_id  TEXT,
  privy_wallet_id TEXT,
  address        TEXT NOT NULL,
  chain          TEXT NOT NULL DEFAULT 'base',
  chain_type     TEXT NOT NULL DEFAULT 'ethereum',
  state          TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','retired')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_member_wallets_addr ON num_member_wallets(address);

CREATE TABLE IF NOT EXISTS num_business_pos (
  business_id    TEXT PRIMARY KEY,
  vendor         TEXT NOT NULL,
  merchant_id    TEXT,
  location_id    TEXT,
  token_enc      TEXT,
  refresh_enc    TEXT,
  expires_at     TEXT,
  state          TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked','needs_reauth')),
  last_error     TEXT,
  connected_at   TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE num_paylinks ADD COLUMN pos_vendor TEXT;
ALTER TABLE num_paylinks ADD COLUMN pos_order_id TEXT;
ALTER TABLE num_paylinks ADD COLUMN pos_closed_at TEXT;
