"""Offline tests for the adaptive memory service (no network / no DB).

Two retrieval strategies are pinned here:

  1. **Recency + confidence (default, Anthropic-only stack).** With no
     OPENAI_API_KEY, lookup() must still return the user's live facts from
     Postgres — memory works without an embedding vendor.
  2. **pgvector (optional upgrade).** With a key, lookup() embeds and calls the
     `match_memories` RPC — and falls back to recency when that yields nothing.

Every failure path must degrade quietly (never raise): memory enhances the
reply, it is never a dependency of it.

apps.api.services.memory imports apps.api.deps, which imports the anthropic /
supabase / openai SDKs at module top. We stub those in sys.modules first so the
suite runs anywhere.
"""
from __future__ import annotations

import sys
import types
from types import SimpleNamespace


def _ensure_stub_module(name: str, **attrs) -> None:
    if name in sys.modules:
        return
    try:
        __import__(name)
        return
    except Exception:
        pass
    mod = types.ModuleType(name)
    for attr, val in attrs.items():
        setattr(mod, attr, val)
    sys.modules[name] = mod


_ensure_stub_module("anthropic", Anthropic=object)
_ensure_stub_module("supabase", Client=object, create_client=lambda *a, **k: None)
_ensure_stub_module("openai", OpenAI=object)

from apps.api.services import memory  # noqa: E402


# --- fakes -----------------------------------------------------------------


class _FakeEmbeddings:
    def __init__(self, dim: int = 1536):
        self.dim = dim
        self.calls: list[dict] = []

    def create(self, model: str, input: str):  # noqa: A002 - mirror OpenAI's kwarg
        self.calls.append({"model": model, "input": input})
        return SimpleNamespace(data=[SimpleNamespace(embedding=[0.0] * self.dim)])


class _FakeOpenAI:
    def __init__(self, dim: int = 1536):
        self.embeddings = _FakeEmbeddings(dim)


class _FakeRPCQuery:
    def __init__(self, rows):
        self._rows = rows

    def execute(self):
        return SimpleNamespace(data=self._rows)


class _FakeTableQuery:
    """Chainable stand-in for the PostgREST table builder; records the chain."""

    def __init__(self, rows, sink):
        self._rows, self._sink = rows, sink

    def select(self, cols):
        self._sink["select"] = cols
        return self

    def eq(self, col, val):
        self._sink.setdefault("eq", []).append((col, val))
        return self

    def or_(self, expr):
        self._sink["or"] = expr
        return self

    def order(self, col, desc=False):
        self._sink.setdefault("order", []).append((col, desc))
        return self

    def limit(self, n):
        self._sink["limit"] = n
        return self

    def execute(self):
        return SimpleNamespace(data=self._rows)


class _FakeSupabase:
    """Serves both the RPC (vector) path and the table (recency) path."""

    def __init__(self, rpc_rows=None, table_rows=None):
        self._rpc_rows = rpc_rows or []
        self._table_rows = table_rows or []
        self.rpc_calls: list[tuple[str, dict]] = []
        self.table_chain: dict = {}
        self.table_name: str | None = None

    def rpc(self, name: str, params: dict):
        self.rpc_calls.append((name, params))
        return _FakeRPCQuery(self._rpc_rows)

    def table(self, name: str):
        self.table_name = name
        return _FakeTableQuery(self._table_rows, self.table_chain)


def _settings(openai_key=None, recall_limit=40):
    return SimpleNamespace(
        OPENAI_API_KEY=openai_key,
        EMBEDDING_MODEL="text-embedding-3-small",
        EMBEDDING_DIM=1536,
        MEMORY_RECALL_LIMIT=recall_limit,
    )


LIVE_ROWS = [
    {"id": "1", "fact": "Prefers vegetarian restaurants", "tags": ["food"], "confidence": 0.9},
    {"id": "2", "fact": "Staying in Kata Beach", "tags": ["location"], "confidence": 0.8},
]


# --- default path: no embedding vendor -------------------------------------


def test_lookup_without_openai_still_returns_memories(monkeypatch):
    """The headline behaviour: memory works on an Anthropic-only stack."""
    fake_sb = _FakeSupabase(table_rows=LIVE_ROWS)
    monkeypatch.setattr(memory, "get_settings", lambda: _settings(None))
    monkeypatch.setattr(memory, "get_supabase", lambda: fake_sb)

    def _boom(*a, **k):
        raise AssertionError("OpenAI must not be touched without a key")

    monkeypatch.setattr("apps.api.deps.get_openai", _boom)

    out = memory.lookup("user-123", "where should we eat?", k=5)
    assert [m["fact"] for m in out] == [
        "Prefers vegetarian restaurants",
        "Staying in Kata Beach",
    ]
    assert fake_sb.table_name == "memories"


