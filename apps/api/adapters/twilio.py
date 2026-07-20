"""Twilio SMS + WhatsApp adapter — parse Form -> IncomingMessage, return TwiML."""
from __future__ import annotations

from twilio.twiml.messaging_response import MessagingResponse

from apps.api.schemas.messages import IncomingMessage


def parse_sms(from_: str, body: str) -> IncomingMessage:
    return IncomingMessage(channel="sms", handle=from_, text=body)


def parse_whatsapp(from_: str, body: str) -> IncomingMessage:
    # Twilio prefixes WhatsApp handles as `whatsapp:+1...` — keep the raw form,
    # the identity service treats it as an opaque handle keyed per channel.
    return IncomingMessage(channel="whatsapp", handle=from_, text=body)


def twiml_reply(text: str) -> str:
    twiml = MessagingResponse()
    twiml.message(text)
    return str(twiml)
