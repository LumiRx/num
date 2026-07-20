"""Offline tests for the PDPA privacy service + localized strings + pipeline consent flow."""
import sys
import types

import pytest

for _name in ("anthropic", "supabase", "openai"):
    if _name not in sys.modules:
        mod = types.ModuleType(_name)
        if _name == "anthropic":
            mod.Anthropic = object
        if _name == "supabase":
            mod.Client = object
            mod.create_client = lambda *a, **k: None
        if _name == "openai":
            mod.OpenAI = object
        sys.modules[_name] = mod

from apps.api.services import privacy, strings  # noqa: E402


# ---------------------------------------------------------------- strings ---

ALL_LANGS = ["en", "th", "zh", "ru", "ja", "ko", "de", "fr", "es"]


def test_strings_full_coverage():
    for key in ("consent_notice", "fallback", "delete_confirmed"):
        for lang in ALL_LANGS:
            val = strings.get(key, lang)
            assert val, f"missing {key}/{lang}"


def test_strings_fallback_and_normalization():
    assert strings.get("fallback", None) == strings.get("fallback", "en")
    assert strings.get("fallback", "xx") == strings.get("fallback", "en")
    assert strings.get("consent_notice", "zh-CN") == strings.get("consent_notice", "zh")
    assert strings.get("consent_notice", "TH") == strings.get("consent_notice", "th")
    assert strings.get("nonexistent_key", "en") == ""


def test_delete_keyword_mentioned_in_every_consent_notice():
    # The opt-out instruction must actually appear in the disclosure.
    for lang in ALL_LANGS:
        assert "DELETE" in strings.get("consent_notice", lang), lang


# ----------------------------------------------------- is_delete_request ---

@pytest.mark.parametrize(
    "text",
    [
        "DELETE", "delete", "  Delete  ", "delete my data", "Forget me", "erase my data",
        "ลบข้อมูล", "ลบข้อมูลของฉัน",
        "删除我的数据", "删除数据", "刪除我的資料",
        "УДАЛИТЬ", "удали мои данные",
        "データ削除", "削除して",
        "내 데이터 삭제",
        "borra mis datos", "supprimer mes données", "lösche meine daten",
        "delete!", "delete.",
    ],
)
def test_delete_request_positive(text):
    assert privacy.is_delete_request(text) is True


@pytest.mark.parametrize(
    "text",
    [
        None, "", "   ",
        "can you delete that restaurant from my list",
        "I want to delete my booking for tomorrow",
        "how do I delete a photo on LINE",
        "what does DELETE do?",  # question about it, not a request — has extra words
        "ร้านนี้ลบข้อมูลเมนูเก่าหรือยัง",
        "hello",
    ],
)
def test_delete_request_negative(text):
    assert privacy.is_delete_request(text) is False


# ---------------------------------------------------- delete_user_data ------


class _FakeTable:
    """Chainable fake for supabase table ops; records terminal calls."""

    def __init__(self, sink, name):
        self._sink, self._name = sink, name
        self._op = None
        self._payload = None

    def insert(self, payload):
        self._op, self._payload = "insert", payload
        return self

    def update(self, payload):
        self._op, self._payload = "update", payload
        return self

    def delete(self):
        self._op = "delete"
        return self

    def eq(self, *_a, **_k):
        return self

    def execute(self):
        self._sink.append((self._name, self._op, self._payload))
        return types.SimpleNamespace(data=[])


class _FakeSB:
    def __init__(self):
        self.calls = []

    def table(self, name):
        return _FakeTable(self.calls, name)


def test_delete_user_data_order_and_retention(monkeypatch):
    sb = _FakeSB()
    monkeypatch.setattr(privacy, "get_supabase", lambda: sb)

    ok = privacy.delete_user_data("u-123", channel="line")
    assert ok is True

    ops = [(t, op) for t, op, _ in sb.calls]
    # audit trail first, audit trail last
    assert ops[0] == ("consent_events", "insert")
    assert ops[-1] == ("consent_events", "insert")
    # anonymize retained business records — never delete them
    assert ("llm_usage", "update") in ops
    assert ("leads", "update") in ops
    assert ("bookings", "update") in ops
    assert ("llm_usage", "delete") not in ops
    assert ("leads", "delete") not in ops
    # behavioral events + user row deleted; user delete after anonymization
    assert ("events", "delete") in ops
    assert ("users", "delete") in ops
    assert ops.index(("users", "delete")) > ops.index(("llm_usage", "update"))

    # llm_usage anonymization nulls both links
    llm_payload = next(p for t, op, p in sb.calls if t == "llm_usage" and op == "update")
    assert llm_payload == {"user_uuid": None, "conversation_id": None}


