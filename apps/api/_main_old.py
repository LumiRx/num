"""
NUM — FastAPI entry point.

Path A (minimal) deployable in an afternoon. Path B (pilot-ready) hooks
for multi-channel adapters, multi-tenant scoping, vector memory, and
encrypted PII are stubbed below and marked with TODO(PathB).

Run locally:
    uvicorn main:app --reload --port 8000

Deploy on Railway:
    Procfile -> `web: uvicorn main:app --host 0.0.0.0 --port $PORT`
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Optional

import structlog
from anthropic import Anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import PlainTextResponse, RedirectResponse
from pydantic import BaseModel
from supabase import Client, create_client
from twilio.twiml.messaging_response import MessagingResponse

# --------------------------------------------------------------------
# Bootstrap
# --------------------------------------------------------------------
load_dotenv()

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = structlog.get_logger()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
CLAUDE_MODEL_CHAT = os.getenv("CLAUDE_MODEL_CHAT", "claude-sonnet-4-6")
CLAUDE_MODEL_FAST = os.getenv("CLAUDE_MODEL_FAST", "claude-haiku-4-5-20251001")
DEFAULT_TENANT_ID = os.getenv("DEFAULT_PARTNER_TENANT_ID")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
claude = Anthropic(api_key=ANTHROPIC_API_KEY)

with open(os.path.join(os.path.dirname(__file__), "system_prompt.txt"), "r") as f:
    SYSTEM_PROMPT_TEMPLATE = f.read()


# --------------------------------------------------------------------
# Normalized inbound message (channel-agnostic)
# --------------------------------------------------------------------
class IncomingMessage(BaseModel):
    channel: str                     # 'whatsapp' | 'sms' | 'line' | 'wechat' | 'web'
    handle: str                      # phone, line userId, wechat openid
    text: str
    raw: Optional[dict] = None


# --------------------------------------------------------------------
# Identity service
# --------------------------------------------------------------------
def upsert_user_by_handle(msg: IncomingMessage) -> dict:
    """
    Look up (or create) a user_uuid for this channel+handle.
    Path A: writes to `users` (phone-keyed minimal schema).
    Path B: writes to `users` + `channel_identities` (multi-channel UUID schema).
    """
    # --- Path A (minimal) -------------------------------------------
    existing = (
        supabase.table("users")
        .select("*")
        .eq("phone_number", msg.handle)
        .execute()
    )
    if existing.data:
        return existing.data[0]

    # New user — extract acquisition source from `START car_PHK_017` style first message
    acq = _parse_acquisition_source(msg.text)
    inserted = (
        supabase.table("users")
        .insert(
            {
                "phone_number": msg.handle,
                "platform": msg.channel,
                "acquisition_source": acq or "organic",
            }
        )
        .execute()
    )
    log.info("user_created", handle=msg.handle, channel=msg.channel, source=acq)
    return inserted.data[0]


def _parse_acquisition_source(text: str) -> Optional[str]:
    t = text.strip()
    upper = t.upper()
    if upper.startswith("START "):
        parts = t.split(maxsplit=1)
        if len(parts) == 2:
            return parts[1].strip()
    if "START-" in upper:
        # legacy "START-CAR12" format
        return upper.split("START-", 1)[1].split()[0]
    return None


# --------------------------------------------------------------------
# Intent router (Haiku — cheap, fast)
# --------------------------------------------------------------------
INTENT_ROUTER_PROMPT = """Classify the user's intent into exactly one of:
TOURIST | WHALE_LEAD | BOOKING_INTENT | SUPPORT | SMALLTALK | PARTNER_COMMAND

Respond with ONLY the label, nothing else.

