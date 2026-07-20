"""Inbound language auto-detection — script-first, zero-LLM.

Strategy:
  1. Scan the message's alphabetic characters by Unicode script. NUM's
     highest-value tourist languages (Thai, Chinese, Russian, Japanese,
     Korean, Arabic) are written in distinctive scripts, so a deterministic
     Unicode-block scan nails them with no dependency and no model call.
  2. For Latin-script text, optionally defer to `langdetect` (already in
     requirements.txt) to separate en/fr/de/es/..., degrading gracefully to
     'en' if the library is unavailable or unsure.

Returns ISO 639-1 codes. 'und' means "undetermined" (only emoji, digits or
punctuation — nothing to detect). No network, no LLM call, microsecond-fast.
"""
from __future__ import annotations

from dataclasses import dataclass

# Unicode ranges -> script bucket. We count every alphabetic char and pick the
# dominant script below. 'han' and 'ja_kana' are reconciled into zh/ja.
_RANGES: tuple[tuple[str, tuple[tuple[int, int], ...]], ...] = (
    ("th", ((0x0E00, 0x0E7F),)),                                      # Thai
    ("ko", ((0xAC00, 0xD7AF), (0x1100, 0x11FF), (0x3130, 0x318F))),   # Hangul
    ("ja_kana", ((0x3040, 0x309F), (0x30A0, 0x30FF))),               # Hiragana/Katakana
    ("ru", ((0x0400, 0x04FF),)),                                      # Cyrillic
    ("ar", ((0x0600, 0x06FF),)),                                      # Arabic
    ("he", ((0x0590, 0x05FF),)),                                      # Hebrew
    ("hi", ((0x0900, 0x097F),)),                                      # Devanagari
    ("han", ((0x4E00, 0x9FFF), (0x3400, 0x4DBF), (0xF900, 0xFAFF))),  # CJK ideographs
    ("latin", ((0x0041, 0x005A), (0x0061, 0x007A), (0x00C0, 0x024F))),
)

# Dominant-script share of alpha chars required before we let a detection
# overwrite a user's stored preferred_lang.
CONFIDENCE_THRESHOLD = 0.6


@dataclass(frozen=True)
class Detection:
    code: str            # ISO 639-1, or 'und'
    confidence: float    # 0..1 — share of alpha chars in the winning script
    method: str          # 'script' | 'langdetect' | 'fallback' | 'empty'

    @property
    def is_confident(self) -> bool:
        return self.code != "und" and self.confidence >= CONFIDENCE_THRESHOLD


def _script_of(cp: int) -> str | None:
    for name, ranges in _RANGES:
        for lo, hi in ranges:
            if lo <= cp <= hi:
                return name
    return None


def detect(text: str) -> Detection:
    """Best-effort language of `text`. Always returns a Detection (never raises)."""
    if not text or not text.strip():
        return Detection("und", 0.0, "empty")

    counts: dict[str, int] = {}
    total = 0
    has_kana = False
    has_han = False
    for ch in text:
        script = _script_of(ord(ch))
        if script is None:
            continue
        total += 1
        if script == "ja_kana":
            has_kana = True
            counts["ja"] = counts.get("ja", 0) + 1
        elif script == "han":
            has_han = True
            counts["han"] = counts.get("han", 0) + 1
        else:
            counts[script] = counts.get(script, 0) + 1

    if total == 0:
        return Detection("und", 0.0, "empty")

    # Japanese vs Chinese: kana present => Japanese (absorb the Han chars);
    # Han with no kana => Chinese.
    han = counts.pop("han", 0)
    if han:
        if has_kana:
            counts["ja"] = counts.get("ja", 0) + han
        else:
            counts["zh"] = counts.get("zh", 0) + han

    winner = max(counts, key=counts.get)
    share = counts[winner] / total

    if winner == "latin":
        return _detect_latin(text, share)

    return Detection(winner, share, "script")


def _detect_latin(text: str, share: float) -> Detection:
    try:
        from langdetect import DetectorFactory, detect_langs

        DetectorFactory.seed = 0  # deterministic across runs
        best = detect_langs(text)[0]
        return Detection(best.lang.split("-")[0], float(best.prob), "langdetect")
    except Exception:
        # Library missing or too little signal — assume the lingua franca.
        return Detection("en", share, "fallback")
