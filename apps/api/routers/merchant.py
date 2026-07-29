"""Self-serve business onboarding — HTTP surface for the itsnum.com portal.

Thin transport over services.merchant (Sprint 2). Additive: mounting this
router changes nothing about existing routes or the concierge pipeline. Every
handler is best-effort and never raises out to the client.

Spec: docs/5arz_x_NUM_Verified_Agentic_Concierge_SPEC.md (Piece 2)
"""
from __future__ import annotations

from typing import Optional

import structlog
from fastapi import APIRouter
from pydantic import BaseModel, Field

from apps.api.deps import get_supabase
from apps.api.services import merchant as m
from apps.api.settings import get_settings

router = APIRouter(prefix="/merchant", tags=["merchant"])
log = structlog.get_logger()

CATEGORIES = [
    "restaurant", "cafe", "bar", "tour", "activity", "spa", "wellness",
    "transport", "villa", "hotel", "shop", "event", "other",
]


def _tenant(explicit: Optional[str]) -> Optional[str]:
    return explicit or getattr(get_settings(), "DEFAULT_PARTNER_TENANT_ID", None)


class RegisterIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    contact_email: str = Field(min_length=3, max_length=200)
    category: Optional[str] = None
    tenant_id: Optional[str] = None
    metadata: Optional[dict] = None


@router.get("/categories")
def categories():
    return {"categories": CATEGORIES}


@router.post("/register")
def register(body: RegisterIn):
    """Create a self-serve vendor (status 'pending'). Returns its id."""
    tenant = _tenant(body.tenant_id)
    if not tenant:
        return {"ok": False, "error": "no_tenant_configured"}
    v = m.register_business(tenant, body.name.strip(), body.contact_email.strip(), body.category)
    if not v:
        return {"ok": False, "error": "register_failed"}
    if body.metadata:
        m.submit_listing(v["id"], {"metadata": body.metadata})
    return {"ok": True, "vendor_id": v["id"], "status": v.get("status", "pending")}


class ListingIn(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    contact_email: Optional[str] = None
    metadata: Optional[dict] = None


@router.post("/{vendor_id}/listing")
def listing(vendor_id: str, body: ListingIn):
    """Patch a listing's details (returns it to 'pending' for re-approval)."""
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    return {"ok": m.submit_listing(vendor_id, patch)}


class EngagementIn(BaseModel):
    config: dict


@router.post("/{vendor_id}/engagement")
def engagement(vendor_id: str, body: EngagementIn):
    """Set how NUM represents this business: offers, booking policy, tone, escalation."""
    return {"ok": m.set_engagement_config(vendor_id, body.config)}


class VerifyStartIn(BaseModel):
    lang: str = "en"


@router.post("/{vendor_id}/verify/start")
def verify_start(vendor_id: str, body: VerifyStartIn):
    """Begin 5arz operator verification. url is None when 5arz is off (portal skips)."""
    url = m.start_operator_verification(vendor_id, body.lang)
    return {"ok": True, "url": url, "enabled": url is not None}


class VerifyRecordIn(BaseModel):
    pohf_jti: str


@router.post("/{vendor_id}/verify/record")
def verify_record(vendor_id: str, body: VerifyRecordIn):
    """5arz completion callback — mark the operator verified."""
    return {"ok": m.record_operator_verification(vendor_id, body.pohf_jti)}


@router.get("/{vendor_id}/status")
def status(vendor_id: str):
    """Public status lookup for the merchant: pending | approved | rejected + gaps."""
    try:
        r = (
            get_supabase()
            .table("vendors")
            .select("id,name,category,status,operator_verified,reject_reason,submitted_at,reviewed_at")
            .eq("id", vendor_id)
            .limit(1)
            .execute()
        )
        if not r.data:
            return {"ok": False, "error": "not_found"}
        v = r.data[0]
        ok, missing = m.quality_check(v)
        return {"ok": True, "vendor": v, "complete": ok, "missing": missing}
    except Exception as e:
        log.warning("merchant_status_failed", vendor_id=vendor_id, error=str(e))
        return {"ok": False, "error": "status_failed"}
