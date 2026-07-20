"""Offline tests for the vector memory service (no network / no DB).

memory.lookup() reads OPENAI_API_KEY off settings, embeds via deps.get_openai(),
then calls the `match_memories` RPC via deps.get_supabase(). We monkeypatch all
three so nothing touches OpenAI or Supabase. Two behaviours are pinned:

  1. No OPENAI_API_KEY  -> returns [] (graceful degradation, must not raise).
  2. Key + fake RPC rows -> returns mapped dicts, each carrying a "fact" key
     (the pipeline does `[m["fact"] for m in retrieved]`).

Importing apps.api.services.memory pulls in apps.api.deps, which imports the
anthropic / supabase / openai SDKs at module top. Those heavyweight clients are
irrelevant here (every call is monkeypatched), so we register minimal stub
modules in sys.modules BEFORE the import. This keeps the suite dependency-light
and runnable in any environment, regardless of which SDKs are installed.
"""
from __future__ import annotations

import sys
import types
from types import SimpleNamespace


def _ensure_stub_module(name: str, **attrs) -> None:
    """Register a stand-in module only if the real one isn't importable."""
    if name in sys.modules:
        return
    try:  # prefer the real package when it's installed
        __import__(name)
        return
    except Exception:
        pass
    mod = types.ModuleType(name)
    for attr, val in attrs.items():
        setattr(mod, attr, val)
    sys.modules[name] = mod


# Stub just enough surface for `apps.api.deps` to import cleanly.
_ensure_stub_module("anthropic", Anthropic=object)
_ensure_stub_module("supabase", Client=object, create_client=lambda *a, **k: None)
_ensure_stub_module("openai", OpenAI=object)

from apps.api.services import memory  # noqa: E402


# --- fakes -----------------------------------------------------------------


class _FakeEmbeddings:
    """Stand-in for client.embeddings — returns a fixed-length vector."""

    def __init__(self, dim: int = 1536):
        self.dim = dim
        self.calls: list[dict] = []

    def create(self, model: str, input: str):  # noqa: A002 - mirror OpenAI's kwarg
        self.calls.append({"model": model, "input": input})
        embedding = [0.0] * self.dim
        return SimpleNamespace(data=[SimpleNamespace(embedding=embedding)])


class _FakeOpenAI:
    def __init__(self, dim: int = 1536):
        self.embeddings = _FakeEmbeddings(dim)


class _FakeRPCQuery:
    def __init__(self, rows):
        self._rows = rows

    def execute(self):
        return SimpleNamespace(data=self._rows)


class _FakeSupabase:
    """Records the rpc() call and returns canned rows."""

    def __init__(self, rows):
        self._rows = rows
        self.rpc_calls: list[tuple[str, dict]] = []

    def rpc(self, name: str, params: dict):
        self.rpc_calls.append((name, params))
        return _FakeRPCQuery(self._rows)


def _settings(openai_key):
    return SimpleNamespace(
        OPENAI_API_KEY=openai_key,
        EMBEDDING_MODEL="text-embedding-3-small",
        EMBEDDING_DIM=1536,
    )


# --- tests -----------------------------------------------------------------


def test_lookup_returns_empty_when_no_openai_key(monkeypatch):
    monkeypatch.setattr(memory, "get_settings", lambda: _settings(None))

    # If embeddings or supabase were touched the test would explode; assert they
    # are not by pointing them at functions that fail loudly.
    def _boom(*a, **k):
        raise AssertionError("must not be called when OPENAI_API_KEY is unset")

    monkeypatch.setattr("apps.api.deps.get_openai", _boom)
    monkeypatch.setattr(memory, "get_supabase", _boom)

    assert memory.lookup("user-123", "where to eat in Patong?", k=5) == []


