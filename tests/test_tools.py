"""Offline tests for the tools package — no network, no DB.

External SDKs (anthropic/supabase/openai) are stubbed in sys.modules so the
package imports cleanly in CI; handlers are exercised via monkeypatched clients.
"""
import sys
import types
from datetime import datetime, timezone

import pytest

# --- stub heavy SDKs so `import apps.api.tools` works without them installed ---
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

from apps.api.tools import TOOLS, ToolContext, dispatch  # noqa: E402
from apps.api.tools import vendors as vendors_mod  # noqa: E402
from apps.api.tools.memory_tools import _parse_expires  # noqa: E402


def test_tools_schema_shape():
    names = {t["name"] for t in TOOLS}
    assert {"search_vendors", "create_lead", "escalate_to_human", "save_user_memory"} <= names
    for t in TOOLS:
        assert t["description"]
        assert t["input_schema"]["type"] == "object"
        assert "required" in t["input_schema"]


def test_dispatch_unknown_tool():
    out = dispatch("not_a_tool", {}, ToolContext(user_uuid="u1"))
    assert "error" in out


def test_parse_expires_relative_and_iso():
    assert _parse_expires(None) is None
    assert _parse_expires("nonsense") is None
    d = _parse_expires("+30d")
    assert d is not None and d > datetime.now(timezone.utc)
    iso = _parse_expires("2030-01-01")
    assert iso.year == 2030


def test_search_vendors_orders_by_tier(monkeypatch):
    rows = [
        {"id": "1", "name": "Cheap Eats", "category": "restaurant", "featured_tier": None, "metadata": {}},
        {"id": "2", "name": "Premium Place", "category": "restaurant", "featured_tier": "premium", "metadata": {}},
        {"id": "3", "name": "Standard Spot", "category": "restaurant", "featured_tier": "standard", "metadata": {}},
    ]

    class _Q:
        def select(self, *a, **k): return self
        def eq(self, *a, **k): return self
        def limit(self, *a, **k): return self
        def execute(self):
            return types.SimpleNamespace(data=list(rows))

    class _SB:
        def table(self, *a, **k): return _Q()

    monkeypatch.setattr(vendors_mod, "get_supabase", lambda: _SB())
    out = vendors_mod.search_vendors(ToolContext(user_uuid="u1", partner_tenant_id="t1"), category="restaurant")
    assert out["count"] == 3
    assert out["vendors"][0]["name"] == "Premium Place"  # premium first
    assert out["vendors"][-1]["name"] == "Cheap Eats"     # untiered last


def test_search_vendors_empty_is_honest(monkeypatch):
    class _Q:
        def select(self, *a, **k): return self
        def eq(self, *a, **k): return self
        def limit(self, *a, **k): return self
        def execute(self): return types.SimpleNamespace(data=[])

    class _SB:
        def table(self, *a, **k): return _Q()

    monkeypatch.setattr(vendors_mod, "get_supabase", lambda: _SB())
    out = vendors_mod.search_vendors(ToolContext(user_uuid="u1"), category="spa")
    assert out["count"] == 0
    assert "note" in out  # tells the model not to invent options
