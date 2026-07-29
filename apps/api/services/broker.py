"""Managed agentic interaction + settlement — Sprint 3.

The user's agent (NUM + encrypted profile) transacts with a business agent
(its ``engagement_config``) inside **user policy ∩ business rules**, managed
from the console. When an interaction becomes a booking or a closed lead, 5arz
issues an Agent-Tx-Binding (verified human ↔ agent ↔ payment) and the fee is
recorded to the settlements ledger — closing FULL_FLOW gaps D5 (close + fee)
and E3 (settlement ledger).

Config-gated + best-effort. Binding is a no-op returning None unless
``SARZ_SETTLEMENT_ENABLED`` is on; the ledger write always works so you can run
settlement manually first and add the on-chain binding later.

Companion migration: infra/supabase/migrations/0009_settlement_ledger.sql
Spec: docs/5arz_x_NUM_Verified_Agentic_Concierge_SPEC.md
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import structlog

from apps.api.deps import get_supabase
from apps.api.services import sarz_verify
from apps.api.settings import get_settings

log = structlog.get_logger()


# ── Policy layer: user policy ∩ business rules ───────────────────────────────

def user_policy(user: dict) -> dict:
    """The per-user rules NUM enforces on the user's behalf (from profile + tier).

    Extend from ``user_profile.profile_json`` (budget band, quality bar, do/don't).
    """
    return {
        "human_tier": user.get("human_tier", "unverified"),
        "preferred_lang": user.get("preferred_lang", "en"),
    }


def business_rules(vendor: dict) -> dict:
    """The business's engagement config: auto-accept threshold, tone, escalation, offers."""
    cfg = vendor.get("engagement_config") or {}
    return {
        "auto_accept_under_cents": cfg.get("auto_accept_under_cents"),
        "escalate_high_value": cfg.get("escalate_high_value", True),
        "tone": cfg.get("tone"),
        "offers": cfg.get("offers", []),
    }


def can_transact(user: dict, vendor: dict, amount_cents: int, min_tier: str = "proof_of_human") -> tuple[bool, str]:
    """Gate a transaction on verified human ∩ approved+verified business ∩ business rules.

    Returns ``(allowed, reason)`` where reason is 'auto_ok' | 'needs_human_confirm'
    | a blocking code. When 5arz is off, verification checks pass (unchanged NUM).
    """
    if not sarz_verify.is_verified(user.get("user_uuid", ""), min_tier=min_tier):
        return (False, "user_not_verified")
    if vendor.get("status") != "approved":
        return (False, "vendor_not_approved")
    s = get_settings()
    if getattr(s, "SARZ_VERIFY_ENABLED", False) and not vendor.get("operator_verified"):
        return (False, "operator_not_verified")
    thr = business_rules(vendor).get("auto_accept_under_cents")
    if thr is not None and amount_cents > int(thr):
        return (True, "needs_human_confirm")  # allowed, but route to the business to confirm
    return (True, "auto_ok")


# ── 5arz binding + settlement ────────────────────────────────────────────────

def bind_transaction(
    user_uuid: str, work_ref: str, kind: str, amount_cents: int, payment_ref: Optional[str] = None
) -> Optional[str]:
    """Mint a 5arz Agent-Tx-Binding (human ↔ agent ↔ payment). Returns the
    credential id (jti), or None when disabled / unreachable."""
    s = get_settings()
    if not (getattr(s, "SARZ_SETTLEMENT_ENABLED", False) and getattr(s, "SARZ_AGENT_KEY", None)):
        return None
    try:
        import httpx  # transitive via supabase; no new pin

        api = (getattr(s, "SARZ_API_URL", None) or "https://api.5arz.com").rstrip("/")
        resp = httpx.post(
            f"{api}/api/agents/bind-transaction",
            headers={
                "Authorization": f"Bearer {getattr(s, 'SARZ_AGENT_KEY', '') or ''}",
                "Content-Type": "application/json",
            },
            json={"memberId": user_uuid, "taskType": kind, "workRef": work_ref, "paymentRef": payment_ref},
            timeout=6.0,
        )
        if resp.status_code == 200:
            data = resp.json()
            return data.get("jti") or data.get("atb_jti") or data.get("id")
        log.warning("bind_transaction_non200", status=resp.status_code)
        return None
    except Exception as e:
        log.warning("bind_transaction_failed", error=str(e))
        return None


def record_settlement(
    kind: str,
    amount_cents: int,
    *,
    user_uuid: Optional[str] = None,
    vendor_id: Optional[str] = None,
    lead_id: Optional[str] = None,
    tenant_id: Optional[str] = None,
    method: str = "manual",
    currency: str = "usd",
    atb_jti: Optional[str] = None,
    payment_ref: Optional[str] = None,
    status: str = "pending",
) -> Optional[dict]:
    """Write a row to the settlements ledger. Best-effort."""
    try:
        payload = {
            "partner_tenant_id": tenant_id,
            "kind": kind,
            "user_uuid": user_uuid,
            "vendor_id": vendor_id,
            "lead_id": lead_id,
            "amount_cents": amount_cents,
            "currency": currency,
            "method": method,
            "status": status,
            "atb_jti": atb_jti,
            "payment_ref": payment_ref,
        }
        if status == "settled":
            payload["settled_at"] = datetime.now(timezone.utc).isoformat()
        row = get_supabase().table("settlements").insert(payload).execute()
        v = row.data[0]
        log.info("settlement_recorded", id=v["id"], kind=kind, amount_cents=amount_cents, status=status)
        return v
    except Exception as e:
        log.warning("record_settlement_failed", error=str(e))
        return None


def settle_transaction(
    kind: str,
    amount_cents: int,
    *,
    user_uuid: str,
    vendor_id: Optional[str] = None,
    lead_id: Optional[str] = None,
    tenant_id: Optional[str] = None,
    method: str = "manual",
    payment_ref: Optional[str] = None,
) -> dict:
    """End-to-end: bind at 5arz (portable verified receipt) → record to the ledger.

    Returns ``{ok, atb_jti, settlement_id}``. Both sides — the verified human and
    the verified business — now have a receipt that a real human authorized a
    real business action.
    """
    atb = bind_transaction(user_uuid, work_ref=(vendor_id or lead_id or ""), kind=kind,
                           amount_cents=amount_cents, payment_ref=payment_ref)
    st = record_settlement(
        kind, amount_cents, user_uuid=user_uuid, vendor_id=vendor_id, lead_id=lead_id,
        tenant_id=tenant_id, method=method, atb_jti=atb, payment_ref=payment_ref,
        status="settled" if payment_ref else "pending",
    )
    return {"ok": bool(st), "atb_jti": atb, "settlement_id": (st or {}).get("id")}
