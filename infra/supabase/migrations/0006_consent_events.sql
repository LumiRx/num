-- NUM 0006 — PDPA consent audit trail
--
-- Pairs with apps/api/services/privacy.py. Records every consent lifecycle
-- event: 'notice_shown' (first-contact disclosure), 'withdrawn' + 'deleted'
-- (right-to-erasure flow). Versioned so we can prove which disclosure text a
-- user saw.
--
-- DELIBERATELY NO FOREIGN KEY on user_uuid: the audit trail must survive the
-- deletion of the user row it describes. After erasure the bare UUID links to
-- nothing and is not personal data.
--
-- RLS enabled, no policies: only the service-role backend reads/writes.

create table if not exists consent_events (
    id          uuid primary key default gen_random_uuid(),
    user_uuid   uuid,                 -- intentionally not a FK (see header)
    action      text not null,        -- 'notice_shown' | 'withdrawn' | 'deleted'
    channel     text,                 -- 'whatsapp' | 'sms' | 'line' | 'wechat'
    lang        text,                 -- language the notice was shown in
    version     text,                 -- consent copy version, e.g. '2026-07-17.v1'
    created_at  timestamptz not null default now()
);

create index if not exists idx_consent_events_user on consent_events (user_uuid, created_at desc);

alter table consent_events enable row level security;
