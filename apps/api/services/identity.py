"""Identity service — channel handle <-> user_uuid binding.

Path B schema:
    users.user_uuid              (PK)
    channel_identities (channel, handle) -> user_uuid
"""
from __future__ import annotations

import re
from typing import Optional

import structlog

from apps.api.deps import get_supabase
from apps.api.schemas.messages import IncomingMessage
from apps.api.settings import get_settings

log = structlog.get_logger()


def _parse_acquisition_source(text: str) -> Optional[str]:
    """Extract `START <code>` or `START-<code>` from the first message."""
    if not text:
        return None
    t = text.strip()
    upper = t.upper()
    if upper.startswith("START "):
        parts = t.split(maxsplit=1)
        if len(parts) == 2:
            return parts[1].strip()
    m = re.match(r"^START[-_]([A-Za-z0-9_]+)", upper)
    if m:
        return m.group(1)
    return None


def upsert_user_by_handle(msg: IncomingMessage) -> dict:
    """Return the user row, creating one if this (channel, handle) is new."""
    sb = get_supabase()
    s = get_settings()

    existing = (
        sb.table("channel_identities")
        .select("user_uuid, channel, handle, verified_at, users(*)")
        .eq("channel", msg.channel)
        .eq("handle", msg.handle)
        .limit(1)
        .execute()
    )
    if existing.data:
        row = existing.data[0]
        return row["users"]

    # New identity. Create user row first, then channel_identity binding.
    acq = _parse_acquisition_source(msg.text)
    tenant_id = _resolve_tenant_id(acq) or s.DEFAULT_PARTNER_TENANT_ID

    user_insert = (
        sb.table("users")
        .insert(
            {
                "partner_tenant_id": tenant_id,
                "acquisition_source": acq,
                "lifecycle_stage": "new",
            }
        )
        .execute()
    )
    user = user_insert.data[0]
    user_uuid = user["user_uuid"]

    sb.table("channel_identities").insert(
        {"user_uuid": user_uuid, "channel": msg.channel, "handle": msg.handle}
    ).execute()

    # Seed an empty profile row so future updates can do `.upsert(...)`.
    sb.table("user_profile").insert({"user_uuid": user_uuid, "profile_json": {}}).execute()

    log.info(
        "user_created",
        user_uuid=user_uuid,
        channel=msg.channel,
        acquisition_source=acq,
        partner_tenant_id=tenant_id,
    )
    # In-memory marker (never persisted): lets the pipeline attach the one-time
    # PDPA consent notice to this user's very first reply.
    user["_is_new"] = True
    return user


def update_preferred_lang(user_uuid: str, lang: str) -> None:
    """Persist a freshly detected preferred language. Best-effort, never raises."""
    try:
        get_supabase().table("users").update({"preferred_lang": lang}).eq(
            "user_uuid", user_uuid
        ).execute()
    except Exception as e:
        log.warning("preferred_lang_update_failed", error=str(e))


def _resolve_tenant_id(acquisition_code: Optional[str]) -> Optional[str]:
    """Look up the partner_tenant_id from the acquisition_sources table."""
    if not acquisition_code:
        return None
    sb = get_supabase()
    row = (
        sb.table("acquisition_sources")
        .select("partner_tenant_id")
        .eq("code", acquisition_code)
        .eq("active", True)
        .limit(1)
        .execute()
    )
    if row.data:
        return row.data[0]["partner_tenant_id"]
    return None
