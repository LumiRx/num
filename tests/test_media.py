"""Tests for inbound media capture.

This path takes untrusted bytes from the internet and writes them to our
storage, so the tests are weighted toward the ways it should REFUSE:
lying content-types, oversized files, non-images, malformed webhooks. The
happy path is one test; the guards are the rest.

Also pinned: a media failure must never break the reply. Losing a photo is
annoying; losing the answer is a broken product.
"""
from __future__ import annotations

import sys
import types
from types import SimpleNamespace

for _n in ("anthropic", "supabase", "openai"):
    if _n not in sys.modules:
        m = types.ModuleType(_n)
        if _n == "anthropic": m.Anthropic = object
        if _n == "supabase": m.Client = object; m.create_client = lambda *a, **k: None
        if _n == "openai": m.OpenAI = object
        sys.modules[_n] = m

from apps.api.adapters import twilio as tw          # noqa: E402
from apps.api.schemas.messages import IncomingMessage, MediaItem  # noqa: E402
from apps.api.services import media                 # noqa: E402

JPEG = b"\xff\xd8\xff" + b"x" * 100
PNG  = b"\x89PNG\r\n\x1a\n" + b"x" * 100


# ───────────────────────── adapter: parsing the webhook ─────────────────────

def test_parse_media_none():
    assert tw.parse_media({}) == []
    assert tw.parse_media({"NumMedia": "0"}) == []


def test_parse_media_single_photo():
    items = tw.parse_media({
        "NumMedia": "1",
        "MediaUrl0": "https://api.twilio.com/.../Media/ME123",
        "MediaContentType0": "image/jpeg",
    })
    assert len(items) == 1
    assert items[0].content_type == "image/jpeg"
    assert items[0].is_image
    assert items[0].provider_sid == "ME123"


def test_parse_media_multiple():
    form = {"NumMedia": "3"}
    for i in range(3):
        form[f"MediaUrl{i}"] = f"https://api.twilio.com/x/ME{i}"
        form[f"MediaContentType{i}"] = "image/png"
    assert len(tw.parse_media(form)) == 3


def test_parse_media_caps_flood():
    """A guest sending 50 photos shouldn't make us fetch 50 files."""
    form = {"NumMedia": "50"}
    for i in range(50):
        form[f"MediaUrl{i}"] = f"https://api.twilio.com/x/ME{i}"
        form[f"MediaContentType{i}"] = "image/jpeg"
    assert len(tw.parse_media(form)) == tw._MAX_MEDIA_PER_MESSAGE


def test_parse_media_survives_garbage():
    assert tw.parse_media({"NumMedia": "not-a-number"}) == []
    # declared 2 but only one usable pair
    items = tw.parse_media({
        "NumMedia": "2",
        "MediaUrl0": "https://api.twilio.com/x/ME0", "MediaContentType0": "image/jpeg",
        "MediaUrl1": "", "MediaContentType1": "image/jpeg",
    })
    assert len(items) == 1


def test_parse_whatsapp_carries_media():
    msg = tw.parse_whatsapp("whatsapp:+447700900000", "here's the car", {
        "NumMedia": "1",
        "MediaUrl0": "https://api.twilio.com/x/ME9",
        "MediaContentType0": "image/jpeg",
    })
    assert msg.channel == "whatsapp"
    assert msg.has_media and len(msg.media) == 1


def test_text_only_message_has_no_media():
    msg = tw.parse_sms("+447700900000", "hello", {})
    assert msg.has_media is False


# ───────────────────────── content sniffing (the security bit) ──────────────

def test_sniff_accepts_real_images():
    assert media._sniff_ok("image/jpeg", JPEG)
    assert media._sniff_ok("image/png", PNG)


def test_sniff_rejects_lying_content_type():
    """A file claiming to be a JPEG that isn't must not be stored."""
    assert media._sniff_ok("image/jpeg", PNG) is False
    assert media._sniff_ok("image/png", JPEG) is False
    assert media._sniff_ok("image/jpeg", b"<?php system($_GET[0]); ?>") is False


def test_sniff_rejects_disallowed_types():
    assert media._sniff_ok("application/pdf", b"%PDF-1.4") is False
    assert media._sniff_ok("text/html", b"<html>") is False
    assert media._sniff_ok("application/octet-stream", JPEG) is False


def test_extension_mapping():
    assert media._extension("image/jpeg") == "jpg"
    assert media._extension("image/png") == "png"
    assert media._extension("application/pdf") == "bin"


# ───────────────────────── storage path ─────────────────────────────────────

class _Storage:
    def __init__(self, sink, fail=False): self._sink, self._fail = sink, fail
    def from_(self, bucket): self._sink["bucket"] = bucket; return self
    def upload(self, key, blob, opts):
        if self._fail: raise RuntimeError("upload failed")
        self._sink["uploads"].append({"key": key, "bytes": len(blob), "opts": opts})


class _Table:
    def __init__(self, sink): self._sink = sink
    def insert(self, payload): self._sink["rows"].append(payload); self._payload = payload; return self
    def execute(self): return SimpleNamespace(data=[{"id": "media-1", **self._payload}])


class _SB:
    def __init__(self, fail_upload=False):
        self.sink = {"uploads": [], "rows": [], "bucket": None}
        self.storage = _Storage(self.sink, fail_upload)
    def table(self, name): self.sink["table"] = name; return _Table(self.sink)


def _patch(monkeypatch, sb, blob=JPEG):
    monkeypatch.setattr(media, "get_supabase", lambda: sb)
    monkeypatch.setattr(media, "_fetch", lambda item: blob)


