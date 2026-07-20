"""PDPA privacy service — consent audit trail + right-to-erasure.

Two jobs:

1. `is_delete_request(text)` — detect an explicit erasure request. Whole-message
   match only (case/whitespace-insensitive), so "can you delete that restaurant"
   never triggers it. Covers the pilot languages.

2. `delete_user_data(user_uuid)` — execute the erasure against Supabase:
     a. write a `consent_events` audit row FIRST (table has no FK to users, so
        the trail survives the deletion; a bare UUID is not personal data once
        every linked record is gone),
     b. anonymize business records we retain (leads / bookings / llm_usage —
        transactional + spend aggregates, stripped of the user link),
     c. delete behavioral `events` rows,
     d. delete the `users` row — ON DELETE CASCADE wipes channel_identities,
        user_profile, user_profile_secure, conversations, messages, memories.

`log_consent(...)` records the disclosure/grant events ("notice_shown" on first
contact; "withdrawn+deleted" on erasure). See migration 0006_consent_events.
"""
from __future__ import annotations

from typing import Optional

import structlog

from apps.api.deps import get_supabase

log = structlog.get_logger()

CONSENT_VERSION = "2026-07-17.v1"

# Whole-message triggers, compared casefolded with whitespace collapsed.
_DELETE_TRIGGERS = {
    # English
    "delete", "delete my data", "delete me", "erase my data", "forget me",
    # Thai
    "ลบข้อมูล", "ลบข้อมูลของฉัน", "ลบข้อมูลฉัน",
    # Chinese (simplified + traditional)
    "删除我的数据", "删除数据", "刪除我的資料", "刪除資料",
    # Russian
    "удалить", "удали мои данные", "удалить мои данные",
    # Japanese
    "データ削除", "データを削除", "削除して",
    # Korean
    "데이터 삭제", "내 데이터 삭제", "삭제해줘",
    # German / French / Spanish
    "lösche meine daten", "daten löschen",
    "supprimer mes données", "supprime mes données",
    "borra mis datos", "eliminar mis datos",
}


def is_delete_request(text: Optional[str]) -> bool:
    """True iff the whole message is an explicit data-erasure request."""
    if not text:
        return False
    normalized = " ".join(text.split()).casefold().strip(".!?。!? ")
    return normalized in _DELETE_TRIGGERS


def log_consent(
    user_uuid: Optional[str],
    action: str,
    channel: Optional[str] = None,
    lang: Optional[str] = None,
) -> None:
    """Append a consent audit event. Best-effort — never crashes the pipeline.

    Actions used today: 'notice_shown' (first-contact disclosure) and
    'withdrawn' / 'deleted' (erasure flow).
    """
    try:
        get_supabase().table("consent_events").insert(
            {
                "user_uuid": user_uuid,
                "action": action,
                "channel": channel,
                "lang": lang,
                "version": CONSENT_VERSION,
            }
        ).execute()
    except Exception as e:
        log.warning("consent_log_failed", action=action, error=str(e))


def delete_user_data(user_uuid: str, channel: Optional[str] = None) -> bool:
    """Erase a user under PDPA right-to-erasure. Returns True on success.

    Retention decisions (documented for the DPA):
    - leads / bookings keep the business record but drop the user link.
    - llm_usage keeps anonymized spend aggregates (user + conversation nulled;
      conversation rows are cascade-deleted with the user).
    - consent_events keeps the audit trail (no FK; bare UUID only).
    - Everything else linked to the user is deleted (cascade from `users`).
    """
    sb = get_supabase()
    try:
        # (a) audit first — if the rest fails we still know they asked.
        log_consent(user_uuid, "withdrawn", channel=channel)

        # (b) anonymize retained business records.
        sb.table("llm_usage").update(
            {"user_uuid": None, "conversation_id": None}
        ).eq("user_uuid", user_uuid).execute()
        sb.table("leads").update({"user_uuid": None}).eq("user_uuid", user_uuid).execute()
        sb.table("bookings").update({"user_uuid": None}).eq("user_uuid", user_uuid).execute()

        # (c) behavioral events go entirely.
        sb.table("events").delete().eq("user_uuid", user_uuid).execute()

        # (d) the user row — cascade wipes identities, profiles, conversations,
        # messages, memories.
        sb.table("users").delete().eq("user_uuid", user_uuid).execute()

        log_consent(user_uuid, "deleted", channel=channel)
        log.info("user_data_deleted", user_uuid=user_uuid)
        return True
    except Exception as e:
        log.error("user_data_delete_failed", user_uuid=user_uuid, error=str(e))
        return False
