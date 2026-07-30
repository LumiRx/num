"""Guards on the system prompt.

These exist because of a real production failure: the prompt opened with
"...Concierge for this guest **in Phuket, Thailand**", so the model treated the
guest's location as something IT knew. When a guest in Los Angeles asked for
dinner, NUM replied "I think there might be some confusion - you're actually in
Phuket", then recommended a Phuket restaurant, twice, ignoring two corrections.

Two classes of bug are pinned here:
  1. The prompt must never assert where the guest is.
  2. The prompt must never advertise a tool that isn't registered — it used to
     instruct `lookup_user_memory(...)` "BEFORE responding", a tool that does
     not exist, so the model burned turns calling into nothing.
"""
from __future__ import annotations

import re
import sys
import types

for _n in ("anthropic", "supabase", "openai"):
    if _n not in sys.modules:
        m = types.ModuleType(_n)
        if _n == "anthropic": m.Anthropic = object
        if _n == "supabase": m.Client = object; m.create_client = lambda *a, **k: None
        if _n == "openai": m.OpenAI = object
        sys.modules[_n] = m

from apps.api.services import concierge          # noqa: E402
from apps.api.tools import TOOLS                 # noqa: E402

USER = {"user_uuid": "u-1", "preferred_lang": "en"}


def _render(user=None, memories=None):
    return concierge.build_system_prompt(user or USER, memories)


# ───────────────────────── the location bug ─────────────────────────────────

def test_prompt_does_not_assert_guest_location():
    """The regression that shipped: the prompt claimed the guest was in Phuket."""
    p = _render().lower()
    for bad in ("concierge for this guest in phuket",
                "guide to phuket",
                "you are in phuket",
                "the user is in phuket"):
        assert bad not in p, f"prompt asserts guest location: {bad!r}"


def test_service_area_is_injected_and_labelled_as_coverage():
    p = _render()
    assert "{{service_area}}" not in p
    assert "Edinburgh, Scotland" in p            # default from settings
    # It must be framed as OUR coverage, not the guest's position.
    assert "NOT an assumption about where the guest currently is" in p


def test_service_area_can_be_overridden_per_tenant():
    """A Phuket tenant gets Phuket; the Edinburgh default must not leak in."""
    p = _render({**USER, "service_area": "Phuket, Thailand"})
    declaration = next(l for l in p.splitlines() if l.startswith("Your service area is:"))
    assert declaration == "Your service area is: Phuket, Thailand"
    # Edinburgh may still appear as a memory *example* — that's format, not coverage.
    assert "service area is: Edinburgh" not in p


def test_guest_is_authority_rule_present():
    p = _render()
    assert "AUTHORITY ON THEMSELVES" in p
    assert "the guest wins" in p.lower()
    # The exact failure phrase must be explicitly banned.
    assert "some confusion" in p, "prompt should name the phrase it must not use"


def test_prompt_forbids_out_of_area_invention_and_pivoting():
    p = _render().lower()
    assert "never invent recommendations" in p
    assert "do not pivot into selling them a holiday" in p


def test_prompt_instructs_saving_location_corrections():
    p = _render()
    assert "save_user_memory" in p
    assert "corrects their location" in p


# ───────────────────────── tool list integrity ──────────────────────────────

def test_prompt_only_advertises_registered_tools():
    """A prompt promising tools we don't have makes the model call into nothing."""
    registered = {t["name"] for t in TOOLS}
    p = _render()
    # Any backticked identifier that looks like a tool call.
    mentioned = set(re.findall(r"`(\w+)\(", p))
    unknown = mentioned - registered
    assert not unknown, f"prompt references unregistered tools: {sorted(unknown)}"


def test_removed_phantom_tools_stay_gone():
    p = _render()
    for phantom in ("lookup_user_memory", "save_secure_pii", "create_booking"):
        assert f"`{phantom}(" not in p, f"{phantom} is not registered but is advertised"


def test_every_registered_tool_is_documented():
    p = _render()
    for t in TOOLS:
        assert f"`{t['name']}(" in p, f"registered tool {t['name']} missing from prompt"


# ───────────────────────── rendering hygiene ────────────────────────────────

def test_no_unreplaced_placeholders():
    p = _render(memories=["based in Edinburgh", "vegetarian"])
    leftovers = re.findall(r"\{\{[^}]+\}\}", p)
    assert not leftovers, f"unreplaced placeholders: {leftovers}"


def test_memories_render_into_user_context():
    p = _render(memories=["currently in Los Angeles", "vegetarian"])
    ctx = p.split("<user_context>")[1].split("</user_context>")[0]
    assert "currently in Los Angeles" in ctx and "vegetarian" in ctx


def test_empty_memories_render_safely():
    p = _render(memories=[])
    assert "no stored memories yet" in p
    assert "{{" not in p


def test_preferred_language_injected():
    assert "th" in _render({**USER, "preferred_lang": "th"}).split("# Identity")[1][:400]
