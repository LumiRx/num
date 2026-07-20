"""WeChat Service Account inbound — GET handshake + POST passive message reply.

WeChat uses one URL for both the config-time handshake (GET, echo `echostr`) and
the runtime message stream (POST, XML in / XML or "success" out). All signature,
parse, and reply logic lives in adapters.wechat; this router is a thin transport
shell that mirrors routers/line.py and routers/twilio.py.
"""
from __future__ import annotations

import structlog
from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse

from apps.api.adapters import wechat as wechat_adapter
from apps.api.services.pipeline import handle_inbound

router = APIRouter()
log = structlog.get_logger()


@router.get("/wechat/webhook")
async def wechat_verify(
    signature: str = "",
    timestamp: str = "",
    nonce: str = "",
    echostr: str = "",
):
    """Config-time handshake: echo `echostr` iff the sha1 signature checks out."""
    if wechat_adapter.verify_handshake(signature, timestamp, nonce):
        return PlainTextResponse(content=echostr)
    log.warning("wechat_handshake_invalid")
    return PlainTextResponse(content="forbidden", status_code=403)


@router.post("/wechat/webhook")
async def wechat_inbound(
    request: Request,
    signature: str = "",
    timestamp: str = "",
    nonce: str = "",
):
    """Runtime inbound: verify the signature, route the XML, return a passive reply.

    WeChat always expects HTTP 200 here — even on rejection we return the "success"
    sentinel rather than an error status, so a bad/spoofed payload never trips
    WeChat's retry-and-disable behaviour.
    """
    body = await request.body()

    s = wechat_adapter.get_settings()
    if s.WECHAT_TOKEN:
        if not wechat_adapter.verify_signature(s.WECHAT_TOKEN, signature, timestamp, nonce):
            log.warning("wechat_signature_invalid")
            return PlainTextResponse(content=wechat_adapter.SUCCESS)
    else:
        log.warning("wechat_signature_skipped_unconfigured")

    reply_xml = wechat_adapter.handle_inbound_xml(body, handle_inbound)
    # Passive reply is XML; the "success"/"" sentinels are plain text but WeChat
    # accepts them under the same content type.
    return PlainTextResponse(content=reply_xml, media_type="application/xml")
