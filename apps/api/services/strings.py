"""Localized system strings — consent notice, fallback, delete confirmation.

These are the handful of messages NUM must deliver even when (especially when)
the LLM is unavailable, plus the PDPA consent disclosure that must be exact and
audited, never paraphrased by the model.

Coverage: top pilot languages first-class (EN / TH / ZH / RU), plus JA / KO /
DE / FR / ES. Unknown codes fall back to English. `get()` never raises.

Native-speaker QA status: EN authored; TH/ZH/RU drafted — flag for the Thai
team + partner reviewers before pilot (tracked in LAUNCH_READINESS §1).
"""
from __future__ import annotations

STRINGS: dict[str, dict[str, str]] = {
    "consent_notice": {
        "en": (
            "🔒 First time here — a quick note: NUM saves your chat and preferences "
            "to give you personal help. Reply DELETE at any time and we erase everything."
        ),
        "th": (
            "🔒 ครั้งแรกกับ NUM: เราบันทึกแชทและความชอบของคุณเพื่อให้บริการแบบส่วนตัว "
            "พิมพ์ DELETE ได้ทุกเมื่อ เราจะลบข้อมูลของคุณทั้งหมด"
        ),
        "zh": (
            "🔒 首次使用 NUM:我们会保存您的聊天记录和偏好,以便提供个性化服务。"
            "随时回复 DELETE,我们将删除您的全部数据。"
        ),
        "ru": (
            "🔒 Вы впервые в NUM: мы сохраняем чат и предпочтения, чтобы помогать вам "
            "персонально. Отправьте DELETE в любой момент — и мы удалим все ваши данные."
        ),
        "ja": (
            "🔒 NUMのご利用は初めてですね。パーソナライズのため、チャットとご希望を保存します。"
            "いつでも DELETE と返信いただければ、すべてのデータを削除します。"
        ),
        "ko": (
            "🔒 NUM 첫 이용 안내: 맞춤 지원을 위해 대화와 선호 정보를 저장합니다. "
            "언제든 DELETE 라고 보내시면 모든 데이터를 삭제해 드립니다."
        ),
        "de": (
            "🔒 Zum ersten Mal hier: NUM speichert Chat und Präferenzen für persönliche "
            "Empfehlungen. Antworte jederzeit mit DELETE und wir löschen alles."
        ),
        "fr": (
            "🔒 Première visite : NUM enregistre votre chat et vos préférences pour une aide "
            "personnalisée. Répondez DELETE à tout moment et nous effaçons tout."
        ),
        "es": (
            "🔒 Primera vez aquí: NUM guarda tu chat y preferencias para ayudarte de forma "
            "personal. Responde DELETE en cualquier momento y borramos todo."
        ),
    },
    "fallback": {
        "en": (
            "I'm having trouble reaching my brain right now — try me again in a minute. "
            "If it's urgent, reply HUMAN and someone will jump in."
        ),
        "th": (
            "ตอนนี้ระบบมีปัญหาชั่วคราว ลองอีกครั้งในอีกสักครู่นะคะ "
            "ถ้าเร่งด่วน พิมพ์ HUMAN แล้วเจ้าหน้าที่จะเข้ามาช่วยทันที"
        ),
        "zh": (
            "系统暂时出了点小问题,请稍后再试。"
            "如果情况紧急,请回复 HUMAN,马上会有工作人员为您服务。"
        ),
        "ru": (
            "Сейчас у меня технические неполадки — попробуйте снова через минуту. "
            "Если срочно, отправьте HUMAN, и подключится живой человек."
        ),
        "ja": (
            "現在システムに一時的な問題が発生しています。少ししてからもう一度お試しください。"
            "お急ぎの場合は HUMAN と返信いただければ担当者が対応します。"
        ),
        "ko": (
            "지금 시스템에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요. "
            "급하시면 HUMAN 이라고 보내 주시면 담당자가 바로 도와드립니다."
        ),
        "de": (
            "Ich habe gerade technische Probleme — versuch es in einer Minute noch einmal. "
            "Wenn es dringend ist, antworte mit HUMAN und ein Mensch übernimmt."
        ),
        "fr": (
            "J'ai un souci technique pour le moment — réessayez dans une minute. "
            "Si c'est urgent, répondez HUMAN et quelqu'un prendra le relais."
        ),
        "es": (
            "Tengo un problema técnico ahora mismo; inténtalo de nuevo en un minuto. "
            "Si es urgente, responde HUMAN y una persona te atenderá."
        ),
    },
    "delete_confirmed": {
        "en": (
            "Done — your chat history, preferences, and profile have been erased. "
            "If you ever message again, you'll start completely fresh. 👋"
        ),
        "th": (
            "เรียบร้อยค่ะ — ประวัติแชท ความชอบ และโปรไฟล์ของคุณถูกลบทั้งหมดแล้ว "
            "หากทักมาใหม่ จะเริ่มต้นใหม่ทั้งหมด 👋"
        ),
        "zh": (
            "已完成 — 您的聊天记录、偏好和个人资料已全部删除。"
            "如果您以后再联系我们,一切将重新开始。👋"
        ),
        "ru": (
            "Готово — история чата, предпочтения и профиль полностью удалены. "
            "Если напишете снова, всё начнётся с чистого листа. 👋"
        ),
        "ja": (
            "完了しました — チャット履歴、設定、プロフィールをすべて削除しました。"
            "またご連絡いただく場合は、最初からのスタートになります。👋"
        ),
        "ko": (
            "완료되었습니다 — 대화 기록, 선호 정보, 프로필이 모두 삭제되었습니다. "
            "다시 연락 주시면 처음부터 새로 시작합니다. 👋"
        ),
        "de": (
            "Erledigt — Chatverlauf, Präferenzen und Profil wurden gelöscht. "
            "Wenn du wieder schreibst, fängst du komplett neu an. 👋"
        ),
        "fr": (
            "C'est fait — historique, préférences et profil ont été effacés. "
            "Si vous nous réécrivez, tout repartira de zéro. 👋"
        ),
        "es": (
            "Listo — tu historial, preferencias y perfil han sido borrados. "
            "Si vuelves a escribir, empezarás totalmente de cero. 👋"
        ),
    },
}

_DEFAULT_LANG = "en"


def get(key: str, lang: str | None) -> str:
    """Return the localized string for `key`, falling back to English.

    Never raises: unknown keys return '' (logged upstream if it matters);
    unknown/None langs fall back to English. Lang codes are normalized to the
    primary subtag ('zh-CN' -> 'zh').
    """
    table = STRINGS.get(key)
    if not table:
        return ""
    code = (lang or _DEFAULT_LANG).lower().split("-")[0].split("_")[0]
    return table.get(code) or table[_DEFAULT_LANG]
