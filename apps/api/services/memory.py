"""Vector memory service.

`lookup` embeds the incoming query with OpenAI (text-embedding-3-small) and runs
a pgvector cosine nearest-neighbour search via the `match_memories` Postgres RPC
(see infra/supabase/migrations/0005_match_memories.sql). The embedding column is
backfilled out-of-band by apps/workers/embed.py.

Degradation: if OPENAI_API_KEY is not configured — or anything in the embed /
RPC path fails — `lookup` returns [] rather than raising, so the concierge keeps
answering (just without retrieved memory). It must NEVER crash the response path.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import structlog

from apps.api.deps import get_supabase
from apps.api.settings import get_settings

log = structlog.get_logger()


def lookup(user_uuid: str, query: str, k: int = 5) -> list[dict]:
    """Vector retrieval over a user's memories.

    Embeds `query`, then calls the `match_memories` RPC and returns up to `k`
    rows as dicts (each carries at least a "fact" key; also id/tags/confidence/
    similarity). Returns [] — never raises — if embeddings are unconfigured or
    any step fails, so the pipeline degrades gracefully without memory.
    """
    settings = get_settings()
    if not settings.OPENAI_API_KEY:
        # No embeddings configured — run the concierge without memory.
        log.debug("memory_lookup_skipped_no_openai_key", user_uuid=user_uuid)
        return []

    try:
        from apps.api.deps import get_openai

        client = get_openai()
        resp = client.embeddings.create(
            model=settings.EMBEDDING_MODEL,
            input=query,
        )
        query_embedding = resp.data[0].embedding

        rpc_res = get_supabase().rpc(
            "match_memories",
            {
                "p_user": user_uuid,
                "query_embedding": query_embedding,
                "match_count": k,
            },
        ).execute()

        rows = rpc_res.data or []
        # Defensive: only surface rows that actually carry a fact.
        results = [dict(r) for r in rows if isinstance(r, dict) and r.get("fact")]
        log.debug("memory_lookup_ok", user_uuid=user_uuid, hits=len(results))
        return results
    except Exception as e:
        log.warning("memory_lookup_failed", user_uuid=user_uuid, error=str(e))
        return []


def save(
    user_uuid: str,
    fact: str,
    tags: Optional[list[str]] = None,
    confidence: float = 0.8,
    expires_at: Optional[datetime] = None,
    source_message_id: Optional[str] = None,
) -> None:
    """Write a memory. v0: no embedding yet — that's the worker's job in task #6."""
    sb = get_supabase()
    try:
        sb.table("memories").insert(
            {
                "user_uuid": user_uuid,
                "fact": fact,
                "tags": tags or [],
                "confidence": confidence,
                "expires_at": expires_at.astimezone(timezone.utc).isoformat() if expires_at else None,
                "source_message_id": source_message_id,
                # embedding column intentionally left NULL — embed worker fills it
            }
        ).execute()
    except Exception as e:
        log.warning("memory_save_failed", error=str(e))
