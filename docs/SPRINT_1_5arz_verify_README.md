# Sprint 1 — 5arz human verification (SHIPPED DARK)

Adds real-human proof to every NUM user via 5arz Proof-of-Human-Fulfillment (PoHF).
**Off by default** (`SARZ_VERIFY_ENABLED=false`) — merged safe; flip on per tenant when ready.

## What shipped (additive; zero behavior change while off)
- `apps/api/services/sarz_verify.py` — the service (`start_verification` / `record_credential` / `get_status` / `is_verified` / `reverify` / `verification_notice`).
- `infra/supabase/migrations/0007_sarz_human_verification.sql` — `users` columns: `human_tier`, `pohf_jti`, `unique_human_jti`, `human_verified_at`, `human_verify_ref`.
- `apps/api/settings.py` + `.env.example` — `SARZ_*` config.
- No new pinned dependency: `httpx` is already transitive via `supabase`.

## Two steps to turn it on
1. **Apply the migration** in Supabase: run `0007_sarz_human_verification.sql`.
2. **Wire the hook** — one block in `apps/api/services/pipeline.py` (below).
Then set env: `SARZ_VERIFY_ENABLED=true`, `SARZ_AGENT_KEY=arz_live_…` (NUM's 5arz agent key).

## The pipeline hook (deliberate 1-block add — left to the pipeline owner)
In `handle_inbound`, right after:
```python
    is_new_user = bool(user.pop("_is_new", False))
```
kick off verification for new users (no-op when disabled):
```python
    from apps.api.services import sarz_verify
    if is_new_user:
        sarz_verify.start_verification(user_uuid, lang="en")   # pending marker + hosted link
```
Where the first-contact PDPA notice is appended to the reply, also append the verify nudge:
```python
    notice = sarz_verify.verification_notice(user.get("preferred_lang") or "en")
    if notice:
        reply = f"{reply}\n\n{notice}"    # + your hosted verify link
```
Left as a documented step so the reply-tail logic stays owned by the pipeline (and to avoid colliding with any parallel edit there).

## Gating high-value actions (Sprint 3 uses this)
Before a whale hand-off or a payment:
```python
    if not sarz_verify.is_verified(user_uuid, min_tier="identity"):
        # route the user to complete identity verification first
```
`is_verified()` returns `True` while the flag is off, so nothing changes until you enable it.

## Completion callback
When 5arz signals a finished verification, call
`record_credential(user_uuid, pohf_jti, tier, unique_human_jti, member_ref)`.
Add a small `routers/sarz.py` webhook or a poll worker — Sprint 1.5.

## Why (one line for partners)
Every NUM user is a provably real, unique human; whale leads (property / school / visa) arrive KYC-grade — worth far more to the specialist closing them, and exactly what businesses pay for.

Full design: `docs/5arz_x_NUM_Verified_Agentic_Concierge_SPEC.md`.