def test_lookup_maps_rpc_rows_to_dicts_with_fact(monkeypatch):
    rows = [
        {
            "id": "11111111-1111-1111-1111-111111111111",
            "fact": "Prefers vegetarian restaurants",
            "tags": ["food", "diet"],
            "confidence": 0.9,
            "similarity": 0.87,
        },
        {
            "id": "22222222-2222-2222-2222-222222222222",
            "fact": "Staying in Kata Beach",
            "tags": ["location"],
            "confidence": 0.8,
            "similarity": 0.71,
        },
    ]
    fake_sb = _FakeSupabase(rows)
    fake_openai = _FakeOpenAI()

    monkeypatch.setattr(memory, "get_settings", lambda: _settings("sk-test-key"))
    monkeypatch.setattr("apps.api.deps.get_openai", lambda: fake_openai)
    monkeypatch.setattr(memory, "get_supabase", lambda: fake_sb)

    out = memory.lookup("user-123", "any good veggie food nearby?", k=5)

    # Mapped through to dicts the pipeline can consume.
    assert isinstance(out, list)
    assert len(out) == 2
    assert [m["fact"] for m in out] == [
        "Prefers vegetarian restaurants",
        "Staying in Kata Beach",
    ]
    assert out[0]["similarity"] == 0.87
    assert out[0]["tags"] == ["food", "diet"]

    # Embedding was requested with the configured model + the query text.
    assert fake_openai.embeddings.calls[0]["model"] == "text-embedding-3-small"
    assert fake_openai.embeddings.calls[0]["input"] == "any good veggie food nearby?"

    # RPC called correctly: right name, user, match_count, 1536-dim vector.
    name, params = fake_sb.rpc_calls[0]
    assert name == "match_memories"
    assert params["p_user"] == "user-123"
    assert params["match_count"] == 5
    assert len(params["query_embedding"]) == 1536


def test_lookup_drops_rows_without_fact(monkeypatch):
    rows = [
        {"id": "1", "fact": "Has a dog named Max", "tags": [], "confidence": 0.8, "similarity": 0.9},
        {"id": "2", "fact": "", "tags": [], "confidence": 0.8, "similarity": 0.5},  # empty
        {"id": "3", "tags": [], "confidence": 0.8, "similarity": 0.4},  # missing key
    ]
    monkeypatch.setattr(memory, "get_settings", lambda: _settings("sk-test-key"))
    monkeypatch.setattr("apps.api.deps.get_openai", lambda: _FakeOpenAI())
    monkeypatch.setattr(memory, "get_supabase", lambda: _FakeSupabase(rows))

    out = memory.lookup("user-123", "tell me about my pet", k=5)
    assert [m["fact"] for m in out] == ["Has a dog named Max"]


def test_lookup_returns_empty_on_rpc_failure(monkeypatch):
    class _ExplodingSupabase:
        def rpc(self, *a, **k):
            raise RuntimeError("supabase down")

    monkeypatch.setattr(memory, "get_settings", lambda: _settings("sk-test-key"))
    monkeypatch.setattr("apps.api.deps.get_openai", lambda: _FakeOpenAI())
    monkeypatch.setattr(memory, "get_supabase", lambda: _ExplodingSupabase())

    # Must swallow the error and degrade to [] — never crash the response path.
    assert memory.lookup("user-123", "anything", k=5) == []


def test_lookup_returns_empty_on_embed_failure(monkeypatch):
    class _ExplodingEmbeddings:
        def create(self, *a, **k):
            raise RuntimeError("openai 500")

    class _ExplodingOpenAI:
        embeddings = _ExplodingEmbeddings()

    def _boom_sb():
        raise AssertionError("supabase must not be reached if embedding fails")

    monkeypatch.setattr(memory, "get_settings", lambda: _settings("sk-test-key"))
    monkeypatch.setattr("apps.api.deps.get_openai", lambda: _ExplodingOpenAI())
    monkeypatch.setattr(memory, "get_supabase", _boom_sb)

    assert memory.lookup("user-123", "anything", k=5) == []
