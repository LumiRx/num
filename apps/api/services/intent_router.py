"""Cheap intent classification with Claude Haiku."""
from __future__ import annotations

from typing import Literal

import structlog

from apps.api.deps import get_anthropic
from apps.api.services.costing import Usage
from apps.api.settings import get_settings

log = structlog.get_logger()

Intent = Literal["TOURIST", "WHALE_LEAD", "BOOKING_INTENT", "SUPPORT", "SMALLTALK", "PARTNER_COMMAND"]

VALID_INTENTS: set[str] = {
    "TOURIST",
    "WHALE_LEAD",
    "BOOKING_INTENT",
    "SUPPORT",
    "SMALLTALK",
    "PARTNER_COMMAND",
}

_PROMPT = """Classify the user's intent into exactly one of:
TOURIST | WHALE_LEAD | BOOKING_INTENT | SUPPORT | SMALLTALK | PARTNER_COMMAND

Definitions:
- TOURIST: food, drinks, spas, beaches, day trips, transport, general local recommendations
- WHALE_LEAD: relocating, buying/renting property, international schools, long-stay visas, relocation services, medical retreats
- BOOKING_INTENT: user wants to actually reserve / book / pay now
- SUPPORT: frustration, confusion, complaint, refund request
- SMALLTALK: greetings, chit-chat, user volunteering profile info
- PARTNER_COMMAND: driver/merchant internal command

Respond with ONLY the label.

Message: {message}"""


def classify_intent(text: str) -> tuple[Intent, Usage]:
    """Return (intent label, token Usage). Never raises — defaults to TOURIST."""
    s = get_settings()
    try:
        resp = get_anthropic().messages.create(
            model=s.CLAUDE_MODEL_FAST,
            max_tokens=10,
            messages=[{"role": "user", "content": _PROMPT.format(message=text)}],
        )
        usage = Usage.from_anthropic(s.CLAUDE_MODEL_FAST, resp, purpose="intent")
        label = resp.content[0].text.strip().upper()
        if label not in VALID_INTENTS:
            log.warning("intent_router_unknown_label", label=label)
            return "TOURIST", usage
        return label, usage  # type: ignore[return-value]
    except Exception as e:
        log.warning("intent_router_failed", error=str(e))
        return "TOURIST", Usage(model=s.CLAUDE_MODEL_FAST, purpose="intent")
