"""Concierge agent — Claude Sonnet with a tool-use loop.

generate_reply runs the standard Anthropic tool loop: call the model with
`TOOLS`; while it asks for a tool, execute it via `tools.dispatch` and feed the
result back; stop when the model returns text. Token usage is summed across all
iterations into a single `Usage` so the pipeline records the true turn cost.
"""
from __future__ import annotations

import json
import time
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
# 3 tool turns covers every real flow (search → maybe a second search → answer).
# 5 was theoretical headroom that only bought worst-case latency.
_MAX_TOOL_TURNS = 3
# Wall-clock budget for the whole turn. Twilio abandons a webhook around 15s and
# WeChat's passive-reply window is ~5s; stopping at 12s means we always return
# *something* on-channel instead of the user seeing silence.
_TURN_BUDGET_S = 12.0


def _template() -> str:
    global _TEMPLATE
    if _TEMPLATE is None:
        _TEMPLATE = _PROMPT_PATH.read_text(encoding="utf-8")
    return _TEMPLATE


def build_system_prompt(user: dict, retrieved_memories: Optional[list[str]] = None) -> str:
    mem_block = "\n".join(f"- {m}" for m in (retrieved_memories or [])) or "(no stored memories yet)"
    # Service area = where WE have vendors. Per-tenant value wins; otherwise the
    # configured default. Never phrased as "the guest is here" — the prompt is
    # explicit that only the guest can say where the guest is.
    service_area = user.get("service_area") or get_settings().SERVICE_AREA
    return (
        _template()
        .replace('{{user_display_name or "this guest"}}', "this guest")
        .replace("{{user_uuid}}", str(user.get("user_uuid", "")))
        .replace("{{user.preferred_lang}}", user.get("preferred_lang") or "en")
        .replace("{{service_area}}", service_area)
        .replace("{{retrieved_memories_block}}", mem_block)
        .replace("{{current_trip_block_if_any}}", "(none)")
    )


def generate_reply(
    user: dict,
    user_message: str,
    conversation_id: Optional[str] = None,
    retrieved_memories: Optional[list[str]] = None,
    history: Optional[list[dict]] = None,
) -> tuple[str, Usage]:
    """Run the tool-use loop. Returns (reply text, summed token Usage). Never raises.

    `history` is the prior turns of this conversation (oldest first) so
    follow-ups like "what about tomorrow?" resolve. Durable cross-session facts
    arrive separately via `retrieved_memories`.
    """
    s = get_settings()
    fallback = strings.get("fallback", user.get("preferred_lang"))
    system_prompt = build_system_prompt(user, retrieved_memories)
    ctx = ToolContext(
        user_uuid=str(user.get("user_uuid", "")),
        partner_tenant_id=user.get("partner_tenant_id"),
        conversation_id=conversation_id,
    )
    client = get_anthropic()
    messages: list[dict] = [*(history or []), {"role": "user", "content": user_message}]
    # Anthropic requires the first turn to be "user" and no repeated roles.
    while messages and messages[0]["role"] != "user":
        messages.pop(0)
    total_in = total_out = 0
    deadline = time.monotonic() + _TURN_BUDGET_S

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
                # Out of time: stop tool-calling and let the model answer with
                # what it already has rather than risk a channel timeout.
                if time.monotonic() > deadline:
                    log.warning("concierge_turn_budget_exceeded", budget_s=_TURN_BUDGET_S)
                    partial = "".join(
                        getattr(b, "text", "") for b in resp.content
                        if getattr(b, "type", None) == "text"
                    ).strip()
                    return (partial or fallback), _usage()
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
