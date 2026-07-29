"""Self-serve business onboarding — Sprint 2 of the verified-agentic-concierge build.

Businesses onboard themselves, the operator proves they're a real human via 5arz,
and listings pass an approval gate before the concierge AI can recommend them.

Additive + best-effort. The quality gate works without 5arz; operator
verification is *required to publish* only when SARZ_VERIFY_ENABLED is on
(so existing/manual vendors are unaffected). Approved listings become visible
to the AI once ``search_vendors`` filters ``status = 'approved'`` (see the
Sprint 2/3 README — a one-line hook).

Companion migration: infra/supabase/migrations/0008_selfserve_business.sql
Spec: docs/5arz_x_NUM_Verified_Agentic_Concierge_SPEC.md
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlencode

import structlog

from apps.api.deps import get_supabase
from apps.api.settings import get_settings

log = structlog.get_logger()

REQUIRED_LISTING_FIELDS = ("name", "category")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def register_business(
    tenant_id: str, name: str, contact_email: str, category: Optional[str] = None
) -> Optional[dict]:
    """Create a self-serve vendor in 'pending'. Returns the row, or None on error."""
    try:
        row = (
            get_supabase()
            .table("vendors")
            .insert(
                {
                    "partner_tenant_id": tenant_id,
                    "name": name,
                    "category": category,
                    "contact_email": contact_email,
                    "self_serve": True,
                    "status": "pending",
                    "submitted_at": _now(),
                }
            )
            .execute()
        )
        v = row.data[0]
        log.info("merchant_registered", vendor_id=v["id"], tenant_id=tenant_id)
        return v
    except Exception as e:
        log.warning("merchant_register_failed", error=str(e))
        return None


def submit_listing(vendor_id: str, patch: dict) -> bool:
    """Merchant edits their listing. Any edit returns it to 'pending' for re-approval."""
    try:
        allowed = {
            k: patch[k]
            for k in ("name", "category", "metadata", "engagement_config", "contact_email")
            if k in patch
        }
        allowed["status"] = "pending"
        allowed["submitted_at"] = _now()
        get_supabase().table("vendors").update(allowed).eq("id", vendor_id).execute()
        return True
    except Exception as e:
        log.warning("submit_listing_failed", vendor_id=vendor_id, error=str(e))
        return False


def start_operator_verification(vendor_id: str, lang: str = "en") -> Optional[str]:
    """Send the business operator through 5arz identity verification.

    Returns a hosted verify URL, or None when disabled.
    """
    s = get_settings()
    if not (getattr(s, "SARZ_VERIFY_ENABLED", False) and getattr(s, "SARZ_AGENT_KEY", None)):
        return None
    try:
        base = (getattr(s, "SARZ_VERIFY_URL", None) or "https://5arz.com/verify").rstrip("/")
        qs = urlencode({"ref": f"numbiz_{vendor_id}", "tier": "identity", "lang": lang, "kind": "operator"})
        return f"{base}?{qs}"
    except Exception as e:
        log.warning("operator_verify_start_failed", vendor_id=vendor_id, error=str(e))
        return None


def record_operator_verification(vendor_id: str, pohf_jti: str) -> bool:
    """Mark the operator verified (called from the 5arz completion callback)."""
    try:
        get_supabase().table("vendors").update(
            {"operator_pohf_jti": pohf_jti, "operator_verified": True}
        ).eq("id", vendor_id).execute()
        log.info("operator_verified", vendor_id=vendor_id, pohf_jti=pohf_jti)
        return True
    except Exception as e:
        log.warning("record_operator_verification_failed", vendor_id=vendor_id, error=str(e))
        return False


def quality_check(vendor: dict) -> tuple[bool, list[str]]:
    """Rule-based completeness gate. Upgrade to a Haiku plausibility pass later."""
    missing = [f for f in REQUIRED_LISTING_FIELDS if not (str(vendor.get(f) or "").strip())]
    return (len(missing) == 0, missing)


def approve_listing(vendor_id: str, reviewer: str = "operator") -> dict:
    """Approve → visible to the AI. Requires a passing quality check, and a
    verified operator when 5arz is on."""
    s = get_settings()
    sb = get_supabase()
    try:
        cur = sb.table("vendors").select("*").eq("id", vendor_id).limit(1).execute()
        if not cur.data:
            return {"ok": False, "error": "vendor_not_found"}
        v = cur.data[0]
        ok, missing = quality_check(v)
        if not ok:
            return {"ok": False, "error": "incomplete", "missing": missing}
        if getattr(s, "SARZ_VERIFY_ENABLED", False) and not v.get("operator_verified"):
            return {"ok": False, "error": "operator_not_verified"}
        sb.table("vendors").update(
            {"status": "approved", "reviewed_at": _now(), "reviewed_by": reviewer}
        ).eq("id", vendor_id).execute()
        log.info("listing_approved", vendor_id=vendor_id, reviewer=reviewer)
        return {"ok": True}
    except Exception as e:
        log.warning("approve_listing_failed", vendor_id=vendor_id, error=str(e))
        return {"ok": False, "error": "approve_failed"}


def reject_listing(vendor_id: str, reason: str, reviewer: str = "operator") -> bool:
    try:
        get_supabase().table("vendors").update(
            {"status": "rejected", "reject_reason": reason, "reviewed_at": _now(), "reviewed_by": reviewer}
        ).eq("id", vendor_id).execute()
        return True
    except Exception as e:
        log.warning("reject_listing_failed", vendor_id=vendor_id, error=str(e))
        return False


def list_pending(tenant_id: Optional[str] = None) -> list[dict]:
    """Queue of listings awaiting review (Operator/Master console)."""
    try:
        q = (
            get_supabase()
            .table("vendors")
            .select("id,name,category,contact_email,operator_verified,submitted_at")
            .eq("status", "pending")
        )
        if tenant_id:
            q = q.eq("partner_tenant_id", tenant_id)
        return (q.order("submitted_at").execute().data) or []
    except Exception as e:
        log.warning("list_pending_failed", error=str(e))
        return []


def set_engagement_config(vendor_id: str, config: dict) -> bool:
    """How NUM represents this business: offers, booking policy, tone, escalation."""
    try:
        get_supabase().table("vendors").update({"engagement_config": config}).eq(
            "id", vendor_id
        ).execute()
        return True
    except Exception as e:
        log.warning("set_engagement_config_failed", vendor_id=vendor_id, error=str(e))
        return False
