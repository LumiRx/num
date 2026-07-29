-- NUM 0009 — settlement ledger + lead fees (Sprint 3)
--
-- Closes FULL_FLOW gaps D5 (close + fee) and E3 (settlement ledger). Every
-- commission or lead fee is recorded here and bound to a 5arz Agent-Tx-Binding
-- (verified human <-> agent <-> payment). Additive.

alter table leads add column if not exists fee_amount_cents integer;
alter table leads add column if not exists fee_pct          numeric;
alter table leads add column if not exists settled_at       timestamptz;
alter table leads add column if not exists atb_jti          text;   -- 5arz Agent-Tx-Binding credential id

create table if not exists settlements (
    id                uuid primary key default gen_random_uuid(),
    partner_tenant_id uuid,
    kind              text not null,                    -- 'booking' | 'lead'
    user_uuid         uuid,
    vendor_id         uuid,
    lead_id           uuid,
    amount_cents      integer not null default 0,
    currency          text not null default 'usd',
    method            text,                             -- 'x402' | 'stripe' | 'manual'
    status            text not null default 'pending',  -- 'pending' | 'settled' | 'failed' | 'refunded'
    atb_jti           text,                             -- 5arz human<->agent<->payment binding
    payment_ref       text,
    created_at        timestamptz default now(),
    settled_at        timestamptz
);
create index if not exists idx_settlements_status on settlements (status);

-- Service-role only (matches 0004 RLS posture).
alter table settlements enable row level security;

comment on table settlements is 'Every commission / lead fee, bound to a 5arz Agent-Tx-Binding (verified human + agent + payment). Closes D5/E3.';
