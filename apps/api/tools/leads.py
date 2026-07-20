"""Tools: create_lead (whale leads) + escalate_to_human."""
from __future__ import annotations

from typing import Optional

import structlog

from apps.api.deps import get_supabase
from apps.api.services import alerts, persistence

log = structlog.get_logger()


def create_lead(ctx, vertical: str, budget_band: Optional[str] = None,
                timeline: Optional[str] = None, notes: Optional[str] = None) -> dict:
    """Insert a high-value lead, log the event, and ping #num-ops."""
    try:
        res = (
            get_supabase()
            .table("leads")
            .insert(
                {
                    "user_uuid": ctx.user_uuid,
                    "partner_tenant_id": ctx.partner_tenant_id,
                    "vertical": vertical,
                    "budget_band": budget_band,
                    "timeline": timeline,
                    "notes": notes,
                    "status": "new",
                }
            )
            .execute()
        )
        lead_id = res.data[0]["id"] if res.data else None
        persistence.log_event(
            ctx.user_uuid, "lead_created",
            {"vertical": vertical, "budget_band": budget_band, "timeline": timeline, "lead_id": lead_id},
        )
        alerts.whale_lead(vertical=vertical, budget_band=budget_band, timeline=timeline,
                          user_uuid=ctx.user_uuid, lead_id=lead_id)
        return {"lead_id": lead_id, "status": "new",
                "message": "A local specialist from our partner network will follow up within 24 hours."}
    except Exception as e:
        log.warning("create_lead_failed", error=str(e))
        return {"error": "could not create lead"}


def escalate_to_human(ctx, reason: str, urgency: str = "normal") -> dict:
    """Flag a conversation for a human teammate."""
    try:
        persistence.log_event(ctx.user_uuid, "escalation", {"reason": reason, "urgency": urgency})
        alerts.escalation(reason=reason, urgency=urgency, user_uuid=ctx.user_uuid)
        return {"escalated": True, "message": "A human teammate has been notified and will jump in."}
    except Exception as e:
        log.warning("escalate_to_human_failed", error=str(e))
        return {"escalated": False, "error": "escalation failed"}