def test_delete_user_data_failure_returns_false(monkeypatch):
    class _Boom:
        def table(self, name):
            raise RuntimeError("db down")

    monkeypatch.setattr(privacy, "get_supabase", lambda: _Boom())
    assert privacy.delete_user_data("u-123") is False


# ------------------------------------------------- pipeline consent flow ----


def _pipeline_with_stubs(monkeypatch, *, is_new: bool):
    from apps.api.schemas.messages import IncomingMessage
    from apps.api.services import pipeline

    user = {"user_uuid": "u-1", "preferred_lang": "en"}
    if is_new:
        user["_is_new"] = True

    consent_log: list = []
    deleted: list = []

    monkeypatch.setattr(pipeline.identity, "upsert_user_by_handle", lambda m: dict(user))
    monkeypatch.setattr(pipeline.identity, "update_preferred_lang", lambda *a, **k: None)
    monkeypatch.setattr(pipeline.persistence, "open_or_get_conversation", lambda *a: "c-1")
    monkeypatch.setattr(pipeline.persistence, "log_message", lambda *a, **k: "m-1")
    monkeypatch.setattr(pipeline.persistence, "log_llm_usage", lambda *a, **k: None)
    monkeypatch.setattr(pipeline.persistence, "log_event", lambda *a, **k: None)
    monkeypatch.setattr(pipeline.persistence, "log_events", lambda *a, **k: None)
    monkeypatch.setattr(pipeline.persistence, "recent_turns", lambda *a, **k: [])
    monkeypatch.setattr(
        pipeline.intent_router, "classify_intent",
        lambda t: ("TOURIST", types.SimpleNamespace(model="m", input_tokens=1, output_tokens=1, purpose="intent")),
    )
    monkeypatch.setattr(pipeline.memory, "lookup", lambda *a, **k: [])
    monkeypatch.setattr(
        pipeline.concierge, "generate_reply",
        lambda *a, **k: ("Here are some ideas!", types.SimpleNamespace(model="m", input_tokens=1, output_tokens=1, purpose="reply")),
    )
    monkeypatch.setattr(
        pipeline.privacy, "log_consent",
        lambda uuid, action, **k: consent_log.append((uuid, action, k)),
    )
    monkeypatch.setattr(
        pipeline.privacy, "delete_user_data",
        lambda uuid, channel=None: deleted.append(uuid) or True,
    )

    def run(text: str) -> str:
        return pipeline.handle_inbound(IncomingMessage(channel="whatsapp", handle="+661", text=text, raw={}))

    return run, consent_log, deleted


def test_new_user_gets_consent_notice(monkeypatch):
    run, consent_log, _ = _pipeline_with_stubs(monkeypatch, is_new=True)
    reply = run("hi, best beach?")
    assert "Here are some ideas!" in reply
    assert strings.get("consent_notice", "en") in reply
    assert ("u-1", "notice_shown") == consent_log[0][:2]


def test_existing_user_no_consent_notice(monkeypatch):
    run, consent_log, _ = _pipeline_with_stubs(monkeypatch, is_new=False)
    reply = run("best beach?")
    assert strings.get("consent_notice", "en") not in reply
    assert consent_log == []


def test_existing_user_delete_short_circuits(monkeypatch):
    run, _, deleted = _pipeline_with_stubs(monkeypatch, is_new=False)
    reply = run("DELETE")
    assert deleted == ["u-1"]
    assert reply == strings.get("delete_confirmed", "en")


def test_new_user_delete_word_does_not_delete(monkeypatch):
    # A brand-new user's first message "delete" has nothing to erase — treat as chat.
    run, _, deleted = _pipeline_with_stubs(monkeypatch, is_new=True)
    reply = run("DELETE")
    assert deleted == []
    assert "Here are some ideas!" in reply


def test_thai_delete_request_confirmed_in_thai(monkeypatch):
    run, _, deleted = _pipeline_with_stubs(monkeypatch, is_new=False)
    reply = run("ลบข้อมูล")
    assert deleted == ["u-1"]
    assert reply == strings.get("delete_confirmed", "th")
