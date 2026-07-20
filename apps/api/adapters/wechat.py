"""WeChat Service Account adapter — verify + parse + reply (plaintext mode, v1).

WeChat Service Accounts speak XML over a single webhook endpoint:

- GET  /wechat/webhook  — one-time handshake: sha1 of sorted [token, timestamp,
  nonce] must equal `signature`; echo `echostr` back on success.
- POST /wechat/webhook  — inbound message/event as an XML body. The same
  signature scheme guards the POST. We reply *passively* by writing an XML
  document back in the HTTP response within WeChat's ~5s window — no outbound
  API call, no access token needed for v1.

We use only stdlib `xml.etree.ElementTree`. Encrypted (AES) mode is intentionally
out of scope for v1; WECHAT_AES_KEY is reserved for a later pass. Keep every
parse path defensive: a malformed body must never raise out of here — callers
fall back to WeChat's "success" no-op sentinel.
"""
from __future__ import annotations

import hashlib
import time
from typing import Callable, Optional
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

import structlog

from apps.api.schemas.messages import IncomingMessage
from apps.api.settings import get_settings

log = structlog.get_logger()

# WeChat's two magic in-band responses for the POST webhook:
#   "success" -> "I handled this, nothing to say" (no-op sentinel)
#   ""        -> also accepted as a silent ack (used for unsubscribe etc.)
SUCCESS = "success"
EMPTY = ""


def verify_signature(
    token: Optional[str],
    signature: str,
    timestamp: str,
    nonce: str,
) -> bool:
    """Core WeChat signature check, shared by the GET handshake and POST webhook.

    The algorithm: sort [token, timestamp, nonce] lexicographically, concatenate,
    sha1-hex, and compare to the provided `signature`. Returns False (never raises)
    when the token is unconfigured or any input is missing.
    """
    if not token:
        log.warning("wechat_signature_skipped_no_token")
        return False
    if not signature or timestamp is None or nonce is None:
        return False
    tmp = "".join(sorted([token, timestamp, nonce]))
    expected = hashlib.sha1(tmp.encode("utf-8")).hexdigest()
    return expected == signature


def verify_handshake(signature: str, timestamp: str, nonce: str) -> bool:
    """GET handshake from WeChat when configuring the webhook URL.

    Thin convenience wrapper that pulls WECHAT_TOKEN from settings and defers to
    `verify_signature`. Kept for the router's GET handler.
    """
    s = get_settings()
    return verify_signature(s.WECHAT_TOKEN, signature, timestamp, nonce)


def _find_text(root: ET.Element, tag: str) -> str:
    """Return the stripped text of a direct child tag, or '' if absent/empty."""
    el = root.find(tag)
    if el is None or el.text is None:
        return ""
    return el.text.strip()


def parse_inbound(body: bytes | str) -> Optional[dict]:
    """Parse a WeChat inbound XML body into a flat dict of its child elements.

    Returns None when the body is empty or not well-formed XML. Never raises.
    Typical text payload::

        <xml>
          <ToUserName><![CDATA[gh_service_account]]></ToUserName>
          <FromUserName><![CDATA[oUserOpenId]]></FromUserName>
          <CreateTime>1700000000</CreateTime>
          <MsgType><![CDATA[text]]></MsgType>
          <Content><![CDATA[hello]]></Content>
          <MsgId>1234567890</MsgId>
        </xml>
    """
    if not body:
        return None
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        log.warning("wechat_xml_parse_error")
        return None

    parsed: dict[str, str] = {}
    for child in root:
        # Flatten one level; CDATA text comes through as plain .text.
        parsed[child.tag] = (child.text or "").strip()
    return parsed


