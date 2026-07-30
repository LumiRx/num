-- NUM 0009 — inbound media capture + vehicle reservations
--
-- Two things this enables:
--   1. Photos sent in chat are re-hosted and recorded (car condition records,
--      menus, receipts). Provider URLs expire; ours don't.
--   2. NUM takes vehicle RESERVATIONS. The partner still holds the rental
--      agreement, the insurance and the paperwork — we are the booking system,
--      the same way OpenTable takes a table booking without cooking the food.
--      See docs/AGENCY_PARTNER_SPEC.md §3.

-- ════════════════════════════════════════════════════════════════════════
-- 1 · Media assets
-- ════════════════════════════════════════════════════════════════════════
-- Bytes live in Supabase Storage (bucket 'chat-media'); this table is the
-- index. `storage_key` is server-generated from a UUID — never a user-supplied
-- filename. Content type is validated against the actual magic bytes before a
-- row is written (services/media.py).
create table if not exists media_assets (
    id              uuid primary key default gen_random_uuid(),
    user_uuid       uuid references users(user_uuid) on delete cascade,
    message_id      uuid references messages(id) on delete set null,
    conversation_id uuid references conversations(id) on delete set null,

    storage_key     text not null unique,       -- '<user_uuid>/<uuid>.jpg'
    content_type    text not null,
    size_bytes      int,

    -- What the photo is for. Tagged at capture so the record is searchable
    -- later without re-reading images.
    purpose         text not null default 'chat',
        -- 'chat' | 'vehicle_record' | 'listing' | 'receipt'
    provider_sid    text,                        -- Twilio MediaSid, for dedupe

    created_at      timestamptz not null default now(),

    constraint media_assets_purpose_chk check (
        purpose in ('chat','vehicle_record','listing','receipt')
    )
);

create index if not exists idx_media_user    on media_assets (user_uuid, created_at desc);
create index if not exists idx_media_message on media_assets (message_id);
create index if not exists idx_media_purpose on media_assets (purpose, created_at desc);

alter table media_assets enable row level security;

comment on table media_assets is
  'Index of media re-hosted from chat. Bytes in Storage bucket chat-media. storage_key is UUID-generated, never user-supplied; content type is magic-byte validated before insert.';

-- ════════════════════════════════════════════════════════════════════════
-- 2 · Vehicle photos — the condition record
-- ════════════════════════════════════════════════════════════════════════
-- 'condition' photos are the ones that matter in a dispute: timestamped at
-- capture, never updated. Deliberately no updated_at — this is a log.
create table if not exists vehicle_photos (
    id              uuid primary key default gen_random_uuid(),
    vehicle_id      uuid not null references vehicles(id) on delete cascade,
    media_asset_id  uuid not null references media_assets(id) on delete cascade,
    kind            text not null default 'condition',
        -- 'listing'   — marketing photos shown to travelers
        -- 'condition' — handover / return documentation
        -- 'damage'    — incident evidence
    taken_at        timestamptz not null default now(),
    notes           text,

    constraint vehicle_photos_kind_chk check (kind in ('listing','condition','damage')),
    constraint vehicle_photos_unique unique (vehicle_id, media_asset_id)
);

create index if not exists idx_vehicle_photos on vehicle_photos (vehicle_id, kind, taken_at desc);

alter table vehicle_photos enable row level security;

comment on table vehicle_photos is
  'Links stored media to a vehicle. kind=condition is the handover/return record — append-only by design, since its value is being contemporaneous.';

