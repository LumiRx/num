"""Centralised env config via pydantic-settings."""
from __future__ import annotations

from functools import lru_cache
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # App
    APP_ENV: str = "development"
    APP_BASE_URL: str = "http://localhost:8000"
    LOG_LEVEL: str = "INFO"

    # LLM
    ANTHROPIC_API_KEY: str
    CLAUDE_MODEL_CHAT: str = "claude-sonnet-4-6"
    CLAUDE_MODEL_FAST: str = "claude-haiku-4-5-20251001"

    # Memory
    # Recency+confidence recall is the default and needs no embedding vendor.
    # MEMORY_RECALL_LIMIT caps how many live facts get loaded into the prompt.
    MEMORY_RECALL_LIMIT: int = 40
    # Optional pgvector upgrade — set OPENAI_API_KEY to enable semantic recall.
    OPENAI_API_KEY: Optional[str] = None
    EMBEDDING_MODEL: str = "text-embedding-3-small"
    EMBEDDING_DIM: int = 1536

    # Twilio
    TWILIO_ACCOUNT_SID: Optional[str] = None
    TWILIO_AUTH_TOKEN: Optional[str] = None
    TWILIO_PHONE_NUMBER: Optional[str] = None
    TWILIO_WHATSAPP_FROM: Optional[str] = None

    # LINE
    LINE_CHANNEL_ID: Optional[str] = None
    LINE_CHANNEL_SECRET: Optional[str] = None
    LINE_CHANNEL_ACCESS_TOKEN: Optional[str] = None

    # WeChat
    WECHAT_APP_ID: Optional[str] = None
    WECHAT_APP_SECRET: Optional[str] = None
    WECHAT_TOKEN: Optional[str] = None
    WECHAT_AES_KEY: Optional[str] = None

    # Supabase
    SUPABASE_URL: str
    SUPABASE_SERVICE_ROLE_KEY: str
    SUPABASE_ANON_KEY: Optional[str] = None
    SUPABASE_DB_URL: Optional[str] = None

    # Encryption
    KMS_PROVIDER: str = "supabase_vault"
    KMS_KEY_ID: Optional[str] = None
    AWS_REGION: str = "ap-southeast-1"
    AWS_ACCESS_KEY_ID: Optional[str] = None
    AWS_SECRET_ACCESS_KEY: Optional[str] = None

    # Workers
    REDIS_URL: str = "redis://localhost:6379/0"

    # 5arz human verification (Sprint 1 — off by default; see services/sarz_verify.py)
    SARZ_VERIFY_ENABLED: bool = False
    SARZ_AGENT_KEY: Optional[str] = None          # arz_live_... NUM's 5arz agent key
    SARZ_API_URL: str = "https://api.5arz.com"
    SARZ_VERIFY_URL: str = "https://5arz.com/verify"
    SARZ_SETTLEMENT_ENABLED: bool = False         # Sprint 3 — mint Agent-Tx-Binding on settle

    # Observability
    SENTRY_DSN: Optional[str] = None

    # Ops alerts (Slack incoming webhook for #num-ops)
    SLACK_OPS_WEBHOOK_URL: Optional[str] = None

    # Multi-tenancy
    DEFAULT_PARTNER_TENANT_ID: Optional[str] = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
