"""Normalised channel-agnostic message types."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel

Channel = Literal["whatsapp", "sms", "line", "wechat", "web"]


class IncomingMessage(BaseModel):
    """Normalised inbound message — all channel adapters emit this."""

    channel: Channel
    handle: str                       # phone (E.164), LINE userId, WeChat openid
    text: str
    raw: Optional[dict] = None        # original webhook payload, for audit
    reply_token: Optional[str] = None # LINE reply token (one-shot)


class OutgoingMessage(BaseModel):
    text: str
    channel: Channel
    handle: str
    reply_token: Optional[str] = None
