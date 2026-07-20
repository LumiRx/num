#!/usr/bin/env python3
"""Live end-to-end smoke test for the NUM inbound pipeline.

Exercises the full chain against REAL Claude + the LIVE Supabase project:
    identity -> language detect -> intent (Haiku) -> persist message ->
    record intent cost -> concierge reply (Sonnet) -> persist reply ->
    record reply cost.

Prereqs:
    1. cp apps/api/.env.example apps/api/.env  and fill ANTHROPIC_API_KEY +
       SUPABASE_SERVICE_ROLE_KEY  (SUPABASE_URL is already set).
    2. pip install -r apps/api/requirements.txt
    3. From the repo root, e.g.:
         python scripts/smoke_pipeline.py "หาร้านกาแฟเงียบ ๆ แถวป่าตอง"
         python scripts/smoke_pipeline.py "Здравствуйте, нужен трансфер из аэропорта"
         python scripts/smoke_pipeline.py "我想找一家安静的海鲜餐厅"

Prints the detected language, intent, reply, and turn cost, and writes real
rows to users / messages / llm_usage that you can inspect in Supabase.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / "apps" / "api" / ".env")

from apps.api.schemas.messages import IncomingMessage  # noqa: E402
from apps.api.services import lang_detect, pipeline  # noqa: E402


def main() -> None:
    text = sys.argv[1] if len(sys.argv) > 1 else "Hi! Can you recommend a great seafood spot near Patong?"
    handle = sys.argv[2] if len(sys.argv) > 2 else "+66900000000"

    det = lang_detect.detect(text)
    print(f"→ inbound : {text!r}")
    print(f"→ language: {det.code}  (confidence {det.confidence:.2f}, via {det.method})")

    reply = pipeline.handle_inbound(IncomingMessage(channel="web", handle=handle, text=text))
    print(f"← reply   : {reply}")

    print("\nInspect the live rows in Supabase:")
    print("  select role, lang, detected_intent, content from messages order by created_at desc limit 2;")
    print("  select purpose, model, input_tokens, output_tokens, cost_usd from llm_usage order by created_at desc limit 2;")
    print("  select * from v_cost_per_user_daily order by day desc limit 5;")
    print("  select * from v_language_mix;")


if __name__ == "__main__":
    main()
