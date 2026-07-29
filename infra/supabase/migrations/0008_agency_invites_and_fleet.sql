-- NUM 0008 — agency client invites + vehicle fleet
--
-- Two partner-driven features, both designed around the same hard rule:
-- consent is captured FIRST-PARTY from the end user, never inherited from a
-- partner's existing relationship. See docs/AGENCY_PARTNER_SPEC.md §1.
--
-- ── Invites ────────────────────────────────────────────────────────────────
-- A partner (e.g. a VIP agency) loads their client roster and NUM mints one
-- signed, single-use link per client. The PARTNER delivers it through their
-- own channel. The client opts in themselves; only then does a `users` row
-- and a `consent_events` record exist. We never message an invitee — an
-- invite is a link, not an outbound send. This is what keeps the WhatsApp
-- sender alive and the ICO uninterested.
--
-- ── Vehicles ───────────────────────────────────────────────────────────────
-- NUM is a DISCOVERY + REFERRAL layer for rentals, never the rental
-- principal — no payment, no rental agreement, no liability. A vehicle
-- cannot go live without recorded confirmation it is insured for hire use.
-- VIN is treated as personal data: encrypted at rest, never returned to a
-- traveler, never allowed into an AI reply.

-- ════════════════════════════════════════════════════════════════════════
-- 1 · Client invites
-- ════════════════════════════════════════════════════════════════════════
create table if not exists client_invites (
    id                  uuid primary key default gen_random_uuid(),
    partner_tenant_id   uuid not null references partner_tenants(id) on delete cascade,

    -- The partner's own reference for this client. Deliberately NOT a required
    -- phone/email: the partner delivers the invite themselves, so we don't
    -- need (or want) contact details we have no consent to use.
    client_ref          text not null,
    segment             text,                       -- 'vip' | 'standard' | partner-defined
    notes               text,                       -- preferences NUM should know on day one

    -- Optional, and only legitimate if the partner already holds valid consent
    -- to contact on it. Never used by NUM to send anything.
    contact_hint        text,

    -- The link. Single-use, expiring, revocable.
    token               text not null unique,
    status              text not null default 'created',
        -- created → sent → opened → activated | expired | revoked
    expires_at          timestamptz not null default (now() + interval '30 days'),

    -- Set only when the invitee opts in themselves.
    activated_user_uuid uuid references users(user_uuid) on delete set null,
    activated_at        timestamptz,

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),

    constraint client_invites_status_chk check (
        status in ('created','sent','opened','activated','expired','revoked')
    )
);

create index if not exists idx_client_invites_tenant  on client_invites (partner_tenant_id, status);
create index if not exists idx_client_invites_token   on client_invites (token);
create index if not exists idx_client_invites_expiry  on client_invites (expires_at) where status not in ('activated','revoked');

alter table client_invites enable row level security;

comment on table client_invites is
  'Partner-delivered client invites. NUM mints the link; the PARTNER sends it; the client opts in. NUM never messages an invitee directly — consent is captured first-party on activation.';

