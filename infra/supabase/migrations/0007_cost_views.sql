-- NUM 0007 — unit-economics views
--
-- Turns raw `llm_usage` rows into the three numbers we actually steer on:
--   1. cost per active user per month   (the headline unit metric)
--   2. cost by purpose/model            (where the money goes)
--   3. per-tenant unit economics        (is this partner profitable?)
--
-- Pairs with docs/ops/COST_MODEL.md. All views are `security_invoker` so they
-- honour RLS — the service-role backend reads everything as usual, and any
-- future authenticated caller sees only its own tenant's rows.
--
-- Idempotent: create or replace. Safe to re-run.

-- ── 1 · Cost per active user, by month ──────────────────────────────────────
-- "Active" = produced at least one billable LLM call that month. This is the
-- number to watch as we scale 100 → 1,000 users: it should FALL, because infra
-- is fixed and only the LLM slice is marginal.
create or replace view v_cost_per_user_monthly
with (security_invoker = true) as
select
    date_trunc('month', created_at)                             as month,
    count(distinct user_uuid)                                   as active_users,
    count(*)                                                    as llm_calls,
    round(sum(cost_usd)::numeric, 4)                            as total_usd,
    round((sum(cost_usd) / nullif(count(distinct user_uuid), 0))::numeric, 4)
                                                                as usd_per_active_user,
    round((sum(cost_usd) / nullif(count(*), 0))::numeric, 6)     as usd_per_call
from llm_usage
where user_uuid is not null
group by 1
order by 1 desc;

-- ── 2 · Where the money goes ────────────────────────────────────────────────
-- Compare avg_in / avg_out against the token profile in COST_MODEL.md §1.
-- If avg_in is materially above the estimate, the prompt is bloating —
-- usually history or memory recall growing faster than expected.
create or replace view v_cost_by_purpose
with (security_invoker = true) as
select
    purpose,
    model,
    count(*)                                    as calls,
    round(avg(input_tokens))                    as avg_input_tokens,
    round(avg(output_tokens))                   as avg_output_tokens,
    round(avg(cost_usd)::numeric, 6)            as avg_cost_usd,
    round(sum(cost_usd)::numeric, 4)            as total_usd,
    round((100.0 * sum(cost_usd)
           / nullif(sum(sum(cost_usd)) over (), 0))::numeric, 1)
                                                as pct_of_spend
from llm_usage
group by purpose, model
order by total_usd desc;

-- ── 3 · Per-tenant unit economics ───────────────────────────────────────────
-- Joins spend to the tenant that generated it. Answers "is this partner
-- costing more than they're worth?" — the question that decides whether a
-- market expands or closes.
create or replace view v_tenant_unit_economics
with (security_invoker = true) as
select
    pt.id                                                       as partner_tenant_id,
    pt.name                                                     as tenant,
    date_trunc('month', lu.created_at)                          as month,
    count(distinct lu.user_uuid)                                as active_users,
    count(*)                                                    as llm_calls,
    round(sum(lu.cost_usd)::numeric, 4)                         as cost_usd,
    round((sum(lu.cost_usd) / nullif(count(distinct lu.user_uuid), 0))::numeric, 4)
                                                                as cost_per_user
from llm_usage lu
join users u        on u.user_uuid = lu.user_uuid
join partner_tenants pt on pt.id   = u.partner_tenant_id
group by pt.id, pt.name, 3
order by 3 desc, cost_usd desc;

-- ── 4 · Runaway-cost guard ──────────────────────────────────────────────────
-- Conversations that cost far more than a normal turn — almost always a tool
-- loop misfiring or an abusive user. Watch this daily once traffic is live.
-- Threshold mirrors COST_MODEL.md §5 ($0.50/conversation).
create or replace view v_expensive_conversations
with (security_invoker = true) as
select
    conversation_id,
    user_uuid,
    count(*)                            as calls,
    sum(input_tokens)                   as total_input_tokens,
    sum(output_tokens)                  as total_output_tokens,
    round(sum(cost_usd)::numeric, 4)    as cost_usd,
    min(created_at)                     as started_at,
    max(created_at)                     as last_call_at
from llm_usage
where conversation_id is not null
group by conversation_id, user_uuid
having sum(cost_usd) > 0.50
order by cost_usd desc;
