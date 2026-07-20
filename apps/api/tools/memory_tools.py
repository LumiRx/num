"""Tool: save_user_memory — persist a durable fact about the user."""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Optional

import structlog

from apps.api.services import memory

log = structlog.get_logger()

_REL = re.compile(r"^\+(\d+)([dwmy])$")
_UNIT_DAYS = {"d": 1, "w": 7, "m": 30, "y": 365}


def _parse_expires(expires_at) -> Optional[datetime]:
    """Accept '+30d' / '+2w' / '+6m' relative forms or an ISO datetime/date."""
    if not expires_at:
        return None
    s = str(expires_at).strip()
    m = _REL.match(s)
    if m:
        return datetime.now(timezone.utc) + timedelta(days=int(m.group(1)) * _UNIT_DAYS[m.group(2)])
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        log.debug("expires_parse_failed", value=s)
        return None


def save_user_memory(ctx, fact: str, tags: Optional[list] = None,
                     confidence: float = 0.8, expires_at=None) -> dict:
    try:
        memory.save(
            ctx.user_uuid,
            fact,
            tags=tags or [],
            confidence=confidence,
            expires_at=_parse_expires(expires_at),
        )
        return {"saved": True}
    except Exception as e:
        log.warning("save_user_memory_failed", error=str(e))
        return {"saved": False}
