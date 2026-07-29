-- NUM 0007 — 5arz human verification (Sprint 1)
--
-- Pairs with apps/api/services/sarz_verify.py. Records, per user, the outcome
-- of a 5arz Proof-of-Human-Fulfillment (PoHF) verification: which tier they
-- reached and the portable credential id. We store only credential ids + a
-- tier -- never raw identity PII (PDPA). The PoHF itself is verifiable at
-- 5arz's public JWKS and can be re-checked without storing anything sensitive.
--
-- Additive + reversible: new nullable columns only. Existing rows default to
-- 'unverified' and NUM behaves exactly as before until SARZ_VERIFY_ENABLED=true.

alter table users add column if not exists human_tier        text not null default 'unverified';
alter table users add column if not exists pohf_jti           text;
alter table users add column if not exists unique_human_jti   text;
alter table users add column if not exists human_verified_at  timestamptz;
alter table users add column if not exists human_verify_ref   text;

-- Fast "is this user verified?" gating on the hot path.
create index if not exists idx_users_human_tier on users (human_tier);

comment on column users.human_tier is
  '5arz verification tier: unverified | pending | proof_of_human | identity';
comment on column users.pohf_jti is
  '5arz Proof-of-Human-Fulfillment credential id (portable, JWKS-verifiable). No PII.';
comment on column users.unique_human_jti is
  '5arz Unique-Human anti-Sybil attestation id. No PII.';
