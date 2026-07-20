from decimal import Decimal

from apps.api.services.costing import PRICING, Usage, compute_cost


def test_sonnet_cost_in_and_out():
    # 1000 in + 500 out on Sonnet 4.6 ($3 / $15 per M) = 0.003 + 0.0075
    assert compute_cost("claude-sonnet-4-6", 1000, 500) == Decimal("0.0105")


def test_haiku_cost_in_and_out():
    # 2000 in + 100 out on Haiku 4.5 ($1 / $5 per M) = 0.002 + 0.0005
    assert compute_cost("claude-haiku-4-5-20251001", 2000, 100) == Decimal("0.0025")


def test_haiku_alias_matches_dated_id():
    assert compute_cost("claude-haiku-4-5", 2000, 100) == compute_cost(
        "claude-haiku-4-5-20251001", 2000, 100
    )


def test_unknown_model_is_free_not_crash():
    assert compute_cost("some-future-model", 1000, 1000) == Decimal("0")


def test_zero_tokens():
    assert compute_cost("claude-sonnet-4-6", 0, 0) == Decimal("0")


def test_usage_dataclass_cost_and_fields():
    u = Usage(model="claude-sonnet-4-6", input_tokens=1000, output_tokens=500, purpose="reply")
    assert u.cost_usd == Decimal("0.0105")
    assert u.purpose == "reply"


def test_from_anthropic_reads_usage_object():
    class _U:
        input_tokens = 300
        output_tokens = 60

    class _Resp:
        usage = _U()

    u = Usage.from_anthropic("claude-haiku-4-5", _Resp(), purpose="intent")
    assert u.input_tokens == 300
    assert u.output_tokens == 60
    assert u.purpose == "intent"
    # 300*1/1e6 + 60*5/1e6 = 0.0003 + 0.0003
    assert u.cost_usd == Decimal("0.0006")


def test_pricing_table_has_active_models():
    for model in ("claude-sonnet-4-6", "claude-haiku-4-5-20251001"):
        assert model in PRICING
