"""Normalised channel-agnostic message types."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel

Channel = Literal["whatsapp", "sms", "line", "wechat", "web"]


class MediaItem(BaseModel):
    """One media attachment on an inbound message.

    `url` is the PROVIDER's temporary URL (Twilio's expires and requires HTTP
    Basic auth with the account SID/token — it is not publicly fetchable).
    Nothing downstream should treat it as durable: services.media fetches it
    once and re-hosts the bytes in our own storage, then records the permanent
    location. `content_type` comes from the provider and is validated before
    we ever write the file.
    """

    url: str
    content_type: str
    provider_sid: Optional[str] = None   # Twilio MediaSid, for dedupe/audit

    @property
    def is_image(self) -> bool:
        return self.content_type.lower().startswith("image/")


class IncomingMessage(BaseModel):
    """Normalised inbound message — all channel adapters emit this."""

    channel: Channel
    handle: str                       # phone (E.164), LINE userId, WeChat openid
    text: str
    media: list[MediaItem] = []       # photos etc. — empty for text-only messages
    raw: Optional[dict] = None        # original webhook payload, for audit
    reply_token: Optional[str] = None # LINE reply token (one-shot)

    @property
    def has_media(self) -> bool:
        return bool(self.media)


class OutgoingMessage(BaseModel):
    text: str
    channel: Channel
    handle: str
    reply_token: Optional[str] = None
