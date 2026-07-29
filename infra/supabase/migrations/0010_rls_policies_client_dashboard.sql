-- NUM 0010 — client-dashboard RLS policies (completes 0004)
-- =============================================================================
-- STATUS: ON THE SHELF. Not applied. Apply the day a client logs in directly
-- to Supabase (anon/authenticated key) instead of only the service-role backend.
--
-- WHY IT'S SAFE TO APPLY EARLY (and why it changes nothing today):
--   * The API backend uses the SERVICE-ROLE key, which BYPASSES RLS entirely.
--     These policies never touch the running pipeline.
--   * They only grant the `authenticated` role (a logged-in client) scoped read
--     access. No such client exists yet, so until one ships and mints JWTs,
--     applying this is inert — every table stays deny-all to the anon key.
--
-- AUTH MODEL ASSUMPTION (review before applying):
--   The dashboard authenticates a user and issues a Supabase-compatible JWT
--   carrying ONE of these claims:
--     * partner_tenant_id  -> a business operator; sees only their tenant.
--     * user_uuid          -> a traveler; sees only their own records.
--   A traveler JWT never carries partner_tenant_id and vice-versa, so the claim
--   itself segments the two audiences. If you mint claims under different names
--   (e.g. app_metadata.tenant_id), find/replace the two accessors below.
--
-- DELIBERATELY NOT EXPOSED to any client (service-role/backend only):
--   * user_profile_secure  — KMS-encrypted PII ciphertext.
--   * llm_usage            — internal model-cost accounting.
--   * message / memory / profile CONTENT is NOT exposed to business operators;
--     operators see their own commercial rows (vendors, leads, bookings), never
--     traveler chat content or PII.
--
-- Idempotent: safe to run more than once (drop-if-exists before each create).
-- =============================================================================

-- RLS is already enabled on every app table (0004 + later). These lines are a
-- harmless self-contained guarantee so this file applies cleanly on its own.
alter table partner_tenants     enable row level security;
alter table partners            enable row level security;
alter table vendors             enable row level security;
alter table acquisition_sources enable row level security;
alter table leads               enable row level security;
alter table bookings            enable row level security;
alter table users               enable row level security;
alter table user_profile        enable row level security;
alter table channel_identities  enable row level security;
alter table conversations       enable row level security;
alter table messages            enable row level security;
alter table memories            enable row level security;
alter table consent_events      enable row level security;
alter table events              enable row level security;


-- ==========================================================================
-- A) BUSINESS OPERATOR DASHBOARD  — JWT claim: partner_tenant_id
--    Each operator sees only their own tenant's commercial data.
-- ==========================================================================

-- Own tenant record (read).
drop policy if exists tenant_read_own on partner_tenants;
create policy tenant_read_own on partner_tenants
  for select to authenticated
  using (id = (auth.jwt() ->> 'partner_tenant_id')::uuid);

-- Operator/staff rows within the tenant (read).
drop policy if exists tenant_read_partners on partners;
create policy tenant_read_partners on partners
  for select to authenticated
  using (partner_tenant_id = (auth.jwt() ->> 'partner_tenant_id')::uuid);

-- Vendors (listings) — read + manage own tenant's listings.
drop policy if exists tenant_read_vendors on vendors;
create policy tenant_read_vendors on vendors
  for select to authenticated
  using (partner_tenant_id = (auth.jwt() ->> 'partner_tenant_id')::uuid);

drop policy if exists tenant_write_vendors on vendors;
create policy tenant_write_vendors on vendors
  for update to authenticated
  using      (partner_tenant_id = (auth.jwt() ->> 'partner_tenant_id')::uuid)
  with check (partner_tenant_id = (auth.jwt() ->> 'partner_tenant_id')::uuid);

-- Acquisition sources (QR / referral codes) — read own tenant's.
drop policy if exists tenant_read_sources on acquisition_sources;
create policy tenant_read_sources on acquisition_sources
  for select to authenticated
  using (partner_tenant_id = (auth.jwt() ->> 'partner_tenant_id')::uuid);

-- Leads (enquiries routed to this tenant) — read + update status.
drop policy if exists tenant_read_leads on leads;
create policy tenant_read_leads on leads
  for select to authenticated
  using (partner_tenant_id = (auth.jwt() ->> 'partner_tenant_id')::uuid);

drop policy if exists tenant_update_leads on leads;
create policy tenant_update_leads on leads
  for update to authenticated
  using      (partner_tenant_id = (auth.jwt() ->> 'partner_tenant_id')::uuid)
  with check (partner_tenant_id = (auth.jwt() ->> 'partner_tenant_id')::uuid);

-- Bookings — scoped through the vendor (bookings has vendor_id, not tenant id).
drop policy if exists tenant_read_bookings on bookings;
create policy tenant_read_bookings on bookings
  for select to authenticated
  using (
    vendor_id in (
      select v.id from vendors v
      where v.partner_tenant_id = (auth.jwt() ->> 'partner_tenant_id')::uuid
    )
  );


-- ==========================================================================
-- B) TRAVELER CLIENT (optional / future)  — JWT claim: user_uuid
--    Each traveler sees only their own records. Enable if/when a traveler
--    web/app client authenticates directly to Supabase. Harmless until then.
--    NOTE: user_profile_secure and llm_usage are intentionally omitted.
-- ==========================================================================

drop policy if exists self_read_users on users;
create policy self_read_users on users
  for select to authenticated
  using (user_uuid = (auth.jwt() ->> 'user_uuid')::uuid);

drop policy if exists self_read_profile on user_profile;
create policy self_read_profile on user_profile
  for select to authenticated
  using (user_uuid = (auth.jwt() ->> 'user_uuid')::uuid);

drop policy if exists self_read_channels on channel_identities;
create policy self_read_channels on channel_identities
  for select to authenticated
  using (user_uuid = (auth.jwt() ->> 'user_uuid')::uuid);

drop policy if exists self_read_conversations on conversations;
create policy self_read_conversations on conversations
  for select to authenticated
  using (user_uuid = (auth.jwt() ->> 'user_uuid')::uuid);

drop policy if exists self_read_messages on messages;
create policy self_read_messages on messages
  for select to authenticated
  using (user_uuid = (auth.jwt() ->> 'user_uuid')::uuid);

drop policy if exists self_read_memories on memories;
create policy self_read_memories on memories
  for select to authenticated
  using (user_uuid = (auth.jwt() ->> 'user_uuid')::uuid);

drop policy if exists self_read_bookings on bookings;
create policy self_read_bookings on bookings
  for select to authenticated
  using (user_uuid = (auth.jwt() ->> 'user_uuid')::uuid);

drop policy if exists self_read_consent on consent_events;
create policy self_read_consent on consent_events
  for select to authenticated
  using (user_uuid = (auth.jwt() ->> 'user_uuid')::uuid);

drop policy if exists self_read_events on events;
create policy self_read_events on events
  for select to authenticated
  using (user_uuid = (auth.jwt() ->> 'user_uuid')::uuid);

-- =============================================================================
-- END 0010. To apply when a dashboard ships:
--   supabase db push          (if using the CLI migration runner), or
--   apply via Supabase MCP apply_migration, or psql \i this file.
-- Verify afterwards: connect with a test authenticated JWT and confirm a
-- tenant sees only its own vendors/leads/bookings and nothing cross-tenant.
-- =============================================================================
