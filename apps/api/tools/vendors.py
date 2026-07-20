"""Tool: search_vendors — catalogue lookup scoped to the user's tenant."""
from __future__ import annotations

from typing import Optional

import structlog

from apps.api.deps import get_supabase

log = structlog.get_logger()

# Featured tiers bubble up first; commission-bearing partners get visibility.
_TIER_RANK = {"premium": 3, "standard": 2, "local": 1}


def search_vendors(ctx, category: Optional[str] = None, geo: Optional[str] = None,
                   filters: Optional[dict] = None, limit: int = 5) -> dict:
    """Return vendors in this tenant's catalogue, featured tiers first.

    Never invents data — if the catalogue is empty the model is told so, so it
    won't hallucinate names/prices (a hard guardrail in the system prompt).
    """
    try:
        limit = max(1, min(int(limit or 5), 10))
        q = get_supabase().table("vendors").select("id,name,category,featured_tier,metadata")
        if ctx.partner_tenant_id:
            q = q.eq("partner_tenant_id", ctx.partner_tenant_id)
        if category:
            q = q.eq("category", category)
        rows = (q.limit(limit * 4).execute().data) or []
        rows.sort(key=lambda r: _TIER_RANK.get(r.get("featured_tier"), 0), reverse=True)
        rows = rows[:limit]
        if not rows:
            return {"vendors": [], "count": 0,
                    "note": "no matching vendors in the catalogue — tell the user honestly, do not invent options"}
        return {
            "vendors": [
                {"id": r["id"], "name": r.get("name"), "category": r.get("category"),
                 "featured_tier": r.get("featured_tier"), "metadata": r.get("metadata")}
                for r in rows
            ],
            "count": len(rows),
        }
    except Exception as e:
        log.warning("search_vendors_failed", error=str(e))
        return {"vendors": [], "error": "vendor lookup failed"}
