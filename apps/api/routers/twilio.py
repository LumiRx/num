"""Twilio inbound — /sms and /whatsapp.

Handlers are deliberately **sync `def`**, not `async def`. The pipeline below
them uses blocking SDK clients (Anthropic, Supabase). A blocking call inside an
`async def` route occupies the event loop and serialises every other in-flight
request; declaring the route sync makes FastAPI run it in its threadpool, so
concurrent passengers are actually served concurrently. Same reasoning in the
LINE and WeChat routers.

Every request is signature-verified (Twilio signs with your auth token) before
it reaches the pipeline — an unsigned POST to this URL would otherwise be able
to fabricate conversations and spend LLM budget.
"""
from __future__ import annotations

import structlog
from fastapi import APIRouter, Form, Request
from fastapi.responses import PlainTextResponse

from apps.api.adapters import twilio as twilio_adapter
from apps.api.services.pipeline import handle_inbound_safe

router = APIRouter()
log = structlog.get_logger()

# Twilio treats any 2xx as delivered. On rejection we return empty TwiML rather
# than a 403 so a probing scanner learns nothing and Twilio never retries.
_EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'


def _reject(reason: str) -> PlainTextResponse:
    log.warning("twilio_request_rejected", reason=reason)
    return PlainTextResponse(content=_EMPTY_TWIML, media_type="application/xml")


@router.post("/sms")
def twilio_sms(request: Request, From: str = Form(...), Body: str = Form(...)):
    if not twilio_adapter.verify_request(request, {"From": From, "Body": Body}):
        return _reject("bad_signature_sms")
    msg = twilio_adapter.parse_sms(From, Body)
    reply = handle_inbound_safe(msg)
    return PlainTextResponse(content=twilio_adapter.twiml_reply(reply), media_type="application/xml")


@router.post("/whatsapp")
def twilio_whatsapp(request: Request, From: str = Form(...), Body: str = Form(...)):
    if not twilio_adapter.verify_request(request, {"From": From, "Body": Body}):
        return _reject("bad_signature_whatsapp")
    msg = twilio_adapter.parse_whatsapp(From, Body)
    reply = handle_inbound_safe(msg)
    return PlainTextResponse(content=twilio_adapter.twiml_reply(reply), media_type="application/xml")
