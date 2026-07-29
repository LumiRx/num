# NUM — Unit Economics & Cost Model

**Updated:** 2026-07-24 · **Market:** Edinburgh (GBP, WhatsApp + SMS) · **Stack:** Anthropic-only
**Source of truth for pricing:** `apps/api/services/costing.py` — update rates *there*, never here.

**What's measured vs assumed.** Read this before quoting any number:

| Input | Status | Where it comes from |
|---|---|---|
| Model rates ($/M tokens) | ✅ **Verified** | `costing.py` PRICING table |
| Token profile per message | ⚠️ **Estimated** | Read from prompt + pipeline structure. **Calibrate against real `llm_usage` rows after ~500 messages** (query in §5) |
| Channel rates | ⚠️ **Estimated** | Public UK rate cards. Verify against your first Twilio invoice |
| Engagement (msgs/user/mo) | ⚠️ **Assumed** | 12/month, from the pilot's ≥6-msgs-per-conversation KPI × 2 conversations |
| Infra | ✅ Known | Railway + Supabase Pro list pricing |

The model's *structure* is right. The absolute numbers move once real traffic lands — §5 is how you replace every assumption with measurement.

---

## 1 · Cost of one message

The pipeline makes two model calls per inbound message: Haiku classifies intent (analytics only, runs in parallel), Sonnet composes the reply inside a tool loop (max 3 turns, 12s budget).

**Haiku — intent**
| | tokens | rate | cost |
|---|---|---|---|
| in | ~230 (prompt 200 + message 30) | $1/M | $0.000230 |
| out | ~5 (a label; `max_tokens=10`) | $5/M | $0.000025 |
| | | | **$0.00026** |

**Sonnet — reply (tool loop)**
| | tokens | rate | cost |
|---|---|---|---|
| in | ~3,400 — system 700 · tools 600 · history 540 · memories 480 · message 30, × ~1.4 calls | $3/M | $0.01020 |
| out | ~170 | $15/M | $0.00255 |
| | | | **$0.01275** |

### → **≈ $0.013 per inbound message** (Sonnet is 98% of it)

---

## 2 · At 100 and 1,000 monthly active users

Assumes 12 messages/user/month. Two channel scenarios, because **the channel mix moves the number more than the AI does**.

| | **100 MAU** | **1,000 MAU** |
|---|---|---|
| Messages/month | 1,200 | 12,000 |
| **LLM** | $15.60 | $156.00 |
| **Infra** (Railway + Supabase Pro) | $45 | $65 |
| **WhatsApp** — service window free, utility msgs only | $0.55 | $5.50 |
| **Subtotal — WhatsApp-only** | **$61** | **$227** |
| *per user* | *$0.61* | *$0.23* |
| **+ SMS at 30% of traffic** (UK ~$0.04 out / $0.0075 in) | +$17 | +$171 |
| **Total — mixed channels** | **$78** | **$398** |
| *per user* | *$0.78* | *$0.40* |

**Two things jump out.**

**Fixed infra dominates at 100 users** — $45 of $61 is Railway + Supabase, whether you have 10 users or 300. Cost per user drops 62% from 100 → 1,000 MAU purely from spreading that base.

**SMS overtakes the AI at scale.** At 1,000 MAU with a 30% SMS mix, SMS costs **$171 against $156 of LLM**. Every user you steer from SMS to WhatsApp is worth more than any prompt optimization. Meta made user-initiated service conversations free — that's the single biggest lever in this table, and it's a product decision, not an engineering one.

---

## 3 · Optimization levers, ranked by real savings

