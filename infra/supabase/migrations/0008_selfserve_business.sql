-- NUM 0008 — self-serve business onboarding (Sprint 2)
--
-- Businesses onboard themselves; the operator proves they're a real human via
-- 5arz; listings pass an approval gate before the concierge AI can recommend
-- them. Additive + reversible. status defaults to 'approved' so every EXISTING
-- vendor stays live and the AI's behavior is unchanged; only new self-serve
-- listings enter 'pending' and must be approved to become visible.

alter table vendors add column if not exists status            text not null default 'approved';
alter table vendors add column if not exists self_serve        boolean not null default false;
alter table vendors add column if not exists operator_pohf_jti text;
alter table vendors add column if not exists operator_verified boolean not null default false;
alter table vendors add column if not exists engagement_config jsonb default '{}';
alter table vendors add column if not exists contact_email     text;
alter table vendors add column if not exists submitted_at      timestamptz;
alter table vendors add column if not exists reviewed_at       timestamptz;
alter table vendors add column if not exists reviewed_by       text;
alter table vendors add column if not exists reject_reason     text;
alter table vendors add column if not exists freshness_at      timestamptz;

create index if not exists idx_vendors_status on vendors (status);

comment on column vendors.status is 'pending | approved | rejected | stale -- only approved is visible to the concierge AI (the quality gate)';
comment on column vendors.operator_verified is 'true once the business operator passes 5arz human verification';
comment on column vendors.engagement_config is 'how NUM represents this business: offers, booking policy, tone, escalation';