def test_store_media_happy_path(monkeypatch):
    sb = _SB(); _patch(monkeypatch, sb)
    out = media.store_media(
        [MediaItem(url="https://api.twilio.com/x/ME1", content_type="image/jpeg")],
        "user-abc", message_id="msg-1", conversation_id="conv-1",
    )
    assert len(out) == 1
    up = sb.sink["uploads"][0]
    assert up["key"].startswith("user-abc/") and up["key"].endswith(".jpg")
    assert sb.sink["bucket"] == media.BUCKET
    row = sb.sink["rows"][0]
    assert row["message_id"] == "msg-1" and row["purpose"] == "chat"


def test_store_media_key_is_generated_not_user_supplied(monkeypatch):
    """Storage keys must never derive from anything the sender controls."""
    sb = _SB(); _patch(monkeypatch, sb)
    media.store_media(
        [MediaItem(url="https://api.twilio.com/x/../../etc/passwd", content_type="image/jpeg")],
        "user-abc",
    )
    key = sb.sink["uploads"][0]["key"]
    assert ".." not in key and "passwd" not in key
    assert key.startswith("user-abc/")


def test_store_media_rejects_type_mismatch(monkeypatch):
    """Declared image/jpeg, actually a PNG → dropped, nothing written."""
    sb = _SB(); _patch(monkeypatch, sb, blob=PNG)
    out = media.store_media(
        [MediaItem(url="https://api.twilio.com/x/ME1", content_type="image/jpeg")], "u1")
    assert out == [] and sb.sink["uploads"] == []


def test_store_media_skips_non_images(monkeypatch):
    sb = _SB(); _patch(monkeypatch, sb)
    out = media.store_media(
        [MediaItem(url="https://x/1", content_type="application/pdf")], "u1")
    assert out == [] and sb.sink["uploads"] == []


def test_store_media_handles_fetch_failure(monkeypatch):
    sb = _SB()
    monkeypatch.setattr(media, "get_supabase", lambda: sb)
    monkeypatch.setattr(media, "_fetch", lambda item: None)
    out = media.store_media([MediaItem(url="https://x/1", content_type="image/jpeg")], "u1")
    assert out == [] and sb.sink["uploads"] == []


def test_store_media_survives_upload_failure(monkeypatch):
    sb = _SB(fail_upload=True); _patch(monkeypatch, sb)
    out = media.store_media([MediaItem(url="https://x/1", content_type="image/jpeg")], "u1")
    assert out == []          # no row written for a file that never landed
    assert sb.sink["rows"] == []


def test_store_media_empty_list_is_noop(monkeypatch):
    sb = _SB(); _patch(monkeypatch, sb)
    assert media.store_media([], "u1") == []


def test_store_media_partial_batch(monkeypatch):
    """One good photo, one liar — the good one still stores."""
    sb = _SB()
    monkeypatch.setattr(media, "get_supabase", lambda: sb)
    blobs = {"good": JPEG, "bad": PNG}
    monkeypatch.setattr(media, "_fetch", lambda item: blobs["good" if "good" in item.url else "bad"])
    out = media.store_media([
        MediaItem(url="https://x/good", content_type="image/jpeg"),
        MediaItem(url="https://x/bad",  content_type="image/jpeg"),
    ], "u1")
    assert len(out) == 1 and len(sb.sink["uploads"]) == 1


def test_vehicle_purpose_tagging(monkeypatch):
    sb = _SB(); _patch(monkeypatch, sb)
    media.store_media([MediaItem(url="https://x/1", content_type="image/jpeg")],
                      "u1", purpose="vehicle_record")
    assert sb.sink["rows"][0]["purpose"] == "vehicle_record"


# ───────────────────────── pipeline resilience ──────────────────────────────

def test_media_failure_never_breaks_the_reply(monkeypatch):
    """The whole point: a broken photo must not cost the user their answer."""
    from apps.api.services import pipeline

    monkeypatch.setattr(pipeline.identity, "upsert_user_by_handle",
                        lambda m: {"user_uuid": "u-1", "preferred_lang": "en"})
    monkeypatch.setattr(pipeline.identity, "update_preferred_lang", lambda *a, **k: None)
    monkeypatch.setattr(pipeline.persistence, "open_or_get_conversation", lambda *a: "c-1")
    monkeypatch.setattr(pipeline.persistence, "log_message", lambda *a, **k: "m-1")
    monkeypatch.setattr(pipeline.persistence, "log_llm_usage", lambda *a, **k: None)
    monkeypatch.setattr(pipeline.persistence, "log_events", lambda *a, **k: None)
    monkeypatch.setattr(pipeline.persistence, "recent_turns", lambda *a, **k: [])
    monkeypatch.setattr(pipeline.intent_router, "classify_intent",
                        lambda t: ("TOURIST", SimpleNamespace(model="m", input_tokens=1, output_tokens=1, purpose="intent")))
    monkeypatch.setattr(pipeline.memory, "lookup", lambda *a, **k: [])
    monkeypatch.setattr(pipeline.concierge, "generate_reply",
                        lambda *a, **k: ("Nice car!", SimpleNamespace(model="m", input_tokens=1, output_tokens=1, purpose="reply")))

    def _explode(*a, **k):
        raise RuntimeError("storage on fire")
    monkeypatch.setattr(pipeline.media, "store_media", _explode)

    msg = IncomingMessage(channel="whatsapp", handle="+447700900000", text="here's the car",
                          media=[MediaItem(url="https://x/1", content_type="image/jpeg")])
    assert pipeline.handle_inbound(msg) == "Nice car!"
