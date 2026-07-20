"""LINE Messaging API adapter.

Verifies X-Line-Signature, parses the webhook event list, and posts a reply
via the line-bot-sdk (v3) blocking client. We use the reply token for the
free reply window; push messages would be a separate path.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
from typing import Iterable

import structlog

from apps.api.schemas.messages import IncomingMessage
from apps.api.settings import get_settings

log = structlog.get_logger()


def verify_signature(channel_secret: str, body: bytes, signature: str) -> bool:
    digest = hmac.new(channel_secret.encode("utf-8"), body, hashlib.sha256).digest()
    expected = base64.b64encode(digest).decode("utf-8")
    return hmac.compare_digest(expected, signature or "")


def parse_events(payload: dict) -> Iterable[IncomingMessage]:
    """Yield IncomingMessage for each text message event in the webhook payload."""
    for ev in payload.get("events", []):
        if ev.get("type") != "message":
            continue
        msg = ev.get("message", {})
        if msg.get("type") != "text":
            continue
        source = ev.get("source", {})
        user_id = source.get("userId") or source.get("groupId") or source.get("roomId")
        if not user_id:
            continue
        yield IncomingMessage(
            channel="line",
            handle=user_id,
            text=msg.get("text", ""),
            reply_token=ev.get("replyToken"),
            raw=ev,
        )


def send_reply(reply_token: str, text: str) -> None:
    """Send a reply via LINE's reply API. Lazy-import the SDK so the app
    still boots even if line-bot-sdk pulls in something unexpected."""
    s = get_settings()
    if not s.LINE_CHANNEL_ACCESS_TOKEN:
        log.warning("line_reply_skipped_no_token")
        return
    try:
        from linebot.v3.messaging import (
            ApiClient,
            Configuration,
            MessagingApi,
            ReplyMessageRequest,
            TextMessage,
        )
    except ImportError:
        log.exception("line_bot_sdk_missing")
        return

    cfg = Configuration(access_token=s.LINE_CHANNEL_ACCESS_TOKEN)
    with ApiClient(cfg) as api_client:
        api = MessagingApi(api_client)
        api.reply_message(
            ReplyMessageRequest(
                reply_token=reply_token,
                messages=[TextMessage(text=text)],
            )
        )