| # | Lever | Effect | Saving @1,000 MAU | Effort |
|---|---|---|---|---|
| 1 | **Steer to WhatsApp over SMS** | Service-window messages are free | **~$171/mo** | Product/UX |
| 2 | **Prompt caching** on system + tools (~1,300 stable tokens; cache reads bill at ~10%) | $0.013 → $0.0081/msg | **~$59/mo** | ~2 hours |
| 3 | **Trim history** 12 → 6 turns | −270 in-tokens/msg | ~$10/mo | 1 line |
| 4 | **Cap memories** 40 → 20 facts | −240 in-tokens/msg | ~$9/mo | 1 line (`MEMORY_RECALL_LIMIT`) |
| 5 | Drop Haiku intent (it's analytics-only) | −$0.00026/msg | ~$3/mo | Cheap, but you lose the intent data — **not worth it** |

**Stacked (1 + 2 + 3 + 4):** ~$0.0077/message, WhatsApp-first.

| | 100 MAU | 1,000 MAU |
|---|---|---|
| Optimized total | **~$55/mo** | **~$163/mo** |
| **Per user** | **$0.55** | **$0.16** |

### The one to do first
**Prompt caching.** The system prompt and tool schemas are byte-identical on every single call — you're paying full input price ~1.4× per message to re-send 1,300 tokens that never change. Anthropic's cache turns that into a ~10% read. It's a couple of hours of work, it's invisible to users, and it never degrades reply quality. Levers 3 and 4 trade context for money, so only reach for them if quality holds.

---

## 4 · Does it pay?

At 1,000 MAU, optimized, WhatsApp-first: **~$163/month all-in.**

A single booking commission covers roughly 40 users' monthly cost. If 12% of active users complete a booking (the pilot KPI) at ~£4 average commission, 1,000 MAU produces ~120 bookings ≈ **£480 (~$600) against $163 of cost.** Gross margin ~73%, and that ignores whale leads entirely — one relocation or property lead can exceed a month of booking commissions.

**The economics work.** The risk isn't cost per user; it's engagement (do they come back) and supply depth (can NUM actually answer). Both are measured elsewhere — D7 return and vendor coverage.

---

## 5 · Replace these assumptions with measurement

Run this once ~500 real messages have flowed. It reads the **actual** token profile from `llm_usage` and tells you how far the estimates above were off:

```sql
-- Real cost per message, by purpose. Compare against §1.
select
  purpose,
  model,
  count(*)                                  as calls,
  round(avg(input_tokens))                  as avg_in,
  round(avg(output_tokens))                 as avg_out,
  round(avg(cost_usd)::numeric, 6)          as avg_cost_usd,
  round(sum(cost_usd)::numeric, 2)          as total_usd
from llm_usage
group by purpose, model
order by total_usd desc;
```

```sql
-- Real cost per active user, last 30 days. This is THE number.
select
  round(sum(cost_usd)::numeric, 2)                             as total_usd,
  count(distinct user_uuid)                                    as active_users,
  round((sum(cost_usd) / nullif(count(distinct user_uuid),0))::numeric, 4) as cost_per_user
from llm_usage
where created_at > now() - interval '30 days';
```

Migration `0007_cost_views.sql` ships these as views (`v_cost_per_user_monthly`, `v_cost_by_purpose`, `v_tenant_unit_economics`) so the Master dashboard reads them directly rather than re-deriving the math.

**Alert thresholds worth setting now**, before traffic:
- Cost per active user **> $1.00/month** → investigate before scaling
- Any single conversation **> $0.50** → likely a tool loop misfiring
- Daily spend **> 2× trailing 7-day average** → abuse or a runaway loop

---

## 6 · What changes for Edinburgh specifically

| | Phuket assumption | Edinburgh reality |
|---|---|---|
| Channels | LINE + WeChat + WhatsApp | **WhatsApp + SMS** — no LINE, no WeChat |
| Language | 9 languages, heavy ZH/RU | **English-first**; EU visitor languages secondary |
| Currency | THB | **GBP** |
| SMS regime | US A2P 10DLC | **UK** — no 10DLC; sender ID registration differs |
| Cost impact | — | Fewer languages = slightly shorter prompts; SMS more likely in-market than LINE was |

The English-first market is *cheaper per message* (no multilingual system-prompt overhead) but *more SMS-inclined* than Thailand, where LINE carried the volume for free. Net: the numbers above hold, with channel mix as the swing factor.
