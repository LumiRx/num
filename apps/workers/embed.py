"""NUM — memory embedding backfill worker.

Polls the `memories` table for rows whose `embedding` column is still NULL,
embeds each row's `fact` with OpenAI (text-embedding-3-small) and writes the
vector back. memory.save() intentionally inserts memories without an embedding;
this worker fills them in so memory.lookup()'s pgvector search can find them.

Run continuously (default — polls forever with a sleep between passes):
    source .venv/bin/activate
    python -m apps.workers.embed
    # or: python apps/workers/embed.py

Single pass then exit (for cron / one-shot backfills / testing):
    python -m apps.workers.embed --once

CLI flags:
    --once              process one batch (or drain, with --drain) then exit
    --drain             keep going until no NULL-embedding rows remain
    --batch-size N      rows per poll (default 50)
    --interval SECONDS  sleep between passes in loop mode (default 5)

Required env (loaded from .env, same as apps/api/main.py):
    OPENAI_API_KEY               — without it the worker logs and exits cleanly
    SUPABASE_URL                 — project URL
    SUPABASE_SERVICE_ROLE_KEY    — service role (bypasses RLS to read/update memories)

Optional env:
    EMBEDDING_MODEL              — defaults to text-embedding-3-small (settings)
    LOG_LEVEL                    — defaults to INFO

Defensive by design: per-row try/except, structured logging, never dies on one
bad row. A bad row is skipped (logged) and retried on the next pass.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import time

import structlog
from dotenv import load_dotenv

# Load .env BEFORE anything reads settings (mirrors apps/api/main.py).
load_dotenv()

from apps.api.deps import get_openai, get_supabase  # noqa: E402
from apps.api.settings import get_settings  # noqa: E402

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = structlog.get_logger()

DEFAULT_BATCH_SIZE = 50
DEFAULT_INTERVAL_SECONDS = 5


def _fetch_unembedded(batch_size: int) -> list[dict]:
    """Return up to `batch_size` memory rows that still need an embedding."""
    res = (
        get_supabase()
        .table("memories")
        .select("id, fact")
        .is_("embedding", "null")
        .order("created_at", desc=False)  # oldest first — fairest backfill
        .limit(batch_size)
        .execute()
    )
    return res.data or []


def _embed_row(client, model: str, row: dict) -> bool:
    """Embed one row's fact and persist it. Returns True on success.

    Never raises — a failure is logged and reported as False so the caller can
    keep processing the rest of the batch and retry this row next pass.
    """
    row_id = row.get("id")
    fact = (row.get("fact") or "").strip()
    if not fact:
        log.warning("embed_row_skipped_empty_fact", memory_id=row_id)
        return False

    try:
        resp = client.embeddings.create(model=model, input=fact)
        embedding = resp.data[0].embedding

        get_supabase().table("memories").update({"embedding": embedding}).eq(
            "id", row_id
        ).execute()
        log.debug("embed_row_ok", memory_id=row_id)
        return True
    except Exception as e:
        log.warning("embed_row_failed", memory_id=row_id, error=str(e))
        return False


def run_once(batch_size: int = DEFAULT_BATCH_SIZE, drain: bool = False) -> int:
    """Process one batch (or drain all) of unembedded memories.

    Returns the number of rows successfully embedded. Never raises.
    """
    settings = get_settings()
    model = settings.EMBEDDING_MODEL

    try:
        client = get_openai()
    except Exception as e:
        # Should already be guarded in main(), but stay defensive.
        log.warning("embed_worker_no_openai_client", error=str(e))
        return 0

    total = 0
    while True:
        try:
            rows = _fetch_unembedded(batch_size)
        except Exception as e:
            log.warning("embed_fetch_failed", error=str(e))
            break

        if not rows:
            break

        embedded = sum(1 for row in rows for ok in (_embed_row(client, model, row),) if ok)
        total += embedded
        log.info("embed_batch_done", fetched=len(rows), embedded=embedded)

        # In non-drain mode we do exactly one batch per call.
        if not drain:
            break
        # When draining, if the batch wasn't full there's nothing left to do.
        if len(rows) < batch_size:
            break

    return total


def run_loop(
    batch_size: int = DEFAULT_BATCH_SIZE,
    interval: float = DEFAULT_INTERVAL_SECONDS,
) -> None:
    """Poll forever, sleeping `interval` seconds between passes. Ctrl-C to stop."""
    log.info("embed_worker_loop_start", batch_size=batch_size, interval=interval)
    while True:
        try:
            run_once(batch_size=batch_size, drain=False)
        except Exception as e:
            # run_once is already defensive, but never let the loop die.
            log.warning("embed_pass_failed", error=str(e))
        time.sleep(interval)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="NUM memory embedding backfill worker")
    parser.add_argument(
        "--once", action="store_true", help="process one batch (or drain) then exit"
    )
    parser.add_argument(
        "--drain",
        action="store_true",
        help="keep processing batches until no unembedded rows remain",
    )
    parser.add_argument(
        "--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help="rows per poll"
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=DEFAULT_INTERVAL_SECONDS,
        help="seconds to sleep between passes in loop mode",
    )
    args = parser.parse_args(argv)

    settings = get_settings()
    if not settings.OPENAI_API_KEY:
        log.warning("embed_worker_exit_no_openai_key")
        return 0

    if args.once:
        embedded = run_once(batch_size=args.batch_size, drain=args.drain)
        log.info("embed_worker_once_done", embedded=embedded)
        return 0

    try:
        run_loop(batch_size=args.batch_size, interval=args.interval)
    except KeyboardInterrupt:
        log.info("embed_worker_interrupted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
