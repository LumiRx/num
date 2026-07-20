-- NUM — Full pilot-ready schema (Path B)
-- Mirrors /01_MASTER_ARCHITECTURE.md §6. Use this for the partner pilot.

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;
create extension if not exists vector;
create extension if not exists postgis;

-- ====================================================================
-- 1. Multi-tenant licensing
-- ====================================================================
create table partner_tenants (
    id              uuid primary key default gen_random_uuid(),
    name            text not null,                   -- e.g. 'Phuket InCar Group'
    region          text,
    tier            text default 'pilot',            -- 'pilot' | 'pro' | 'enterprise'
    rev_share_pct   numeric default 0.50,
    exclusivity     boolean default false,
    created_at      timestamptz default now()
);

-- ====================================================================
-- 2. Users & cross-channel identity
-- ====================================================================
create table users (
    user_uuid           uuid primary key default gen_random_uuid(),
    partner_tenant_id   uuid references partner_tenants(id),
    preferred_lang      text default 'en',
    lifecycle_stage     text default 'new',          -- 'new'|'tourist'|'nomad'|'relocating'|'customer'|'dormant'
    acquisition_source  text,                         -- e.g. 'car_PHK_017'
    created_at          timestamptz default now()
);

create table channel_identities (
    id          uuid primary key default gen_random_uuid(),
    user_uuid   uuid references users(user_uuid) on delete cascade,
    channel     text not null,                       -- 'whatsapp'|'sms'|'line'|'wechat'|'web'
    handle      text not null,                       -- phone, line userId, wechat openid
    verified_at timestamptz,
    unique (channel, handle)
);

-- ====================================================================
-- 3. Profile (split — open vs encrypted)
-- ====================================================================
create table user_profile (
    user_uuid    uuid primary key references users(user_uuid) on delete cascade,
    profile_json jsonb not null default '{}',
    updated_at   timestamptz default now()
);

create table user_profile_secure (
    user_uuid       uuid primary key references users(user_uuid) on delete cascade,
    pii_ciphertext  bytea not null,                  -- envelope-encrypted JSON blob
    kms_key_id      text not null,
    updated_at      timestamptz default now()
);

-- ====================================================================
-- 4. Conversations & messages
-- ====================================================================
create table conversations (
    id          uuid primary key default gen_random_uuid(),
    user_uuid   uuid references users(user_uuid) on delete cascade,
    channel     text not null,
    started_at  timestamptz default now(),
    closed_at   timestamptz
);

create table messages (
    id              uuid primary key default gen_random_uuid(),
    conversation_id uuid references conversations(id) on delete cascade,
    user_uuid       uuid references users(user_uuid) on delete cascade,
    role            text not null,                   -- 'user'|'assistant'|'tool'|'system'
    content         text not null,
    tool_calls      jsonb,
    created_at      timestamptz default now()
);

-- ====================================================================
-- 5. Adaptive memory (vector)
-- ====================================================================
create table memories (
    id                uuid primary key default gen_random_uuid(),
    user_uuid         uuid references users(user_uuid) on delete cascade,
    fact              text not null,
    tags              text[] default '{}',
    confidence        numeric default 0.8,
    embedding         vector(1536),
    source_message_id uuid references messages(id),
    created_at        timestamptz default now(),
    expires_at        timestamptz
);

create index memories_embedding_idx on memories using ivfflat (embedding vector_cosine_ops);
create index memories_tags_idx on memories using gin (tags);
create index memories_user_idx on memories (user_uuid, created_at desc);

-- ====================================================================
-- 6. Whale leads (RE / school / relocation / visa / medical)
-- ====================================================================
create table leads (
    id                uuid primary key default gen_random_uuid(),
    user_uuid         uuid references users(user_uuid),
    partner_tenant_id uuid references partner_tenants(id),
    vertical          text not null,                  -- 'real_estate'|'school'|'relocation'|'visa'|'medical'|'legal'
    budget_band       text,
    timeline          text,
    notes             text,
    viability_score   text,                           -- 'A' | 'B' | 'C' | 'rejected'
    status            text default 'new',             -- 'new'|'contacted'|'qualified'|'closed_won'|'closed_lost'
    handed_off_to     text,
    created_at        timestamptz default now()
);

-- ====================================================================
-- 7. Vendors & bookings
-- ====================================================================
create table vendors (
    id                uuid primary key default gen_random_uuid(),
    partner_tenant_id uuid references partner_tenants(id),
    category          text,                           -- 'restaurant'|'hotel'|'transfer'|'tour'|'school'|'agent'
    name              text,
    geo               geography(point),
    metadata          jsonb default '{}',
    commission_pct    numeric,
    featured_tier     text                            -- null | 'local' | 'standard' | 'premium'
);

create table bookings (
    id           uuid primary key default gen_random_uuid(),
    user_uuid    uuid references users(user_uuid),
    vendor_id    uuid references vendors(id),
    amount       numeric,
    currency     text default 'THB',
    commission   numeric,
    status       text,
    created_at   timestamptz default now()
);

-- ====================================================================
-- 8. Acquisition (per-vehicle QR attribution)
-- ====================================================================
create table acquisition_sources (
    code              text primary key,               -- e.g. 'car_PHK_017'
    partner_tenant_id uuid references partner_tenants(id),
    kind              text,                           -- 'vehicle'|'hotel_qr'|'event'|'web'
    label             text,
    metadata          jsonb,
    active            boolean default true
);

-- ====================================================================
-- 9. Events / analytics
-- ====================================================================
create table events (
    id          bigserial primary key,
    user_uuid   uuid references users(user_uuid),
    name        text,                                  -- 'qr_scan','first_message','booking_made','lead_qualified'
    source      text,
    payload     jsonb,
    created_at  timestamptz default now()
);

-- ====================================================================
-- 10. Partners (drivers / merchant ops contacts)
-- ====================================================================
create table partners (
    id                uuid primary key default gen_random_uuid(),
    partner_tenant_id uuid references partner_tenants(id),
    phone_number      varchar(32) unique,
    role              text,                           -- 'owner'|'worker'|'driver'|'merchant'
    business_name     text,
    status            text default 'active',
    created_at        timestamptz default now()
);

-- ====================================================================
-- RLS (sketch — refine per tenant model)
-- ====================================================================
alter table users enable row level security;
alter table user_profile enable row level security;
alter table user_profile_secure enable row level security;
alter table memories enable row level security;
alter table leads enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;

-- The backend service role bypasses RLS. Per-partner read access (when
-- we expose the dashboard) scopes by partner_tenant_id via JWT claim.
-- Per-user self-service access scopes by user_uuid via JWT claim.
