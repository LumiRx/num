"""Tests for multi-turn context + the turn-latency optimizations.

Covers three behaviours that a passenger actually feels:

  1. `persistence.recent_turns` returns prior turns oldest-first, in Anthropic's
     shape, merging consecutive same-role rows (the API rejects those).
  2. `concierge.generate_reply` puts that history *before* the current message,
     so "what about tomorrow?" has a referent.
  3. The tool loop honours a wall-clock budget, so a slow chain returns partial
     text instead of blowing the channel's webhook timeout.
"""
from __future__ import annotations

import sys
import types
from types import SimpleNamespace

for _name in ("anthropic", "supabase", "openai"):
    if _name not in sys.modules:
        mod = types.ModuleType(_name)
        if _name == "anthropic":
            mod.Anthropic = object
        if _name == "supabase":
            mod.Client = object
            mod.create_client = lambda *a, **k: None
        if _name == "openai":
            mod.OpenAI = object
        sys.modules[_name] = mod

from apps.api.services import concierge, persistence  # noqa: E402


# ----------------------------------------------------------- recent_turns ---


class _Q:
    def __init__(self, rows, sink):
        self._rows, self._sink = rows, sink

    def select(self, c): self._sink["select"] = c; return self
    def eq(self, k, v): self._sink.setdefault("eq", []).append((k, v)); return self
    def in_(self, k, v): self._sink["in"] = (k, v); return self
    def order(self, c, desc=False): self._sink["order"] = (c, desc); return self
    def limit(self, n): self._sink["limit"] = n; return self
    def execute(self): return SimpleNamespace(data=self._rows)


class _SB:
    def __init__(self, rows):
        self.rows, self.chain = rows, {}

    def table(self, name):
        self.chain["table"] = name
        return _Q(self.rows, self.chain)


def test_recent_turns_oldest_first(monkeypatch):
    # DB returns newest-first; the prompt needs oldest-first.
    rows = [
        {"role": "assistant", "content": "Kan Eang @ Pier is great for seafood."},
        {"role": "user", "content": "where should we eat?"},
    ]
    sb = _SB(rows)
    monkeypatch.setattr(persistence, "get_supabase", lambda: sb)
    out = persistence.recent_turns("c-1", limit=12)
    assert [t["role"] for t in out] == ["user", "assistant"]
    assert out[0]["content"] == "where should we eat?"
    assert sb.chain["order"] == ("created_at", True)
    assert sb.chain["limit"] == 12


def test_recent_turns_merges_consecutive_same_role(monkeypatch):
    """Anthropic rejects two user turns in a row — merge instead."""
    rows = [
        {"role": "user", "content": "and tomorrow?"},
        {"role": "user", "content": "where should we eat?"},
    ]
    monkeypatch.setattr(persistence, "get_supabase", lambda: _SB(rows))
    out = persistence.recent_turns("c-1")
    assert len(out) == 1
    assert out[0]["role"] == "user"
    assert "where should we eat?" in out[0]["content"]
    assert "and tomorrow?" in out[0]["content"]


def test_recent_turns_skips_blank_and_survives_db_error(monkeypatch):
    monkeypatch.setattr(persistence, "get_supabase", lambda: _SB([
        {"role": "user", "content": "  "}, {"role": "assistant", "content": "hi"},
    ]))
    assert [t["role"] for t in persistence.recent_turns("c-1")] == ["assistant"]

    class _Boom:
        def table(self, *a, **k): raise RuntimeError("db down")
    monkeypatch.setattr(persistence, "get_supabase", lambda: _Boom())
    assert persistence.recent_turns("c-1") == []


# --------------------------------------------------------------- concierge ---


class _Resp:
    def __init__(self, text, stop="end_turn"):
        self.content = [SimpleNamespace(type="text", text=text)]
        self.stop_reason = stop
        self.usage = SimpleNamespace(input_tokens=10, output_tokens=5)


class _RecordingClient:
    def __init__(self, resp):
        self.resp, self.sent = resp, None

    class _M:
        def __init__(self, outer): self.outer = outer
        def create(self, **kw):
            self.outer.sent = kw
            return self.outer.resp

    @property
    def messages(self): return _RecordingClient._M(self)


def _stub_settings(monkeypatch):
    monkeypatch.setattr(concierge, "get_settings", lambda: SimpleNamespace(
        CLAUDE_MODEL_CHAT="claude-sonnet-4-6"))
    monkeypatch.setattr(concierge, "build_system_prompt", lambda *a, **k: "SYSTEM")


def test_history_precedes_current_message(monkeypatch):
    _stub_settings(monkeypatch)
    client = _RecordingClient(_Resp("Sure — tomorrow works."))
    monkeypatch.setattr(concierge, "get_anthropic", lambda: client)

    history = [
        {"role": "user", "content": "where should we eat?"},
        {"role": "assistant", "content": "Kan Eang @ Pier."},
    ]
    reply, usage = concierge.generate_reply(
        {"user_uuid": "u1", "preferred_lang": "en"},
        "what about tomorrow?",
        conversation_id="c-1",
        history=history,
    )
    sent = client.sent["messages"]
    assert [m["role"] for m in sent] == ["user", "assistant", "user"]
    assert sent[0]["content"] == "where should we eat?"
    assert sent[-1]["content"] == "what about tomorrow?"
    assert reply == "Sure — tomorrow works."
    assert usage.input_tokens == 10


def test_history_leading_assistant_turn_is_dropped(monkeypatch):
    """Anthropic requires the first turn to be from the user."""
    _stub_settings(monkeypatch)
    client = _RecordingClient(_Resp("ok"))
    monkeypatch.setattr(concierge, "get_anthropic", lambda: client)
    concierge.generate_reply(
        {"user_uuid": "u1"}, "hi",
        history=[{"role": "assistant", "content": "orphaned opener"}],
    )
    assert [m["role"] for m in client.sent["messages"]] == ["user"]


def test_no_history_still_works(monkeypatch):
    _stub_settings(monkeypatch)
    client = _RecordingClient(_Resp("hello!"))
    monkeypatch.setattr(concierge, "get_anthropic", lambda: client)
    reply, _ = concierge.generate_reply({"user_uuid": "u1"}, "hi")
    assert reply == "hello!"
    assert len(client.sent["messages"]) == 1


def test_tool_loop_stops_at_time_budget(monkeypatch):
    """A slow tool chain must return text, not hang past the channel timeout."""
    _stub_settings(monkeypatch)

    tool_resp = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="Still looking…")],
        stop_reason="tool_use",
        usage=SimpleNamespace(input_tokens=5, output_tokens=2),
    )

    class _AlwaysToolClient:
        class _M:
            def create(self, **kw): return tool_resp
        @property
        def messages(self): return _AlwaysToolClient._M()

    monkeypatch.setattr(concierge, "get_anthropic", lambda: _AlwaysToolClient())
    # Force the deadline to have already passed on the first check.
    monkeypatch.setattr(concierge, "_TURN_BUDGET_S", -1.0)

    reply, _ = concierge.generate_reply({"user_uuid": "u1"}, "find me dinner")
    assert reply == "Still looking…"  # partial text, not a hang or a crash


def test_tool_turns_capped():
    assert concierge._MAX_TOOL_TURNS <= 3
