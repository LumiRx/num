# Sprint 2 + 3 — Self-serve business + managed agentic settlement (SHIPPED DARK)

Additive, off by default. Nothing changes until the migrations are applied, the
two 1-line hooks are wired, and the flags are set.

## What shipped
**Sprint 2 — self-serve business (supply side):**
- `apps/api/services/merchant.py` — `register_business`, `submit_listing`, `start_operator_verification` / `record_operator_verification`, `quality_check`, `approve_listing`, `reject_listing`, `list_pending`, `set_engagement_config`.
- `infra/supabase/migrations/0008_selfserve_business.sql` — `vendors` + `status` (default `approved` → every existing vendor stays live), `self_serve`, `operator_pohf_jti`, `operator_verified`, `engagement_config`, `contact_email`, submitted/reviewed/reject/freshness.

**Sprint 3 — managed agentic interaction + settlement:**
- `apps/api/services/broker.py` — `user_policy`, `business_rules`, `can_transact` (verified human ∩ approved+verified business ∩ business rules), `bind_transaction` (5arz Agent-Tx-Binding), `record_settlement`, `settle_transaction`.
- `infra/supabase/migrations/0009_settlement_ledger.sql` — `leads` fee/`atb_jti` columns + `settlements` ledger table (closes FULL_FLOW D5/E3).
- `settings.py` + `.env.example` — `SARZ_SETTLEMENT_ENABLED`.

## Hooks to activate (deliberate, ~1 line each)
1. **Approval gate** — in `apps/api/tools/vendors.py` `search_vendors`, after the tenant filter:
   ```python
   q = q.eq("status", "approved")
   ```
   Migration defaults existing rows to `approved`, so this is safe to add anytime.
2. **Settle on close** — where a lead is marked `closed_won` (or a booking confirms):
   ```python
   from apps.api.services import broker
   broker.settle_transaction("lead", fee_cents, user_uuid=uid, lead_id=lid,
                             tenant_id=tid, payment_ref=ref)
   ```
3. **Merchant portal API (optional)** — add a thin `apps/api/routers/merchant.py` exposing
   register / submit / verify / approve over the `merchant.py` service, then
   `app.include_router(...)` in `main.py`. The service layer is done.

## Enable
Apply 0008 + 0009, then set `SARZ_VERIFY_ENABLED=true`, `SARZ_SETTLEMENT_ENABLED=true`,
`SARZ_AGENT_KEY=arz_live_…`.

## The result
Verified user ⇄ verified business, brokered by NUM inside *user policy ∩ business rules*,
every transaction bound to a portable 5arz receipt and recorded to the ledger — the
two-sided verified marketplace, live.

Full design: `docs/5arz_x_NUM_Verified_Agentic_Concierge_SPEC.md` · Sprint 1: `docs/SPRINT_1_5arz_verify_README.md`.
