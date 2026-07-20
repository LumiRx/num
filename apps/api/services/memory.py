"""Adaptive memory service — Anthropic-only by default.

Two retrieval strategies, chosen automatically:

1. **Recency + confidence (default, no embedding vendor needed).**
   A concierge user accumulates tens of durable facts, not thousands — diet,
   family, hotel, trip dates, preferences. At that scale we simply load the
   user's whole live memory set (highest-confidence, most-recent first, expired
   rows filtered) and let Claude decide what matters. That is cheaper than a
   vector round-trip, has no second vendor, and is *more* accurate than top-k
   ANN search when k ≈ the whole corpus.

2. **pgvector semantic search (optional upgrade).**
   If OPENAI_API_KEY is configured we embed the query and call the
   `match_memories` RPC (see migrations/0005). Used when a user's memory set
   outgrows a prompt — falls back to strategy 1 on any failure.

`lookup` must NEVER raise: memory is an enhancement to the reply path, never a
dependency of it. Every failure degrades to fewer memories, not an error.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import structlog

from apps.api.deps import get_supabase
from apps.api.settings import get_settings

log = structlog.get_logger()


def _recent_lookup(user_uuid: str, limit: int) -> list[dict]:
    """Load this user's live memories, best-first. No embeddings involved.

    Ordering: confidence desc, then newest first. Expired trip-scoped facts
    ("looking for a villa this weekend") are filtered out server-side.
    """
    try:
        now_iso = datetime.now(timezone.utc).isoformat()
        res = (
            get_supabase()
            .table("memories")
            .select("id, fact, tags, confidence, created_at")
            .eq("user_uuid", user_uuid)
            .or_(f"expires_at.is.null,expires_at.gt.{now_iso}")
            .order("confidence", desc=True)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        rows = res.data or []
        results = [dict(r) for r in rows if isinstance(r, dict) and r.get("fact")]
        log.debug("memory_recent_ok", user_uuid=user_uuid, hits=len(results))
        return results
    except Exception as e:
        log.warning("memory_recent_failed", user_uuid=user_uuid, error=str(e))
        return []


def _vector_lookup(user_uuid: str, query: str, k: int) -> list[dict]:
    """Semantic retrieval via OpenAI embedding + pgvector RPC. [] on any failure."""
    settings = get_settings()
    try:
        from apps.api.deps import get_openai

        client = get_openai()
        resp = client.embeddings.create(model=settings.EMBEDDING_MODEL, input=query)
        query_embedding = resp.data[0].embedding

        rpc_res = get_supabase().rpc(
            "match_memories",
            {"p_user": user_uuid, "query_embedding": query_embedding, "match_count": k},
        ).execute()

        rows = rpc_res.data or []
        results = [dict(r) for r in rows if isinstance(r, dict) and r.get("fact")]
        log.debug("memory_vector_ok", user_uuid=user_uuid, hits=len(results))
        return results
    except Exception as e:
        log.warning("memory_vector_failed", user_uuid=user_uuid, error=str(e))
        return []


def lookup(user_uuid: str, query: str, k: int = 5) -> list[dict]:
    """Return this user's relevant memories as dicts (each carries a "fact").

    Uses pgvector when embeddings are configured, otherwise (and on any vector
    failure) falls back to recency+confidence recall. Never raises.
    """
    settings = get_settings()
    limit = max(k, getattr(settings, "MEMORY_RECALL_LIMIT", 40))

    if settings.OPENAI_API_KEY:
        hits = _vector_lookup(user_uuid, query, k)
        if hits:
            return hits
        # Vector path configured but returned nothing (cold embeddings, RPC
        # error, brand-new memories not yet embedded) — recall still works.

    return _recent_lookup(user_uuid, limit)


def save(
    user_uuid: str,
    fact: str,
    tags: Optional[list[str]] = None,
    confidence: float = 0.8,
    expires_at: Optional[datetime] = None,
    source_message_id: Optional[str] = None,
) -> None:
    """Write a durable fact. Immediately retrievable via the recency path.

    The `embedding` column is left NULL; apps/workers/embed.py backfills it only
    when an embedding vendor is configured. Nothing depends on that worker.
    """
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
            }
        ).execute()
    except Exception as e:
        log.warning("memory_save_failed", error=str(e))
