"""Write-path helpers: conversations, messages, events, LLM usage.
Best-effort — these never crash the response path.
"""
from __future__ import annotations

from typing import Optional

import structlog

from apps.api.deps import get_supabase
from apps.api.services.costing import Usage

log = structlog.get_logger()


def open_or_get_conversation(user_uuid: str, channel: str) -> str:
    """Return an open conversation id for this (user, channel). Create one if none open."""
    sb = get_supabase()
    existing = (
        sb.table("conversations")
        .select("id")
        .eq("user_uuid", user_uuid)
        .eq("channel", channel)
        .is_("closed_at", "null")
        .order("started_at", desc=True)
        .limit(1)
        .execute()
    )
    if existing.data:
        return existing.data[0]["id"]

    inserted = (
        sb.table("conversations")
        .insert({"user_uuid": user_uuid, "channel": channel})
        .execute()
    )
    return inserted.data[0]["id"]


def log_message(
    conversation_id: str,
    user_uuid: str,
    role: str,
    content: str,
    tool_calls: Optional[dict] = None,
    lang: Optional[str] = None,
    detected_intent: Optional[str] = None,
) -> Optional[str]:
    """Insert a message row. Returns the new message id (or None on failure)."""
    try:
        res = (
            get_supabase()
            .table("messages")
            .insert(
                {
                    "conversation_id": conversation_id,
                    "user_uuid": user_uuid,
                    "role": role,
                    "content": content,
                    "tool_calls": tool_calls,
                    "lang": lang,
                    "detected_intent": detected_intent,
                }
            )
            .execute()
        )
        return res.data[0]["id"] if res.data else None
    except Exception as e:
        log.warning("message_log_failed", error=str(e))
        return None


def log_llm_usage(
    conversation_id: Optional[str],
    user_uuid: Optional[str],
    usage: Usage,
    message_id: Optional[str] = None,
) -> None:
    """Record one LLM call's token usage + USD cost. Best-effort, never raises."""
    try:
        get_supabase().table("llm_usage").insert(
            {
                "conversation_id": conversation_id,
                "user_uuid": user_uuid,
                "message_id": message_id,
                "purpose": usage.purpose,
                "model": usage.model,
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
                "cost_usd": str(usage.cost_usd),
            }
        ).execute()
    except Exception as e:
        log.warning("llm_usage_log_failed", error=str(e))


def log_event(
    user_uuid: Optional[str],
    name: str,
    payload: Optional[dict] = None,
    source: Optional[str] = None,
) -> None:
    try:
        get_supabase().table("events").insert(
            {"user_uuid": user_uuid, "name": name, "payload": payload or {}, "source": source}
        ).execute()
    except Exception as e:
        log.warning("event_log_failed", error=str(e))
