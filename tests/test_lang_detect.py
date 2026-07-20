from apps.api.services.lang_detect import detect


def test_thai():
    d = detect("สวัสดีครับ ขอร้านอาหารแนะนำหน่อย")
    assert d.code == "th"
    assert d.is_confident


def test_chinese_simplified():
    d = detect("你好，请问附近哪里有好吃的餐厅？")
    assert d.code == "zh"
    assert d.is_confident


def test_japanese_kana_only():
    assert detect("こんにちは、おすすめのレストランはありますか").code == "ja"


def test_japanese_kanji_plus_kana():
    # Kana present alongside Han => Japanese, not Chinese.
    assert detect("東京タワーに行きたいです").code == "ja"


def test_korean():
    d = detect("안녕하세요 맛집 추천해 주세요")
    assert d.code == "ko"
    assert d.is_confident


def test_russian():
    d = detect("Здравствуйте, посоветуйте хороший ресторан рядом")
    assert d.code == "ru"
    assert d.is_confident


def test_arabic():
    assert detect("مرحبا، أين يوجد مطعم جيد قريب").code == "ar"


def test_english_latin():
    # langdetect if present, else graceful 'en' fallback — both land on 'en'.
    assert detect("Hi, can you recommend a good seafood spot near Patong?").code == "en"


def test_empty_whitespace_and_non_alpha_are_undetermined():
    assert detect("").code == "und"
    assert detect("   ").code == "und"
    assert detect("👍🏝️🔥").code == "und"
    assert detect("12345 !!! @#$").code == "und"
