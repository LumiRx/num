"""In-car QR landing — logs scan, redirects to WhatsApp deep-link with prefilled START.

TODO(task#post-pilot): replace the WhatsApp redirect with a tiny HTML landing
page that offers WhatsApp / LINE / WeChat choices and reads the user's locale.
"""
from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter
from fastapi.responses import RedirectResponse

from apps.api.services.persistence import log_event
from apps.api.settings import get_settings

router = APIRouter()


@router.get("/qr/{code}")
async def qr_landing(code: str):
    log_event(user_uuid=None, name="qr_scan", payload={"code": code}, source="qr")

    s = get_settings()
    whatsapp_number = (s.TWILIO_WHATSAPP_FROM or "").replace("whatsapp:", "").lstrip("+")
    prefilled = quote(f"START {code}")

    if whatsapp_number:
        return RedirectResponse(url=f"https://wa.me/{whatsapp_number}?text={prefilled}", status_code=302)
    # Fallback: ack the scan so the QR doesn't 404 if Twilio isn't configured yet.
    return {"scanned": code}