def test_recency_query_filters_expired_and_orders_best_first(monkeypatch):
    fake_sb = _FakeSupabase(table_rows=LIVE_ROWS)
    monkeypatch.setattr(memory, "get_settings", lambda: _settings(None, recall_limit=40))
    monkeypatch.setattr(memory, "get_supabase", lambda: fake_sb)

    memory.lookup("user-123", "anything", k=5)
    chain = fake_sb.table_chain
    assert ("user_uuid", "user-123") in chain["eq"]
    assert "expires_at.is.null" in chain["or"] and "expires_at.gt." in chain["or"]
    assert chain["order"] == [("confidence", True), ("created_at", True)]
    assert chain["limit"] == 40  # recall limit wins over the smaller k


def test_recall_limit_respects_larger_k(monkeypatch):
    fake_sb = _FakeSupabase(table_rows=LIVE_ROWS)
    monkeypatch.setattr(memory, "get_settings", lambda: _settings(None, recall_limit=10))
    monkeypatch.setattr(memory, "get_supabase", lambda: fake_sb)
    memory.lookup("user-123", "anything", k=25)
    assert fake_sb.table_chain["limit"] == 25


def test_lookup_drops_rows_without_fact_recency(monkeypatch):
    rows = [
        {"id": "1", "fact": "Has a dog named Max", "tags": [], "confidence": 0.8},
        {"id": "2", "fact": "", "tags": [], "confidence": 0.8},
        {"id": "3", "tags": [], "confidence": 0.8},
    ]
    monkeypatch.setattr(memory, "get_settings", lambda: _settings(None))
    monkeypatch.setattr(memory, "get_supabase", lambda: _FakeSupabase(table_rows=rows))
    out = memory.lookup("user-123", "my pet", k=5)
    assert [m["fact"] for m in out] == ["Has a dog named Max"]


def test_lookup_returns_empty_when_db_down(monkeypatch):
    class _Exploding:
        def table(self, *a, **k):
            raise RuntimeError("supabase down")

    monkeypatch.setattr(memory, "get_settings", lambda: _settings(None))
    monkeypatch.setattr(memory, "get_supabase", lambda: _Exploding())
    assert memory.lookup("user-123", "anything", k=5) == []


# --- optional vector path --------------------------------------------------


def test_vector_path_used_when_key_present(monkeypatch):
    rpc_rows = [
        {"id": "9", "fact": "Allergic to shellfish", "tags": ["diet"], "confidence": 0.95, "similarity": 0.91},
    ]
    fake_sb = _FakeSupabase(rpc_rows=rpc_rows, table_rows=LIVE_ROWS)
    fake_openai = _FakeOpenAI()
    monkeypatch.setattr(memory, "get_settings", lambda: _settings("sk-test-key"))
    monkeypatch.setattr("apps.api.deps.get_openai", lambda: fake_openai)
    monkeypatch.setattr(memory, "get_supabase", lambda: fake_sb)

    out = memory.lookup("user-123", "seafood ok?", k=5)
    assert [m["fact"] for m in out] == ["Allergic to shellfish"]

    name, params = fake_sb.rpc_calls[0]
    assert name == "match_memories"
    assert params["p_user"] == "user-123"
    assert params["match_count"] == 5
    assert len(params["query_embedding"]) == 1536
    assert fake_openai.embeddings.calls[0]["input"] == "seafood ok?"


def test_vector_failure_falls_back_to_recency(monkeypatch):
    """A dead embedding vendor must not cost us the user's memory."""
    class _ExplodingOpenAI:
        class embeddings:  # noqa: N801
            @staticmethod
            def create(*a, **k):
                raise RuntimeError("openai 500")

    fake_sb = _FakeSupabase(rpc_rows=[], table_rows=LIVE_ROWS)
    monkeypatch.setattr(memory, "get_settings", lambda: _settings("sk-test-key"))
    monkeypatch.setattr("apps.api.deps.get_openai", lambda: _ExplodingOpenAI())
    monkeypatch.setattr(memory, "get_supabase", lambda: fake_sb)

    out = memory.lookup("user-123", "anything", k=5)
    assert [m["fact"] for m in out] == [
        "Prefers vegetarian restaurants",
        "Staying in Kata Beach",
    ]


def test_empty_vector_result_falls_back_to_recency(monkeypatch):
    """Unembedded new memories (worker not run) still surface."""
    fake_sb = _FakeSupabase(rpc_rows=[], table_rows=LIVE_ROWS)
    monkeypatch.setattr(memory, "get_settings", lambda: _settings("sk-test-key"))
    monkeypatch.setattr("apps.api.deps.get_openai", lambda: _FakeOpenAI())
    monkeypatch.setattr(memory, "get_supabase", lambda: fake_sb)
    out = memory.lookup("user-123", "anything", k=5)
    assert len(out) == 2
