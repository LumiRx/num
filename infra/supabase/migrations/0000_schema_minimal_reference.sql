-- NUM — Minimal v0 schema (Path A: get something live in an afternoon)
-- For Path B (pilot-ready), use schema_full.sql instead.

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- 1. Users -----------------------------------------------------------
create table if not exists users (
    id                  uuid primary key default gen_random_uuid(),
    phone_number        varchar(32) unique not null,
    platform            varchar(20),               -- 'whatsapp' | 'sms' | 'line' | 'wechat'
    acquisition_source  varchar(64),               -- e.g. 'CAR12'
    preferred_lang      varchar(8) default 'en',
    created_at          timestamptz default now()
);

-- 2. High-ticket leads (whale leads) --------------------------------
create table if not exists high_ticket_leads (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references users(id) on delete cascade,
    category        varchar(50),                    -- 'real_estate' | 'school' | 'relocation' | 'visa' | 'medical' | 'legal'
    status          varchar(50) default 'intake_in_progress',
    budget_or_value varchar(100),
    timeline        varchar(100),
    collected_data  jsonb default '{}',             -- drip-feed answers
    viability_score varchar(20),                    -- 'A' | 'B' | 'C' | 'rejected'
    created_at      timestamptz default now()
);

-- 3. Partners (merchants / drivers) ---------------------------------
create table if not exists partners (
    id              uuid primary key default gen_random_uuid(),
    phone_number    varchar(32) unique not null,
    role            varchar(20),                    -- 'owner' | 'worker' | 'driver' | 'merchant'
    business_name   varchar(100),
    status          varchar(20) default 'active',
    created_at      timestamptz default now()
);

-- 4. Messages (audit trail — minimum viable) ------------------------
create table if not exists messages (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references users(id) on delete cascade,
    role            varchar(16) not null,           -- 'user' | 'assistant' | 'tool' | 'system'
    content         text not null,
    created_at      timestamptz default now()
);

-- 5. Events (analytics — minimum viable) ----------------------------
create table if not exists events (
    id              bigserial primary key,
    user_id         uuid references users(id),
    name            varchar(64),                    -- 'qr_scan' | 'first_message' | 'lead_created'
    payload         jsonb,
    created_at      timestamptz default now()
);

create index if not exists idx_users_phone on users(phone_number);
create index if not exists idx_messages_user on messages(user_id, created_at desc);
create index if not exists idx_leads_user on high_ticket_leads(user_id);
create index if not exists idx_events_user_name on events(user_id, name);
