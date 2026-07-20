"""Shared third-party clients (singletons via lru_cache)."""
from __future__ import annotations

from functools import lru_cache

from anthropic import Anthropic
from supabase import Client, create_client

from apps.api.settings import get_settings


@lru_cache
def get_supabase() -> Client:
    s = get_settings()
    return create_client(s.SUPABASE_URL, s.SUPABASE_SERVICE_ROLE_KEY)


@lru_cache
def get_anthropic() -> Anthropic:
    s = get_settings()
    return Anthropic(api_key=s.ANTHROPIC_API_KEY)


@lru_cache
def get_openai():
    """Lazy OpenAI client — only loaded when memory embedding is wired."""
    from openai import OpenAI

    s = get_settings()
    if not s.OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY not configured")
    return OpenAI(api_key=s.OPENAI_API_KEY)
