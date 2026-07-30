"""Inbound media capture — fetch from the provider, re-host, record.

Why this exists: a guest or a fleet owner sends a photo in chat ("here's the
car at handover"). Twilio hands us a temporary, auth-gated URL that expires —
useless as a record. This service fetches the bytes once, validates them,
stores them in our own bucket, and writes a durable `media_assets` row.

Hard rules, in order of importance:

1. **Never trust the provider's content-type alone.** We sniff the actual
   magic bytes. A file claiming `image/jpeg` that is really something else
   gets rejected — that's how you stop a storage bucket becoming a malware host.
2. **Never trust a supplied filename.** Storage keys are generated from a UUID.
3. **Size ceiling** before we write anything.
4. **Never break the reply.** Every failure path returns fewer stored assets,
   never an exception. A photo that fails to store must not cost the user
   their answer — the concierge still replies.
"""
from __future__ import annotations

import uuid
from typing import Optional

import structlog

from apps.api.deps import get_supabase
from apps.api.schemas.messages import MediaItem
from apps.api.settings import get_settings

log = structlog.get_logger()

BUCKET = "chat-media"
MAX_BYTES = 8 * 1024 * 1024          # 8 MB — WhatsApp caps well below this

# Only images. Documents/audio/video are a different risk and product surface;
# add them deliberately, not by accident.
ALLOWED = {
    "image/jpeg": (b"\xff\xd8\xff", "jpg"),
    "image/png":  (b"\x89PNG\r\n\x1a\n", "png"),
    "image/webp": (b"RIFF", "webp"),
    "image/heic": (b"\x00\x00\x00", "heic"),   # HEIC ftyp box; loose by design
}


def _sniff_ok(declared: str, blob: bytes) -> bool:
    """True if the bytes actually look like the declared image type."""
    entry = ALLOWED.get(declared.lower().split(";")[0].strip())
    if not entry:
        return False
    magic, _ = entry
    if declared.lower().startswith("image/heic"):
        # HEIC's signature sits at offset 4 ('ftyp'); accept on that marker.
        return b"ftyp" in blob[:32]
    return blob.startswith(magic)


def _extension(content_type: str) -> str:
    entry = ALLOWED.get(content_type.lower().split(";")[0].strip())
    return entry[1] if entry else "bin"


def _fetch(item: MediaItem) -> Optional[bytes]:
    """Download from the provider. Twilio media needs Basic auth. Never raises."""
    s = get_settings()
    try:
        import httpx

        auth = None
        if "twilio.com" in item.url and s.TWILIO_ACCOUNT_SID and s.TWILIO_AUTH_TOKEN:
            auth = (s.TWILIO_ACCOUNT_SID, s.TWILIO_AUTH_TOKEN)

        with httpx.Client(timeout=15.0, follow_redirects=True) as c:
            r = c.get(item.url, auth=auth)
            r.raise_for_status()
            blob = r.content

        if len(blob) > MAX_BYTES:
            log.warning("media_too_large", bytes=len(blob), limit=MAX_BYTES)
            return None
        if not blob:
            return None
        return blob
    except Exception as e:
        log.warning("media_fetch_failed", error=str(e))
        return None


def store_media(
    items: list[MediaItem],
    user_uuid: str,
    message_id: Optional[str] = None,
    conversation_id: Optional[str] = None,
    purpose: str = "chat",
) -> list[dict]:
    """Fetch, validate and persist inbound media. Returns the rows created.

    `purpose` tags what the photo is for — 'chat' by default, 'vehicle_record'
    when a fleet owner is documenting a car. Tagging at capture time is what
    makes the record searchable later without re-reading images.

    Never raises: returns [] if everything fails.
    """
    if not items:
        return []

    stored: list[dict] = []
    sb = get_supabase()

    for item in items:
        if not item.is_image:
            log.info("media_skipped_not_image", content_type=item.content_type)
            continue

        blob = _fetch(item)
        if blob is None:
            continue

        if not _sniff_ok(item.content_type, blob):
            # Declared type doesn't match the actual bytes — drop it.
            log.warning("media_rejected_type_mismatch", declared=item.content_type)
            continue

        key = f"{user_uuid}/{uuid.uuid4().hex}.{_extension(item.content_type)}"

        try:
            sb.storage.from_(BUCKET).upload(
                key, blob, {"content-type": item.content_type, "upsert": "false"}
            )
        except Exception as e:
            log.warning("media_upload_failed", error=str(e))
            continue

        try:
            res = sb.table("media_assets").insert({
                "user_uuid": user_uuid,
                "message_id": message_id,
                "conversation_id": conversation_id,
                "storage_key": key,
                "content_type": item.content_type,
                "size_bytes": len(blob),
                "purpose": purpose,
                "provider_sid": item.provider_sid,
            }).execute()
            row = (res.data or [{}])[0]
            row["storage_key"] = key
            stored.append(row)
            log.info("media_stored", key=key, bytes=len(blob), purpose=purpose)
        except Exception as e:
            log.warning("media_record_failed", error=str(e))

    return stored


def attach_to_vehicle(media_asset_id: str, vehicle_id: str, kind: str = "condition") -> bool:
    """Link a stored photo to a vehicle record.

    `kind`: 'listing' (marketing photos) | 'condition' (handover/return
    documentation) | 'damage'. Condition photos are the ones that matter in a
    dispute — they're timestamped at capture and immutable once written.
    """
    try:
        get_supabase().table("vehicle_photos").insert({
            "vehicle_id": vehicle_id,
            "media_asset_id": media_asset_id,
            "kind": kind,
        }).execute()
        return True
    except Exception as e:
        log.warning("vehicle_photo_link_failed", error=str(e))
        return False