Message: {message}"""


def classify_intent(text: str) -> str:
    try:
        resp = claude.messages.create(
            model=CLAUDE_MODEL_FAST,
            max_tokens=10,
            messages=[{"role": "user", "content": INTENT_ROUTER_PROMPT.format(message=text)}],
        )
        label = resp.content[0].text.strip().upper()
        if label not in {
            "TOURIST",
            "WHALE_LEAD",
            "BOOKING_INTENT",
            "SUPPORT",
            "SMALLTALK",
            "PARTNER_COMMAND",
        }:
            label = "TOURIST"
        return label
    except Exception as e:  # pragma: no cover
        log.warning("intent_router_failed", error=str(e))
        return "TOURIST"


# --------------------------------------------------------------------
# Concierge Agent (Sonnet — chat with tool use)
# --------------------------------------------------------------------
def build_system_prompt(user: dict, retrieved_memories: list[str] | None = None) -> str:
    mem_block = "\n".join(f"- {m}" for m in (retrieved_memories or [])) or "(no stored memories yet)"
    return (
        SYSTEM_PROMPT_TEMPLATE
        .replace("{{user_display_name or \"this guest\"}}", "this guest")
        .replace("{{user_uuid}}", str(user.get("id", "")))
        .replace("{{user.preferred_lang}}", user.get("preferred_lang", "en"))
        .replace("{{retrieved_memories_block}}", mem_block)
        .replace("{{current_trip_block_if_any}}", "(none)")
    )


def generate_concierge_reply(user: dict, user_message: str) -> str:
    """
    Path A: simple single-turn call with the system prompt.
    Path B: TODO — add tool use (lookup_user_memory, save_user_memory, search_vendors,
            create_lead, create_booking, escalate_to_human), retrieval before the call,
            and structured memory writes after.
    """
    # TODO(PathB): retrieved = memory.lookup(user_uuid, query=user_message, k=5)
    retrieved: list[str] = []

    system_prompt = build_system_prompt(user, retrieved)
    try:
        resp = claude.messages.create(
            model=CLAUDE_MODEL_CHAT,
            max_tokens=600,
            system=system_prompt,
            messages=[{"role": "user", "content": user_message}],
        )
        return resp.content[0].text.strip()
    except Exception as e:
        log.exception("concierge_call_failed", error=str(e))
        return (
            "I'm having trouble reaching my brain right now — try me again in a minute. "
            "If it's urgent, reply HUMAN and someone will jump in."
        )


# --------------------------------------------------------------------
# Persistence: log every turn for audit + future fine-tuning
# --------------------------------------------------------------------
def log_message(user_id: str, role: str, content: str) -> None:
    try:
        supabase.table("messages").insert(
            {"user_id": user_id, "role": role, "content": content}
        ).execute()
    except Exception as e:  # never let logging break the response path
        log.warning("message_log_failed", error=str(e))


def log_event(user_id: str | None, name: str, payload: dict | None = None) -> None:
    try:
        supabase.table("events").insert(
            {"user_id": user_id, "name": name, "payload": payload or {}}
        ).execute()
    except Exception as e:
        log.warning("event_log_failed", error=str(e))


# --------------------------------------------------------------------
# Core handler — channel-agnostic
# --------------------------------------------------------------------
def handle_inbound(msg: IncomingMessage) -> str:
    user = upsert_user_by_handle(msg)
    user_id = user["id"]

    log_message(user_id, "user", msg.text)
    log_event(user_id, "message_in", {"channel": msg.channel})

    intent = classify_intent(msg.text)
    log_event(user_id, "intent_classified", {"intent": intent})

    reply = generate_concierge_reply(user, msg.text)
    log_message(user_id, "assistant", reply)

    return reply


# --------------------------------------------------------------------
# FastAPI app
# --------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("num_starting", model_chat=CLAUDE_MODEL_CHAT, model_fast=CLAUDE_MODEL_FAST)
    yield
    log.info("num_shutdown")


app = FastAPI(title="NUM — AI Concierge", lifespan=lifespan)


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


# ----- Twilio: SMS + WhatsApp ---------------------------------------
@app.post("/sms")
async def twilio_sms(From: str = Form(...), Body: str = Form(...)):
    """
    Inbound webhook for Twilio SMS. WhatsApp inbound also lands here when
    configured on the Twilio messaging service. Returns TwiML.
    """
    msg = IncomingMessage(channel="sms", handle=From, text=Body)
    reply = handle_inbound(msg)

    twiml = MessagingResponse()
    twiml.message(reply)
    return PlainTextResponse(content=str(twiml), media_type="application/xml")


@app.post("/whatsapp")
async def twilio_whatsapp(From: str = Form(...), Body: str = Form(...)):
    msg = IncomingMessage(channel="whatsapp", handle=From, text=Body)
    reply = handle_inbound(msg)

    twiml = MessagingResponse()
    twiml.message(reply)
    return PlainTextResponse(content=str(twiml), media_type="application/xml")


# ----- LINE Messaging API -------------------------------------------
@app.post("/line/webhook")
async def line_webhook(request: Request):
    """
    LINE inbound webhook. Validates X-Line-Signature in production.
    TODO(PathB): implement LineAdapter.parse(request) -> IncomingMessage
    and use line-bot-sdk to reply via push/reply token.
    """
    body = await request.json()
    log.info("line_inbound_stub", body=body)
    # placeholder so LINE accepts the webhook during setup
    return {"status": "received"}


# ----- WeChat Service Account ---------------------------------------
@app.post("/wechat/webhook")
async def wechat_webhook(request: Request):
    """
    WeChat inbound webhook. Verifies signature on GET, processes XML on POST.
    TODO(PathB): implement WeChatAdapter (wechatpy) -> IncomingMessage and
    reply via service-account API within the 48h customer-service window.
    """
    body = await request.body()
    log.info("wechat_inbound_stub", size=len(body))
    return PlainTextResponse(content="success")  # WeChat requires literal 'success'


@app.get("/wechat/webhook")
async def wechat_verify(signature: str = "", timestamp: str = "", nonce: str = "", echostr: str = ""):
    # WeChat verification handshake — return echostr if signature checks out.
    # TODO(PathB): verify signature against WECHAT_TOKEN.
    return PlainTextResponse(content=echostr)


# ----- In-car QR landing --------------------------------------------
@app.get("/qr/{code}")
async def qr_landing(code: str):
    """
    Each in-car screen renders a QR pointing at /qr/<vehicle_code>.
    We log the scan, then redirect to the user's preferred chat channel
    with a pre-filled `START <code>` message.

    TODO(PathB): look up the acquisition_source row to confirm code is active
    and partner_tenant_id is correct; render a tiny landing page that offers
    WhatsApp / LINE / WeChat choices instead of defaulting to WhatsApp.
    """
    log_event(user_id=None, name="qr_scan", payload={"code": code})

    # Default to WhatsApp deep-link; adapt per-vehicle if you store preferred channel.
    whatsapp_number = os.getenv("TWILIO_WHATSAPP_FROM", "").replace("whatsapp:", "")
    prefilled = f"START {code}"
    wa_link = f"https://wa.me/{whatsapp_number.lstrip('+')}?text={prefilled.replace(' ', '%20')}"
    return RedirectResponse(url=wa_link, status_code=302)


# ----- Local dev entrypoint -----------------------------------------
if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")), reload=True)
