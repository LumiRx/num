"""Per-LLM-call cost accounting.

Every Anthropic (and, later, OpenAI embedding) call produces a `Usage` with
token counts; `cost_usd` converts that to dollars via `PRICING`. Logging these
rows is what lets us price the Pro tier honestly and show real cost-per-active-
user on the ops dashboard.

PRICING is USD per 1,000,000 tokens. Verify against the live rate card and
update *here only* — every cost in the system flows from this one table.
Source (Jun 2026): https://platform.claude.com/pricing
  - claude-sonnet-4-6   $3 in / $15 out
  - claude-haiku-4-5    $1 in / $5  out
  - text-embedding-3-small (OpenAI) $0.02 in
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

PRICING: dict[str, dict[str, Decimal]] = {
    "claude-sonnet-4-6": {"input": Decimal("3"), "output": Decimal("15")},
    "claude-haiku-4-5-20251001": {"input": Decimal("1"), "output": Decimal("5")},
    "claude-haiku-4-5": {"input": Decimal("1"), "output": Decimal("5")},
    "claude-opus-4-8": {"input": Decimal("15"), "output": Decimal("75")},
    # OpenAI embeddings — output side is free.
    "text-embedding-3-small": {"input": Decimal("0.02"), "output": Decimal("0")},
}

_MILLION = Decimal(1_000_000)


def compute_cost(model: str, input_tokens: int, output_tokens: int) -> Decimal:
    """USD cost for a call. Unknown models cost 0 (and are worth a log upstream)."""
    rate = PRICING.get(model)
    if rate is None:
        return Decimal("0")
    return (rate["input"] * Decimal(input_tokens) + rate["output"] * Decimal(output_tokens)) / _MILLION


@dataclass(frozen=True)
class Usage:
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    purpose: str = "reply"  # 'intent' | 'reply' | 'embed' | 'tool'

    @property
    def cost_usd(self) -> Decimal:
        return compute_cost(self.model, self.input_tokens, self.output_tokens)

    @classmethod
    def from_anthropic(cls, model: str, resp: Any, purpose: str) -> "Usage":
        """Build Usage from an Anthropic Message response (resp.usage.*)."""
        u = getattr(resp, "usage", None)
        return cls(
            model=model,
            input_tokens=int(getattr(u, "input_tokens", 0) or 0),
            output_tokens=int(getattr(u, "output_tokens", 0) or 0),
            purpose=purpose,
        )
