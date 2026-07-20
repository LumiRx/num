"""Liveness probes.

/healthz     — process liveness (Railway healthcheck; no dependencies touched).
/healthz/db  — liveness + one lightweight Supabase read. Point the external
               uptime pinger (e.g. BetterStack, 5-min interval) at THIS path:
               it keeps the Railway dyno warm AND stops free-tier Supabase from
               auto-pausing on idle. Returns 200 with db:"ok" or db:"error"
               (plus 503) so the pinger alerts when the DB is unreachable.
"""
from __future__ import annotations

import structlog
from fastapi import APIRouter, Response

router = APIRouter()
log = structlog.get_logger()


@router.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok"}


@router.get("/healthz/db")
async def healthz_db(response: Response) -> dict:
    from apps.api.deps import get_supabase  # lazy — keep /healthz dependency-free

    try:
        get_supabase().table("partner_tenants").select("id").limit(1).execute()
        return {"status": "ok", "db": "ok"}
    except Exception as e:
        log.warning("healthz_db_failed", error=str(e))
        response.status_code = 503
        return {"status": "ok", "db": "error"}
