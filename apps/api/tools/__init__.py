"""Concierge tool registry + dispatch.

`TOOLS` is the Anthropic tool-schema list passed to the model; `dispatch`
executes a requested tool against a `ToolContext` and always returns a JSON-
serialisable dict (never raises) so the tool-use loop can continue.

v1 ships the actionable core: search_vendors, create_lead, escalate_to_human,
save_user_memory. create_booking / save_secure_pii / lookup_user_memory are
deferred (Phase 2 / encryption layer / pipeline pre-fetch respectively).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import structlog

from apps.api.tools.leads import create_lead, escalate_to_human
from apps.api.tools.memory_tools import save_user_memory
from apps.api.tools.vendors import search_vendors

log = structlog.get_logger()


@dataclass
class ToolContext:
    user_uuid: str
    partner_tenant_id: Optional[str] = None
    conversation_id: Optional[str] = None


TOOLS = [
    {
        "name": "search_vendors",
        "description": (
            "Search the local vendor catalogue for this user's tenant. Use for TOURIST "
            "requests (food, spas, tours, transfers). Only recommend vendors this returns — "
            "never invent names, prices, or availability."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "category": {"type": "string",
                             "description": "e.g. restaurant, hotel, transfer, tour, spa, school, agent"},
                "geo": {"type": "string", "description": "optional area/neighbourhood hint"},
                "filters": {"type": "object", "description": "optional extra filters"},
                "limit": {"type": "integer", "description": "max results (1-10, default 5)"},
            },
            "required": ["category"],
        },
    },
    {
        "name": "create_lead",
        "description": (
            "Record a high-value (whale) lead — relocation, property purchase/rental, "
            "international school, long-stay visa, medical, or legal. Call after gathering "
            "budget band + timeline. A partner specialist follows up within 24h."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "vertical": {"type": "string",
                             "enum": ["real_estate", "school", "relocation", "visa", "medical", "legal"]},
                "budget_band": {"type": "string", "description": "e.g. 'THB 10-20M', '<50k/mo'"},
                "timeline": {"type": "string", "description": "e.g. 'this month', 'Q4', 'exploring'"},
                "notes": {"type": "string", "description": "short context for the specialist"},
            },
            "required": ["vertical"],
        },
    },
    {
        "name": "escalate_to_human",
        "description": "Hand off to a human teammate for complaints, refunds, or anything you can't resolve.",
        "input_schema": {
            "type": "object",
            "properties": {
                "reason": {"type": "string"},
                "urgency": {"type": "string", "enum": ["low", "normal", "high"]},
            },
            "required": ["reason"],
        },
    },
    {
        "name": "save_user_memory",
        "description": (
            "Persist a durable fact about the user (diet, family, preferences, current trip). "
            "Use expires_at for trip-scoped facts ('+30d' or an ISO date); omit for permanent prefs."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "fact": {"type": "string"},
                "tags": {"type": "array", "items": {"type": "string"}},
                "confidence": {"type": "number"},
                "expires_at": {"type": "string", "description": "'+30d' relative, or ISO date/datetime"},
            },
            "required": ["fact"],
        },
    },
]

_HANDLERS = {
    "search_vendors": search_vendors,
    "create_lead": create_lead,
    "escalate_to_human": escalate_to_human,
    "save_user_memory": save_user_memory,
}


def dispatch(name: str, tool_input: Optional[dict], ctx: ToolContext) -> dict:
    """Run a tool by name. Always returns a dict; logs + wraps any failure."""
    handler = _HANDLERS.get(name)
    if handler is None:
        log.warning("tool_unknown", tool=name)
        return {"error": f"unknown tool: {name}"}
    try:
        return handler(ctx, **(tool_input or {}))
    except TypeError as e:
        log.warning("tool_bad_args", tool=name, error=str(e))
        return {"error": f"bad arguments for {name}: {e}"}
    except Exception as e:
        log.warning("tool_failed", tool=name, error=str(e))
        return {"error": f"{name} failed"}
