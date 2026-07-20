-- NUM 0004 — close the public-exposure gap (Supabase linter 0013_rls_disabled_in_public)
--
-- NOT auto-applied. Review, then apply (Supabase MCP apply_migration or psql).
--
-- WHY THIS IS SAFE: the API backend connects with the SERVICE-ROLE key, which
-- BYPASSES row-level security. Enabling RLS here does NOT affect the running
-- pipeline. It only closes anon/authenticated (anon-key) access to these
-- tables — which nothing currently uses. channel_identities in particular
-- holds phone numbers, LINE userIds and WeChat openids (PII) and is today
-- readable by anyone holding the public anon key.
--
-- spatial_ref_sys is intentionally excluded: it is a PostGIS system/reference
-- table and enabling RLS on it is not recommended.

alter table partner_tenants     enable row level security;
alter table channel_identities  enable row level security;  -- PII: phone / LINE / WeChat handles
alter table vendors             enable row level security;
alter table bookings            enable row level security;
alter table acquisition_sources enable row level security;
alter table events              enable row level security;
alter table partners            enable row level security;

-- When the partner dashboard ships (a JWT carrying a partner_tenant_id claim),
-- add tenant-scoped read policies so each partner sees only their own rows, e.g.:
--
--   create policy tenant_read_vendors on vendors
--     for select to authenticated
--     using (partner_tenant_id = (auth.jwt() ->> 'partner_tenant_id')::uuid);
--
-- Repeat per tenant-scoped table. Until then, enable-only is correct: the
-- service-role backend keeps working and the anon key can read nothing.
