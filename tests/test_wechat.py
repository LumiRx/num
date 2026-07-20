"""Offline unit tests for the WeChat Service Account adapter.

No network, no DB, no live settings: we only exercise adapters.wechat, set the
three env vars Settings requires (so pydantic-settings can instantiate), pin
WECHAT_TOKEN to a known value, and stub the pipeline reply function. The router
itself is not imported here because it pulls in the full pipeline/service stack;
the adapter holds all the signature/parse/reply logic under test.
"""
import hashlib
import os

# Settings() has three required fields with no defaults. Set them before the
# adapter import below triggers get_settings() construction.
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")
os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-key")
os.environ["WECHAT_TOKEN"] = "numtoken"

from apps.api.adapters import wechat as w  # noqa: E402
from apps.api.schemas.messages import IncomingMessage  # noqa: E402


def _sign(token: str, timestamp: str, nonce: str) -> str:
    tmp = "".join(sorted([token, timestamp, nonce]))
    return hashlib.sha1(tmp.encode("utf-8")).hexdigest()


# --- signature -------------------------------------------------------------

def test_verify_signature_known_vector():
    token, ts, nonce = "numtoken", "1700000000", "abc123"
    # Independently computed expected sha1 for the sorted concatenation.
    expected = _sign(token, ts, nonce)
    assert w.verify_signature(token, expected, ts, nonce) is True
    assert w.verify_signature(token, "deadbeef", ts, nonce) is False


def test_verify_signature_missing_token_is_false():
    assert w.verify_signature(None, "anything", "1", "2") is False
    assert w.verify_signature("", "anything", "1", "2") is False


def test_verify_signature_missing_inputs_is_false():
    assert w.verify_signature("numtoken", "", "1", "2") is False


def test_verify_handshake_uses_settings_token():
    ts, nonce = "1700000001", "nonceX"
    sig = _sign("numtoken", ts, nonce)  # WECHAT_TOKEN env is "numtoken"
    assert w.verify_handshake(sig, ts, nonce) is True
    assert w.verify_handshake("nope", ts, nonce) is False


# --- parse -----------------------------------------------------------------

SAMPLE_TEXT_XML = (
    "<xml>"
    "<ToUserName><![CDATA[gh_num_service]]></ToUserName>"
    "<FromUserName><![CDATA[oUserOpenId123]]></FromUserName>"
    "<CreateTime>1700000000</CreateTime>"
    "<MsgType><![CDATA[text]]></MsgType>"
    "<Content><![CDATA[Where can I eat in Patong?]]></Content>"
    "<MsgId>1234567890123456</MsgId>"
    "</xml>"
)


def test_parse_text_xml_extracts_fields():
    parsed = w.parse_inbound(SAMPLE_TEXT_XML)
    assert parsed is not None
    assert parsed["FromUserName"] == "oUserOpenId123"   # the openid
    assert parsed["ToUserName"] == "gh_num_service"
    assert parsed["MsgType"] == "text"
    assert parsed["Content"] == "Where can I eat in Patong?"


def test_parse_handles_bytes_body():
    parsed = w.parse_inbound(SAMPLE_TEXT_XML.encode("utf-8"))
    assert parsed is not None and parsed["FromUserName"] == "oUserOpenId123"


def test_parse_empty_and_malformed_return_none():
    assert w.parse_inbound(b"") is None
    assert w.parse_inbound("") is None
    assert w.parse_inbound("<xml><not closed") is None


def test_to_incoming_maps_openid_and_content():
    parsed = w.parse_inbound(SAMPLE_TEXT_XML)
    msg = w.to_incoming(parsed)
    assert isinstance(msg, IncomingMessage)
    assert msg.channel == "wechat"
    assert msg.handle == "oUserOpenId123"
    assert msg.text == "Where can I eat in Patong?"
    assert msg.raw == parsed


# --- passive reply build / round-trip --------------------------------------

def test_build_text_reply_round_trips():
    reply_text = "Try Kan Eang @ Pier for seafood."
    xml = w.build_text_reply(
        to_user="oUserOpenId123",   # reply goes back TO the original sender
        from_user="gh_num_service",  # FROM the service account
        content=reply_text,
    )
    parsed = w.parse_inbound(xml)
    assert parsed is not None
    assert parsed["ToUserName"] == "oUserOpenId123"
    assert parsed["FromUserName"] == "gh_num_service"
    assert parsed["MsgType"] == "text"
    assert parsed["Content"] == reply_text
    assert parsed["CreateTime"].isdigit()


