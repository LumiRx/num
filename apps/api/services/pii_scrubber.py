"""Light-touch PII scrubber. Regex only for v0 — Haiku-based scrubber lands in task #8."""
from __future__ import annotations

import re

# Conservative patterns — too aggressive scrubs accidentally redacts non-PII.
_PATTERNS = [
    # Credit card-ish (13-19 digits with optional separators)
    (re.compile(r"\b(?:\d[ -]?){13,19}\b"), "[REDACTED_CARD]"),
    # Passport-style (1-2 letters then 6-9 digits)
    (re.compile(r"\b[A-Z]{1,2}\d{6,9}\b"), "[REDACTED_PASSPORT]"),
    # Thai national ID (1-2345-67890-12-3)
    (re.compile(r"\b\d-\d{4}-\d{5}-\d{2}-\d\b"), "[REDACTED_THAI_ID]"),
]


def scrub(text: str) -> str:
    if not text:
        return text
    out = text
    for pattern, replacement in _PATTERNS:
        out = pattern.sub(replacement, out)
    return out
