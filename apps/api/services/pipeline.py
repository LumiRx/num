"""End-to-end inbound pipeline.

ingest -> identify user -> [PDPA delete short-circuit] -> open conversation ->
scrub PII -> detect language -> classify intent -> log user msg (with
lang+intent) -> record intent cost -> refresh preferred_lang -> generate reply
-> log assistant msg -> record reply cost -> [first-contact consent notice] ->
return text.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import structlog

from apps.api.schemas.messages import IncomingMessage
from apps.api.services import (
    concierge,
    identity,
    intent_router,
    lang_detect,
    memory,
    persistence,
    pii_scrubber,
    privacy,
    strings,
)

log = structlog.get_logger()


def handle_inbound_safe(msg: IncomingMessage) -> str:
    """`handle_inbound` with a guaranteed reply — use this from every channel.

    A passenger must never be met with silence. If anything below fails hard
    (DB unreachable, unexpected shape), we log it and hand back the localized
    "try again / reply HUMAN" line instead of a 500 the channel would swallow.
    Language is guessed from the raw inbound text, so the apology still lands in
    the user's script even when the DB that stores their preference is down.
    """
    try:
        return handle_inbound(msg)
    except Exception as e:
        log.exception("pipeline_failed", channel=msg.channel, error=str(e))
        detected = lang_detect.detect(msg.text or "")
        lang_code = detected.code if detected.method == "script" else "en"
        return strings.get("fallback", lang_code)


def handle_inbound(msg: IncomingMessage) -> str:
    user = identity.upsert_user_by_handle(msg)
    user_uuid: str = user["user_uuid"]
    is_new_user = bool(user.pop("_is_new", False))

    # PDPA right-to-erasure: an explicit whole-message delete request skips the
    # LLM entirely — erase, confirm in the user's language, stop. Short trigger
    # phrases fool statistical detection ("DELETE" → 'de'), so only trust the
    # deterministic script detector here; otherwise use the stored preference.
    if not is_new_user and privacy.is_delete_request(msg.text):
        req_lang = lang_detect.detect(msg.text)
        lang_code = (
            req_lang.code
            if req_lang.method == "script"
            else (user.get("preferred_lang") or "en")
        )
        ok = privacy.delete_user_data(user_uuid, channel=msg.channel)
        if ok:
            return strings.get("delete_confirmed", lang_code)
        return strings.get("fallback", lang_code)

    conversation_id = persistence.open_or_get_conversation(user_uuid, msg.channel)

    scrubbed = pii_scrubber.scrub(msg.text)
    lang = lang_detect.detect(scrubbed)  # deterministic, no network

    # Three independent I/O jobs, run concurrently instead of stacked:
    #   intent (Haiku, ~0.5s) is analytics-only — it never gated the reply, so
    #   it has no business adding latency to it;
    #   history + memory are the two reads the reply actually needs.
    # History MUST be read before this turn's message is logged, or the current
    # message would appear twice in the prompt.
    with ThreadPoolExecutor(max_workers=3) as pool:
        intent_job = pool.submit(intent_router.classify_intent, scrubbed)
        history_job = pool.submit(persistence.recent_turns, conversation_id)
        memory_job = pool.submit(memory.lookup, user_uuid, scrubbed, 5)

        history = history_job.result()
        retrieved = memory_job.result()

        reply, reply_usage = concierge.generate_reply(
            user,
            scrubbed,
            conversation_id=conversation_id,
            retrieved_memories=[m["fact"] for m in retrieved],
            history=history,
        )
        # Long finished while the reply was generating.
        intent, intent_usage = intent_job.result()

    log.info(
        "inbound",
        user_uuid=user_uuid,
        intent=intent,
        lang=lang.code,
        lang_method=lang.method,
        history_turns=len(history),
        memories=len(retrieved),
    )

    # Keep the user's preferred language current when we're confident it changed.
    if lang.is_confident and lang.code != (user.get("preferred_lang") or "en"):
        identity.update_preferred_lang(user_uuid, lang.code)

    user_msg_id = persistence.log_message(
        conversation_id,
        user_uuid,
        "user",
        scrubbed,
        lang=lang.code,
        detected_intent=intent,
    )
    assistant_msg_id = persistence.log_message(
        conversation_id, user_uuid, "assistant", reply, lang=lang.code
    )
    persistence.log_llm_usage(conversation_id, user_uuid, intent_usage, message_id=user_msg_id)
    persistence.log_llm_usage(conversation_id, user_uuid, reply_usage, message_id=assistant_msg_id)
    # One insert instead of three sequential ones.
    persistence.log_events([
        {"user_uuid": user_uuid, "name": "message_in",
         "payload": {"channel": msg.channel, "lang": lang.code}, "source": msg.channel},
        {"user_uuid": user_uuid, "name": "intent_classified",
         "payload": {"intent": intent}, "source": msg.channel},
        {"user_uuid": user_uuid, "name": "message_out",
         "payload": {"channel": msg.channel}, "source": msg.channel},
    ])

    # First contact: append the one-time PDPA disclosure (exact string, never
    # LLM-paraphrased) and audit it. First messages are short, so statistical
    # detection is noisy — trust only deterministic script detection (Thai /
    # Chinese / Cyrillic / ...); every Latin-script greeting gets English.
    if is_new_user:
        notice_lang = lang.code if lang.method == "script" else "en"
        notice = strings.get("consent_notice", notice_lang)
        privacy.log_consent(user_uuid, "notice_shown", channel=msg.channel, lang=notice_lang)
        reply = f"{reply}\n\n{notice}"

    return reply
