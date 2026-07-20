"""Twilio inbound — /sms and /whatsapp."""
from __future__ import annotations

from fastapi import APIRouter, Form
from fastapi.responses import PlainTextResponse

from apps.api.adapters import twilio as twilio_adapter
from apps.api.services.pipeline import handle_inbound

router = APIRouter()


@router.post("/sms")
async def twilio_sms(From: str = Form(...), Body: str = Form(...)):
    msg = twilio_adapter.parse_sms(From, Body)
    reply = handle_inbound(msg)
    return PlainTextResponse(content=twilio_adapter.twiml_reply(reply), media_type="application/xml")


@router.post("/whatsapp")
async def twilio_whatsapp(From: str = Form(...), Body: str = Form(...)):
    msg = twilio_adapter.parse_whatsapp(From, Body)
    reply = handle_inbound(msg)
    return PlainTextResponse(content=twilio_adapter.twiml_reply(reply), media_type="application/xml")
