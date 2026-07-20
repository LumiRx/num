"""LINE inbound webhook."""
from __future__ import annotations

import structlog
from fastapi import APIRouter, HTTPException, Header, Request

from apps.api.adapters import line as line_adapter
from apps.api.services.pipeline import handle_inbound
from apps.api.settings import get_settings

router = APIRouter()
log = structlog.get_logger()


@router.post("/line/webhook")
async def line_webhook(request: Request, x_line_signature: str | None = Header(default=None)):
    s = get_settings()
    body = await request.body()

    if s.LINE_CHANNEL_SECRET:
        if not line_adapter.verify_signature(s.LINE_CHANNEL_SECRET, body, x_line_signature or ""):
            log.warning("line_signature_invalid")
            raise HTTPException(status_code=403, detail="invalid signature")
    else:
        log.warning("line_signature_skipped_unconfigured")

    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON")

    for msg in line_adapter.parse_events(payload):
        reply = handle_inbound(msg)
        if msg.reply_token:
            line_adapter.send_reply(msg.reply_token, reply)

    return {"status": "ok"}
