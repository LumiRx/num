"""5arz human-verification service — Sprint 1 of the verified-agentic-concierge build.

Proves the human behind a NUM user is a real, unique person via 5arz
Proof-of-Human-Fulfillment (PoHF), and gates high-value actions (whale
hand-off, payment) on a valid credential.

Design notes
------------
* Config-gated + best-effort. When ``SARZ_VERIFY_ENABLED`` is false (default) or
  no agent key is set, every function no-ops and NUM behaves exactly as before —
  safe to ship dark and flip on per tenant. Same pattern as the optional
  OpenAI-embeddings upgrade.
* Two tiers: ``proof_of_human`` (light, default for every user) and ``identity``
  (Stripe-Identity grade, for bookings + whale leads / KYC).
* Stores only a credential id + tier on the user — never raw PII (PDPA). The
  PoHF is portable and independently verifiable at 5arz's public JWKS.

Companion migration: ``infra/supabase/migrations/0007_sarz_human_verification.sql``
Spec: ``docs/5arz_x_NUM_Verified_Agentic_Concierge_SPEC.md``
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlencode

import structlog

from apps.api.deps import get_supabase
from apps.api.settings import get_settings

log = structlog.get_logger()

TIER_UNVERIFIED = "unverified"
TIER_POH = "proof_of_human"
TIER_IDENTITY = "identity"
_TIER_RANK = {TIER_UNVERIFIED: 0, "pending": 0, TIER_POH: 1, TIER_IDENTITY: 2}


def _enabled() -> bool:
    """5arz verification is active only when explicitly turned on AND a key is set."""
    s = get_settings()
    return bool(getattr(s, "SARZ_VERIFY_ENABLED", False) and getattr(s, "SARZ_AGENT_KEY", None))


def start_verification(user_uuid: str, lang: str = "en", tier: str = TIER_POH) -> Optional[str]:
    """Begin verification for a user.

    Returns a hosted verify URL to send them, or ``None`` when disabled / on
    error (NUM then behaves as today). Creates a ``pending`` marker on the user
    and hands back a one-tap link to 5arz's hosted human-check; completion is
    recorded by :func:`record_credential` (from the callback router or a poll).
    """
    if not _enabled():
        return None
    try:
        s = get_settings()
        ref = f"num_{user_uuid}"
        get_supabase().table("users").update(
            {"human_tier": "pending", "human_verify_ref": ref}
        ).eq("user_uuid", user_uuid).execute()
        base = (getattr(s, "SARZ_VERIFY_URL", None) or "https://5arz.com/verify").rstrip("/")
        qs = urlencode({"ref": ref, "tier": tier, "lang": lang})
        return f"{base}?{qs}"
    except Exception as e:  # never break the reply path
        log.warning("sarz_start_verification_failed", user_uuid=user_uuid, error=str(e))
        return None


def record_credential(
    user_uuid: str,
    pohf_jti: str,
    tier: str = TIER_POH,
    unique_human_jti: Optional[str] = None,
    member_ref: Optional[str] = None,
) -> bool:
    """Persist a completed 5arz verification onto the user. Best-effort.

    Called by the 5arz completion callback (a small router, or a poll worker).
    """
    try:
        ts = datetime.now(timezone.utc).isoformat()
        get_supabase().table("users").update(
            {
                "human_tier": tier,
                "pohf_jti": pohf_jti,
                "unique_human_jti": unique_human_jti,
                "human_verify_ref": member_ref,
                "human_verified_at": ts,
            }
        ).eq("user_uuid", user_uuid).execute()
        log.info("sarz_human_verified", user_uuid=user_uuid, tier=tier, pohf_jti=pohf_jti)
        return True
    except Exception as e:
        log.warning("sarz_record_credential_failed", user_uuid=user_uuid, error=str(e))
        return False


def get_status(user_uuid: str) -> dict:
    """Return ``{human_tier, pohf_jti, unique_human_jti, human_verified_at}``. Never raises."""
    try:
        r = (
            get_supabase()
            .table("users")
            .select("human_tier, pohf_jti, unique_human_jti, human_verified_at")
            .eq("user_uuid", user_uuid)
            .limit(1)
            .execute()
        )
        if r.data:
            return r.data[0]
    except Exception as e:
        log.warning("sarz_get_status_failed", user_uuid=user_uuid, error=str(e))
    return {"human_tier": TIER_UNVERIFIED}


def is_verified(user_uuid: str, min_tier: str = TIER_POH) -> bool:
    """Gate helper — ``True`` if the user meets ``min_tier``.

    Use before a whale hand-off or a payment. When disabled, returns ``True``
    (no gating) so NUM behaves exactly as before the flag is flipped on.
    """
    if not _enabled():
        return True
    tier = (get_status(user_uuid) or {}).get("human_tier") or TIER_UNVERIFIED
    return _TIER_RANK.get(tier, 0) >= _TIER_RANK.get(min_tier, 1)


def reverify(pohf_jti: Optional[str]) -> bool:
    """Re-check a credential is still valid at 5arz before a sensitive action.

    Best-effort; returns ``True`` when disabled or unreachable (fail-open — the
    stored credential is the source of truth, this is defense in depth).
    """
    if not _enabled() or not pohf_jti:
        return True
    try:
        import httpx  # transitive dep of supabase/anthropic; no new requirement

        s = get_settings()
        api = (getattr(s, "SARZ_API_URL", None) or "https://api.5arz.com").rstrip("/")
        key = getattr(s, "SARZ_AGENT_KEY", "") or ""
        resp = httpx.get(
            f"{api}/api/credentials/{pohf_jti}",
            headers={"Authorization": f"Bearer {key}"},
            timeout=4.0,
        )
        if resp.status_code == 200:
            data = resp.json()
            return bool(data.get("ok", True)) and data.get("status") not in ("revoked", "expired")
        return True
    except Exception as e:
        log.warning("sarz_reverify_failed", jti=pohf_jti, error=str(e))
        return True


def verification_notice(lang: str = "en") -> Optional[str]:
    """A one-line, localized prompt inviting a new user to verify — appended to
    the first reply next to the PDPA notice. ``None`` when disabled.

    Kept minimal; move into the ``strings`` service for full localization later.
    """
    if not _enabled():
        return None
    _msgs = {
        "en": "To unlock bookings and priority help, verify you're a real person — it takes a few seconds.",
        "th": "เพื่อปลดล็อกการจองและความช่วยเหลือพิเศษ โปรดยืนยันว่าคุณเป็นบุคคลจริง ใช้เวลาไม่กี่วินาที",
        "zh": "为解锁预订与优先服务，请验证您是真实用户，仅需几秒。",
    }
    return _msgs.get(lang, _msgs["en"])
