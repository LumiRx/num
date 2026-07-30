"""Twilio SMS + WhatsApp adapter — verify, parse Form -> IncomingMessage, TwiML.

Signature check: Twilio HMAC-SHA1s (full URL + sorted POST params) with your
auth token and sends it as `X-Twilio-Signature`. Verifying it is what stops a
stranger who guesses the webhook URL from fabricating passengers and burning
LLM budget. Mirrors the HMAC check LINE already does.
"""
from __future__ import annotations

import structlog
from twilio.request_validator import RequestValidator
from twilio.twiml.messaging_response import MessagingResponse

from apps.api.schemas.messages import IncomingMessage, MediaItem
from apps.api.settings import get_settings

log = structlog.get_logger()

# A guest sending 30 photos shouldn't be able to make us fetch 30 files.
_MAX_MEDIA_PER_MESSAGE = 10


def verify_request(request, params: dict) -> bool:
    """True if `X-Twilio-Signature` matches. Never raises.

    Fails **open** only when TWILIO_AUTH_TOKEN is unset (local dev / tests) —
    logged loudly so it can't silently ship that way. Once the token is set in
    Railway, unsigned requests are rejected.
    """
    token = get_settings().TWILIO_AUTH_TOKEN
    if not token:
        log.warning("twilio_signature_skipped_no_token")
        return True

    try:
        signature = request.headers.get("X-Twilio-Signature", "")
        if not signature:
            return False
        # Twilio signs the URL it called. Railway terminates TLS at the proxy,
        # so the app sees http:// — rebuild the https:// form Twilio used.
        url = str(request.url)
        forwarded_proto = request.headers.get("x-forwarded-proto")
        if forwarded_proto == "https" and url.startswith("http://"):
            url = "https://" + url[len("http://"):]
        return RequestValidator(token).validate(url, params, signature)
    except Exception as e:  # never let verification crash the webhook
        log.warning("twilio_signature_check_failed", error=str(e))
        return False


def parse_media(form: dict) -> list[MediaItem]:
    """Extract attachments from a Twilio webhook form.

    Twilio posts `NumMedia` plus indexed `MediaUrl{n}` / `MediaContentType{n}`
    pairs. Those URLs are temporary and require HTTP Basic auth with the
    account SID + auth token — they are NOT publicly fetchable, so
    services.media re-hosts the bytes before anything else touches them.

    Defensive: a malformed or oversized media block yields fewer items rather
    than raising. A photo failing to parse must never cost the user their reply.
    """
    try:
        n = int(form.get("NumMedia") or 0)
    except (TypeError, ValueError):
        return []
    if n <= 0:
        return []

    items: list[MediaItem] = []
    for i in range(min(n, _MAX_MEDIA_PER_MESSAGE)):
        url = (form.get(f"MediaUrl{i}") or "").strip()
        ctype = (form.get(f"MediaContentType{i}") or "").strip()
        if not url or not ctype:
            continue
        items.append(MediaItem(url=url, content_type=ctype, provider_sid=url.rsplit("/", 1)[-1] or None))
    if n > _MAX_MEDIA_PER_MESSAGE:
        log.warning("twilio_media_truncated", received=n, kept=_MAX_MEDIA_PER_MESSAGE)
    return items


def parse_sms(from_: str, body: str, form: dict | None = None) -> IncomingMessage:
    return IncomingMessage(
        channel="sms", handle=from_, text=body,
        media=parse_media(form or {}),
    )


def parse_whatsapp(from_: str, body: str, form: dict | None = None) -> IncomingMessage:
    # Twilio prefixes WhatsApp handles as `whatsapp:+1...` — keep the raw form,
    # the identity service treats it as an opaque handle keyed per channel.
    return IncomingMessage(
        channel="whatsapp", handle=from_, text=body,
        media=parse_media(form or {}),
    )


def twiml_reply(text: str) -> str:
    twiml = MessagingResponse()
    twiml.message(text)
    return str(twiml)
