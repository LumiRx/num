-- NUM 0005 — pgvector retrieval RPC for adaptive memory
--
-- NOT auto-applied. Review, then apply (Supabase MCP apply_migration or psql).
--
-- Exposes match_memories() over PostgREST RPC so the API can do a cosine
-- nearest-neighbour search over the `memories` table (see 0001 §5). Pairs with
-- apps/api/services/memory.py::lookup() and the apps/workers/embed.py worker
-- that backfills the embedding column.
--
-- Idempotent: create or replace. Re-running is safe.
--
-- SECURITY: marked `security invoker` so the function runs with the CALLER'S
-- privileges and honours RLS on `memories` — the service-role backend bypasses
-- RLS as usual, and any future anon/authenticated caller only ever sees rows it
-- is entitled to. `set search_path = public` pins schema resolution (resolves
-- Supabase linter 0011_function_search_path_mutable).

create or replace function public.match_memories(
    p_user          uuid,
    query_embedding  vector(1536),
    match_count      int default 5
)
returns table (
    id          uuid,
    fact        text,
    tags        text[],
    confidence  numeric,
    similarity  float
)
language sql
stable
security invoker
set search_path = public
as $$
    select
        m.id,
        m.fact,
        m.tags,
        m.confidence,
        1 - (m.embedding <=> query_embedding) as similarity
    from memories m
    where m.user_uuid = p_user
      and m.embedding is not null
      and (m.expires_at is null or m.expires_at > now())
    order by m.embedding <=> query_embedding
    limit match_count;
$$;
