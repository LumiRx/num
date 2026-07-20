"""Concierge agent — Claude Sonnet with a tool-use loop.

generate_reply runs the standard Anthropic tool loop: call the model with
`TOOLS`; while it asks for a tool, execute it via `tools.dispatch` and feed the
result back; stop when the model returns text. Token usage is summed across all
iterations into a single `Usage` so the pipeline records the true turn cost.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import structlog

from apps.api.deps import get_anthropic
from apps.api.services import strings
from apps.api.services.costing import Usage
from apps.api.settings import get_settings
from apps.api.tools import TOOLS, ToolContext, dispatch

log = structlog.get_logger()

_PROMPT_PATH = Path(__file__).resolve().parents[1] / "prompts" / "system_prompt.txt"
_TEMPLATE: Optional[str] = None
_MAX_TOOL_TURNS = 5


def _template() -> str:
    global _TEMPLATE
    if _TEMPLATE is None:
        _TEMPLATE = _PROMPT_PATH.read_text(encoding="utf-8")
    return _TEMPLATE


def build_system_prompt(user: dict, retrieved_memories: Optional[list[str]] = None) -> str:
    mem_block = "\n".join(f"- {m}" for m in (retrieved_memories or [])) or "(no stored memories yet)"
    return (
        _template()
        .replace('{{user_display_name or "this guest"}}', "this guest")
        .replace("{{user_uuid}}", str(user.get("user_uuid", "")))
        .replace("{{user.preferred_lang}}", user.get("preferred_lang") or "en")
        .replace("{{retrieved_memories_block}}", mem_block)
        .replace("{{current_trip_block_if_any}}", "(none)")
    )


def generate_reply(
    user: dict,
    user_message: str,
    conversation_id: Optional[str] = None,
    retrieved_memories: Optional[list[str]] = None,
) -> tuple[str, Usage]:
    """Run the tool-use loop. Returns (reply text, summed token Usage). Never raises."""
    s = get_settings()
    fallback = strings.get("fallback", user.get("preferred_lang"))
    system_prompt = build_system_prompt(user, retrieved_memories)
    ctx = ToolContext(
        user_uuid=str(user.get("user_uuid", "")),
        partner_tenant_id=user.get("partner_tenant_id"),
        conversation_id=conversation_id,
    )
    client = get_anthropic()
    messages: list[dict] = [{"role": "user", "content": user_message}]
    total_in = total_out = 0

    def _usage() -> Usage:
        return Usage(model=s.CLAUDE_MODEL_CHAT, input_tokens=total_in, output_tokens=total_out, purpose="reply")

    try:
        for _ in range(_MAX_TOOL_TURNS):
            resp = client.messages.create(
                model=s.CLAUDE_MODEL_CHAT,
                max_tokens=800,
                system=system_prompt,
                tools=TOOLS,
                messages=messages,
            )
            u = getattr(resp, "usage", None)
            total_in += int(getattr(u, "input_tokens", 0) or 0)
            total_out += int(getattr(u, "output_tokens", 0) or 0)

            if resp.stop_reason == "tool_use":
                messages.append({"role": "assistant", "content": resp.content})
                results = []
                for block in resp.content:
                    if getattr(block, "type", None) == "tool_use":
                        out = dispatch(block.name, block.input, ctx)
                        results.append(
                            {
                                "type": "tool_result",
                                "tool_use_id": block.id,
                                "content": json.dumps(out, ensure_ascii=False, default=str),
                            }
                        )
                messages.append({"role": "user", "content": results})
                continue

            text = "".join(
                getattr(b, "text", "") for b in resp.content if getattr(b, "type", None) == "text"
            ).strip()
            return (text or fallback), _usage()

        log.warning("concierge_tool_loop_exhausted", turns=_MAX_TOOL_TURNS)
        return fallback, _usage()
    except Exception as e:
        log.exception("concierge_call_failed", error=str(e))
        return fallback, _usage()