def test_build_text_reply_escapes_cdata_terminator():
    nasty = "edge ]]> case & <stuff>"
    xml = w.build_text_reply("a", "b", nasty)
    # Must still be well-formed and decode back to the original content.
    parsed = w.parse_inbound(xml)
    assert parsed is not None
    assert parsed["Content"] == nasty


# --- full routing via handle_inbound_xml (pipeline stubbed) ----------------

def _echo_reply(msg: IncomingMessage) -> str:
    # Stand-in for services.pipeline.handle_inbound — no DB, no network.
    return f"echo:{msg.text}"


def test_handle_inbound_text_routes_through_pipeline_and_swaps_names():
    out = w.handle_inbound_xml(SAMPLE_TEXT_XML, _echo_reply)
    parsed = w.parse_inbound(out)
    assert parsed is not None
    assert parsed["MsgType"] == "text"
    # names swapped relative to inbound
    assert parsed["ToUserName"] == "oUserOpenId123"
    assert parsed["FromUserName"] == "gh_num_service"
    assert parsed["Content"] == "echo:Where can I eat in Patong?"


def test_handle_inbound_subscribe_event_sends_start_through_pipeline():
    captured = {}

    def capture(msg: IncomingMessage) -> str:
        captured["text"] = msg.text
        captured["handle"] = msg.handle
        return "Welcome to NUM!"

    sub_xml = (
        "<xml>"
        "<ToUserName><![CDATA[gh_num_service]]></ToUserName>"
        "<FromUserName><![CDATA[oNewFollower]]></FromUserName>"
        "<CreateTime>1700000050</CreateTime>"
        "<MsgType><![CDATA[event]]></MsgType>"
        "<Event><![CDATA[subscribe]]></Event>"
        "</xml>"
    )
    out = w.handle_inbound_xml(sub_xml, capture)
    assert captured["text"] == "START"      # acquisition-source binding preserved
    assert captured["handle"] == "oNewFollower"
    parsed = w.parse_inbound(out)
    assert parsed is not None
    assert parsed["MsgType"] == "text"
    assert parsed["ToUserName"] == "oNewFollower"
    assert parsed["Content"] == "Welcome to NUM!"


def test_handle_inbound_unsubscribe_returns_empty():
    unsub_xml = (
        "<xml>"
        "<ToUserName><![CDATA[gh_num_service]]></ToUserName>"
        "<FromUserName><![CDATA[oLeaver]]></FromUserName>"
        "<MsgType><![CDATA[event]]></MsgType>"
        "<Event><![CDATA[unsubscribe]]></Event>"
        "</xml>"
    )
    assert w.handle_inbound_xml(unsub_xml, _echo_reply) == ""


def test_handle_inbound_unsupported_event_returns_success():
    click_xml = (
        "<xml>"
        "<MsgType><![CDATA[event]]></MsgType>"
        "<Event><![CDATA[CLICK]]></Event>"
        "<FromUserName><![CDATA[oUser]]></FromUserName>"
        "</xml>"
    )
    assert w.handle_inbound_xml(click_xml, _echo_reply) == "success"


def test_handle_inbound_unsupported_msgtype_returns_success():
    image_xml = (
        "<xml>"
        "<MsgType><![CDATA[image]]></MsgType>"
        "<FromUserName><![CDATA[oUser]]></FromUserName>"
        "<PicUrl><![CDATA[http://example.com/x.jpg]]></PicUrl>"
        "</xml>"
    )
    assert w.handle_inbound_xml(image_xml, _echo_reply) == "success"


def test_handle_inbound_malformed_returns_success_not_raise():
    assert w.handle_inbound_xml(b"<xml><broken", _echo_reply) == "success"
    assert w.handle_inbound_xml(b"", _echo_reply) == "success"


def test_handle_inbound_swallows_pipeline_errors():
    def boom(msg: IncomingMessage) -> str:
        raise RuntimeError("pipeline exploded")

    # A failure deep in the pipeline must still yield the no-op sentinel,
    # never a 500 back to WeChat.
    assert w.handle_inbound_xml(SAMPLE_TEXT_XML, boom) == "success"
