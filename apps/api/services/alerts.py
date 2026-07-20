"""Ops alerts → Slack #num-ops via an incoming webhook.

Best-effort and dependency-free (stdlib urllib). If SLACK_OPS_WEBHOOK_URL is
unset, alerts are silently skipped — the pipeline never depends on this.
Set up: Slack → create an Incoming Webhook app for #num-ops → put the URL in
SLACK_OPS_WEBHOOK_URL.
"""
from __future__ import annotations

import json
import urllib.request
from typing import Optional

import structlog

from apps.api.settings import get_settings

log = structlog.get_logger()


def _post(text: str) -> None:
    url = getattr(get_settings(), "SLACK_OPS_WEBHOOK_URL", None)
    if not url:
        log.debug("slack_alert_skipped_no_webhook", preview=text[:80])
        return
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps({"text": text}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=5)  # noqa: S310 (trusted, user-configured URL)
    except Exception as e:  # never let an alert break the response path
        log.warning("slack_alert_failed", error=str(e))


def whale_lead(
    vertical: str,
    budget_band: Optional[str] = None,
    timeline: Optional[str] = None,
    user_uuid: Optional[str] = None,
    lead_id: Optional[str] = None,
) -> None:
    extra = " · ".join(x for x in (budget_band, timeline) if x)
    _post(
        f":whale: *New whale lead* — {vertical}"
        + (f" · {extra}" if extra else "")
        + f"\nlead `{lead_id}` · user `{user_uuid}`"
    )


def escalation(reason: str, urgency: str = "normal", user_uuid: Optional[str] = None) -> None:
    icon = ":rotating_light:" if urgency == "high" else ":raising_hand:"
    _post(f"{icon} *Escalation ({urgency})* — {reason}\nuser `{user_uuid}`")


def cost_guard(user_uuid: str, cost_usd: str, threshold_usd: str) -> None:
    _post(
        f":moneybag: *Cost guard* — user `{user_uuid}` crossed ${threshold_usd} "
        f"(now ${cost_usd}) in a single conversation."
    )
