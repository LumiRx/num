-- OAuth 2.1 for the NUM MCP server (RFC 7591 / 8414 / 8707 / 9728).
-- Additive only. Existing numa_live_ agent keys keep working unchanged.

CREATE TABLE IF NOT EXISTS num_oauth_clients (
  client_id                  TEXT PRIMARY KEY,
  client_secret_sha256       TEXT,
  client_name                TEXT,
  redirect_uris              TEXT NOT NULL,
  grant_types                TEXT NOT NULL,
  response_types             TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL,
  scope                      TEXT,
  client_uri                 TEXT,
  software_id                TEXT,
  software_version           TEXT,
  created_at                 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS num_oauth_codes (
  code_sha256           TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  account_id            TEXT NOT NULL,
  agent_id              TEXT,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  resource              TEXT,
  scope                 TEXT,
  expires_at            TEXT NOT NULL,
  used                  INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS num_oauth_tokens (
  token_sha256   TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  agent_id       TEXT,
  audience       TEXT NOT NULL,
  scope          TEXT,
  expires_at     TEXT NOT NULL,
  revoked        INTEGER NOT NULL DEFAULT 0,
  parent_sha256  TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_account ON num_oauth_tokens (account_id, kind, revoked);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expiry  ON num_oauth_tokens (expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expiry   ON num_oauth_codes (expires_at);