def build_text_reply(to_user: str, from_user: str, content: str) -> str:
    """Build a passive WeChat XML text reply.

    `to_user`/`from_user` are already swapped by the caller relative to the
    inbound message (we reply *to* the sender *from* the service account).
    Content is XML-escaped and wrapped so stray '<', '&', ']]>' can't break the
    document.
    """
    create_time = int(time.time())
    return (
        "<xml>"
        f"<ToUserName><![CDATA[{_cdata(to_user)}]]></ToUserName>"
        f"<FromUserName><![CDATA[{_cdata(from_user)}]]></FromUserName>"
        f"<CreateTime>{create_time}</CreateTime>"
        "<MsgType><![CDATA[text]]></MsgType>"
        f"<Content><![CDATA[{_cdata(content)}]]></Content>"
        "</xml>"
    )


def _cdata(value: str) -> str:
    """Make a string safe to embed inside a CDATA section.

    The only sequence that can terminate CDATA is ']]>'. We split it so the
    payload can never close the section early. Other characters are legal inside
    CDATA verbatim, but we also strip control chars that are invalid in XML 1.0.
    """
    value = value or ""
    value = value.replace("]]>", "]]]]><![CDATA[>")
    # Drop XML-1.0-illegal control characters (keep \t, \n, \r).
    return "".join(
        ch for ch in value if ch in ("\t", "\n", "\r") or ord(ch) >= 0x20
    )


def to_incoming(parsed: dict) -> IncomingMessage:
    """Map a parsed text payload to the channel-agnostic IncomingMessage."""
    return IncomingMessage(
        channel="wechat",
        handle=parsed.get("FromUserName", ""),
        text=parsed.get("Content", ""),
        raw=parsed,
    )


def handle_inbound_xml(body: bytes | str, reply_text_fn: Callable[[IncomingMessage], str]) -> str:
    """Route a WeChat inbound XML body to a passive reply string.

    `reply_text_fn` is the pipeline entrypoint (services.pipeline.handle_inbound):
    given an IncomingMessage it returns the assistant reply text. We keep the call
    synchronous to stay inside WeChat's ~5s passive-reply window.

    Returns the exact string to write back to WeChat:
      - a passive <xml> text reply for text messages and subscribe events,
      - "" for unsubscribe (WeChat just wants a silent ack),
      - "success" for unparseable bodies or unsupported message/event types.

    Any unexpected error is swallowed and turned into "success" so a single bad
    payload can never 500 the webhook.
    """
    try:
        parsed = parse_inbound(body)
        if not parsed:
            return SUCCESS

        from_user = parsed.get("FromUserName", "")
        to_user = parsed.get("ToUserName", "")
        msg_type = (parsed.get("MsgType") or "").lower()

        if msg_type == "text":
            msg = to_incoming(parsed)
            reply = reply_text_fn(msg)
            log.info("wechat_text_in", handle=from_user)
            return build_text_reply(to_user=from_user, from_user=to_user, content=reply)

        if msg_type == "event":
            event = (parsed.get("Event") or "").lower()
            if event == "subscribe":
                # Treat a new follow as a "START" text so acquisition-source
                # binding in the pipeline still fires; reply with whatever the
                # pipeline returns as the welcome.
                msg = IncomingMessage(
                    channel="wechat",
                    handle=from_user,
                    text="START",
                    raw=parsed,
                )
                reply = reply_text_fn(msg)
                log.info("wechat_subscribe", handle=from_user)
                return build_text_reply(to_user=from_user, from_user=to_user, content=reply)
            if event == "unsubscribe":
                # User left; WeChat accepts an empty ack. Nothing to send.
                log.info("wechat_unsubscribe", handle=from_user)
                return EMPTY
            # Other events (CLICK, SCAN, LOCATION, ...) are no-ops for v1.
            log.info("wechat_event_unsupported", event=event, handle=from_user)
            return SUCCESS

        # Non-text content (image/voice/location/...) is unsupported in v1.
        log.info("wechat_msgtype_unsupported", msg_type=msg_type, handle=from_user)
        return SUCCESS
    except Exception:  # noqa: BLE001 — never let the webhook 500
        log.exception("wechat_inbound_failed")
        return SUCCESS
