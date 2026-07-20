-- NUM 0002 — per-message cost tracking + inbound language detection
-- Additive + idempotent. Safe to re-run. Pairs with apps/api/services/{costing,lang_detect}.py

-- 1. Stamp detected language + intent on every message
alter table messages add column if not exists lang           text;
alter table messages add column if not exists detected_intent text;
create index if not exists messages_lang_idx on messages (lang);

-- 2. Per-LLM-call usage + USD cost (honest Pro-tier pricing inputs)
create table if not exists llm_usage (
    id              uuid primary key default gen_random_uuid(),
    conversation_id uuid references conversations(id) on delete cascade,
    user_uuid       uuid references users(user_uuid) on delete cascade,
    message_id      uuid references messages(id) on delete set null,
    purpose         text not null,                 -- 'intent'|'reply'|'embed'|'tool'
    model           text not null,
    input_tokens    integer not null default 0,
    output_tokens   integer not null default 0,
    cost_usd        numeric(12,6) not null default 0,
    created_at      timestamptz default now()
);
create index if not exists llm_usage_user_idx    on llm_usage (user_uuid, created_at desc);
create index if not exists llm_usage_conv_idx    on llm_usage (conversation_id);
create index if not exists llm_usage_created_idx on llm_usage (created_at desc);

-- Service role bypasses RLS; the dashboard scopes by partner_tenant_id later.
alter table llm_usage enable row level security;

-- 3. Convenience views for the ops dashboard
create or replace view v_cost_per_user_daily as
select
    user_uuid,
    (created_at at time zone 'UTC')::date as day,
    count(*)                as llm_calls,
    sum(input_tokens)       as input_tokens,
    sum(output_tokens)      as output_tokens,
    round(sum(cost_usd), 6) as cost_usd
from llm_usage
group by user_uuid, (created_at at time zone 'UTC')::date;

create or replace view v_language_mix as
select
    coalesce(lang, 'und') as lang,
    count(*)              as messages
from messages
where role = 'user'
group by coalesce(lang, 'und')
order by messages desc;
