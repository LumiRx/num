"""NUM — FastAPI entry point (Path B).

Run locally:
    source .venv/bin/activate
    uvicorn apps.api.main:app --reload --port 8000

Deploy on Railway:
    Procfile -> `web: uvicorn apps.api.main:app --host 0.0.0.0 --port $PORT`
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

import structlog
from dotenv import load_dotenv
from fastapi import FastAPI

# Load .env BEFORE anything reads settings.
load_dotenv()

from apps.api.routers import healthz, line, qr, twilio, wechat  # noqa: E402
from apps.api.settings import get_settings  # noqa: E402

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    log.info(
        "num_starting",
        env=s.APP_ENV,
        model_chat=s.CLAUDE_MODEL_CHAT,
        model_fast=s.CLAUDE_MODEL_FAST,
        supabase=s.SUPABASE_URL,
    )

    # Optional Sentry init — only if DSN is set.
    if s.SENTRY_DSN:
        try:
            import sentry_sdk
            from sentry_sdk.integrations.fastapi import FastApiIntegration

            sentry_sdk.init(dsn=s.SENTRY_DSN, integrations=[FastApiIntegration()], traces_sample_rate=0.1)
            log.info("sentry_initialised")
        except Exception as e:
            log.warning("sentry_init_failed", error=str(e))

    yield
    log.info("num_shutdown")


app = FastAPI(title="NUM — AI Concierge", lifespan=lifespan)
app.include_router(healthz.router)
app.include_router(twilio.router)
app.include_router(line.router)
app.include_router(wechat.router)
app.include_router(qr.router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "apps.api.main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
        reload=True,
    )