-- ════════════════════════════════════════════════════════════════════════
-- 2 · Vehicles (rental discovery)
-- ════════════════════════════════════════════════════════════════════════
create table if not exists vehicles (
    id                  uuid primary key default gen_random_uuid(),
    partner_tenant_id   uuid not null references partner_tenants(id) on delete cascade,
    vendor_id           uuid references vendors(id) on delete set null,  -- the agency/owner as a catalogue entry

    -- Public, matchable
    make                text not null,
    model               text not null,
    year                int,
    body_type           text,                       -- 'saloon' | 'suv' | 'van' | 'convertible' ...
    transmission        text,                       -- 'automatic' | 'manual'
    seats               int,
    mileage             int,                        -- condition signal, shown to travelers
    daily_rate          numeric,
    currency            text default 'GBP',
    pickup_area         text,                       -- AREA not precise address (e.g. 'Edinburgh city centre')
    geo                 geography(point),           -- optional, for distance matching
    photos              jsonb default '[]',         -- array of URLs, 3-5 real photos
    metadata            jsonb default '{}',

    -- Availability
    available_from      date,
    available_to        date,
    status              text not null default 'pending',
        -- pending → approved (live to AI) | rejected | paused
    constraint vehicles_status_chk check (status in ('pending','approved','rejected','paused')),

    -- ⚠ COMPLIANCE GATE — a vehicle may not be approved without these.
    -- Enforced by trigger below, not just convention.
    insured_for_hire        boolean not null default false,
    insurance_confirmed_by  text,                   -- who at the partner confirmed it
    insurance_confirmed_at  timestamptz,
    rental_agreement_holder text,                   -- who holds the contract (never NUM)

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_vehicles_tenant_status on vehicles (partner_tenant_id, status);
create index if not exists idx_vehicles_available     on vehicles (status, available_from, available_to)
    where status = 'approved';

alter table vehicles enable row level security;

comment on table vehicles is
  'Rental vehicles surfaced by NUM as DISCOVERY ONLY. NUM refers travelers to the rental principal; it never takes payment, holds the agreement, or carries liability. A row cannot reach status=approved without insured_for_hire = true.';

-- ── 2b · VIN, held separately and encrypted ────────────────────────────────
-- VIN links to registration and ownership records, so it is personal data
-- under UK GDPR. It lives apart from the public vehicle row so that no query
-- against `vehicles` can accidentally leak it into an API response or an AI
-- reply. Used for verification and dispute resolution only.
create table if not exists vehicle_identifiers (
    vehicle_id          uuid primary key references vehicles(id) on delete cascade,
    vin_encrypted       text not null,              -- envelope-encrypted, same pattern as user_profile_secure
    registration_plate_encrypted text,
    kms_key_id          text,
    created_at          timestamptz not null default now()
);

alter table vehicle_identifiers enable row level security;

comment on table vehicle_identifiers is
  'Encrypted vehicle identifiers (VIN, plate). NEVER exposed to travelers or included in an AI reply — verification and dispute resolution only.';

-- ── 2c · Enforce the insurance gate in the database ────────────────────────
-- Policy in a document is a suggestion; policy in a constraint is a rule.
create or replace function enforce_vehicle_insurance_gate()
returns trigger
language plpgsql
as $$
begin
    if new.status = 'approved' and coalesce(new.insured_for_hire, false) = false then
        raise exception
            'Vehicle % cannot be approved: insured_for_hire is false. A vehicle may not be listed for rental discovery without recorded confirmation of hire insurance.',
            new.id
            using errcode = 'check_violation';
    end if;
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists trg_vehicle_insurance_gate on vehicles;
create trigger trg_vehicle_insurance_gate
    before insert or update on vehicles
    for each row execute function enforce_vehicle_insurance_gate();

-- ════════════════════════════════════════════════════════════════════════
-- 3 · Referral tracking for vehicle handoffs
-- ════════════════════════════════════════════════════════════════════════
-- NUM introduces, the partner closes. This records the introduction so
-- commission is provable by both sides (5arz PayRails ledger).
create table if not exists vehicle_referrals (
    id                  uuid primary key default gen_random_uuid(),
    vehicle_id          uuid not null references vehicles(id) on delete cascade,
    user_uuid           uuid references users(user_uuid) on delete set null,
    conversation_id     uuid references conversations(id) on delete set null,
    partner_tenant_id   uuid references partner_tenants(id) on delete set null,
    status              text not null default 'introduced',
        -- introduced → contacted → booked | lost
    estimated_value     numeric,
    commission_amount   numeric,
    notes               text,
    created_at          timestamptz not null default now(),
    constraint vehicle_referrals_status_chk check (status in ('introduced','contacted','booked','lost'))
);

create index if not exists idx_vehicle_referrals_tenant on vehicle_referrals (partner_tenant_id, status, created_at desc);

alter table vehicle_referrals enable row level security;

-- ════════════════════════════════════════════════════════════════════════
-- 4 · Views
-- ════════════════════════════════════════════════════════════════════════

-- What the AI is allowed to see. Note the absence of any identifier column —
-- search_vendors-style lookups read THIS, never `vehicles` directly.
create or replace view v_vehicles_available
with (security_invoker = true) as
select
    v.id, v.partner_tenant_id, v.make, v.model, v.year, v.body_type,
    v.transmission, v.seats, v.mileage, v.daily_rate, v.currency,
    v.pickup_area, v.photos, v.available_from, v.available_to
from vehicles v
where v.status = 'approved'
  and v.insured_for_hire = true
  and (v.available_to is null or v.available_to >= current_date);

-- The agency's client-management view: activation funnel per tenant.
create or replace view v_agency_client_activation
with (security_invoker = true) as
select
    partner_tenant_id,
    count(*)                                                        as invites_total,
    count(*) filter (where status = 'created')                      as not_yet_sent,
    count(*) filter (where status = 'sent')                         as sent,
    count(*) filter (where status = 'opened')                       as opened,
    count(*) filter (where status = 'activated')                    as activated,
    count(*) filter (where status in ('expired','revoked'))         as closed,
    round(100.0 * count(*) filter (where status = 'activated')
          / nullif(count(*) filter (where status <> 'created'), 0), 1) as activation_rate_pct
from client_invites
group by partner_tenant_id;