-- ════════════════════════════════════════════════════════════════════════
-- 3 · Vehicle reservations
-- ════════════════════════════════════════════════════════════════════════
-- NUM records the reservation; the PARTNER confirms it, papers it, insures it,
-- and takes the money. We never hold the agreement and never take payment —
-- payment_handled_by exists to make that explicit in the data, not just in a
-- contract nobody re-reads.
create table if not exists vehicle_reservations (
    id                  uuid primary key default gen_random_uuid(),
    vehicle_id          uuid not null references vehicles(id) on delete cascade,
    user_uuid           uuid references users(user_uuid) on delete set null,
    conversation_id     uuid references conversations(id) on delete set null,
    partner_tenant_id   uuid references partner_tenants(id) on delete set null,

    starts_on           date not null,
    ends_on             date not null,
    pickup_note         text,

    status              text not null default 'requested',
        -- requested → confirmed | declined | cancelled | completed
        -- Only the PARTNER moves it past 'requested'.
    quoted_total        numeric,
    currency            text default 'GBP',
    commission_amount   numeric,

    -- Explicit boundary markers.
    payment_handled_by  text not null default 'partner',
    agreement_holder    text,                    -- who holds the rental contract

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),

    constraint vehicle_res_status_chk check (
        status in ('requested','confirmed','declined','cancelled','completed')
    ),
    constraint vehicle_res_dates_chk check (ends_on >= starts_on),
    -- NUM must never be recorded as taking the money.
    constraint vehicle_res_payment_chk check (payment_handled_by <> 'num')
);

create index if not exists idx_vehicle_res_vehicle on vehicle_reservations (vehicle_id, starts_on);
create index if not exists idx_vehicle_res_tenant  on vehicle_reservations (partner_tenant_id, status, created_at desc);

alter table vehicle_reservations enable row level security;

comment on table vehicle_reservations is
  'Reservation records only. NUM is the booking system; the partner holds the rental agreement, insurance and payment. The payment_handled_by check makes that structural.';

-- ── 3b · keep updated_at honest ────────────────────────────────────────────
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists trg_vehicle_res_touch on vehicle_reservations;
create trigger trg_vehicle_res_touch
    before update on vehicle_reservations
    for each row execute function touch_updated_at();

-- ── 3c · double-booking guard ──────────────────────────────────────────────
-- A vehicle can't be confirmed for two overlapping periods. Cheaper to catch
-- here than in an angry phone call.
create or replace function prevent_vehicle_double_booking()
returns trigger language plpgsql as $$
begin
    if new.status = 'confirmed' and exists (
        select 1 from vehicle_reservations r
        where r.vehicle_id = new.vehicle_id
          and r.id <> new.id
          and r.status = 'confirmed'
          and r.starts_on <= new.ends_on
          and r.ends_on   >= new.starts_on
    ) then
        raise exception
            'Vehicle % already has a confirmed reservation overlapping % to %',
            new.vehicle_id, new.starts_on, new.ends_on
            using errcode = 'check_violation';
    end if;
    return new;
end;
$$;

drop trigger if exists trg_vehicle_no_double_book on vehicle_reservations;
create trigger trg_vehicle_no_double_book
    before insert or update on vehicle_reservations
    for each row execute function prevent_vehicle_double_booking();

-- ════════════════════════════════════════════════════════════════════════
-- 4 · Views
-- ════════════════════════════════════════════════════════════════════════

-- Condition record for a vehicle — what you pull up in a damage dispute.
create or replace view v_vehicle_condition_record
with (security_invoker = true) as
select
    vp.vehicle_id,
    v.make, v.model,
    vp.kind,
    vp.taken_at,
    ma.storage_key,
    ma.content_type,
    ma.size_bytes,
    vp.notes
from vehicle_photos vp
join media_assets ma on ma.id = vp.media_asset_id
join vehicles v      on v.id  = vp.vehicle_id
where vp.kind in ('condition','damage')
order by vp.vehicle_id, vp.taken_at desc;

-- Partner's reservation queue — what they act on.
create or replace view v_vehicle_reservation_queue
with (security_invoker = true) as
select
    r.id, r.partner_tenant_id, r.status,
    v.make, v.model, v.pickup_area,
    r.starts_on, r.ends_on,
    (r.ends_on - r.starts_on + 1) as days,
    r.quoted_total, r.currency,
    r.created_at
from vehicle_reservations r
join vehicles v on v.id = r.vehicle_id
where r.status in ('requested','confirmed')
order by r.status desc, r.starts_on;
