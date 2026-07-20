"""Make the repo root importable + stub heavy SDKs so tests run fully offline."""
import pathlib
import sys
import types

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


def _stub(name: str, attrs: dict) -> None:
    """Register a stub module only if the real SDK isn't installed."""
    try:
        __import__(name)
        return  # real package present — use it
    except Exception:
        pass
    if name in sys.modules:
        return
    mod = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(mod, key, value)
    sys.modules[name] = mod


_stub("anthropic", {"Anthropic": object})
_stub("supabase", {"Client": object, "create_client": lambda *a, **k: None})
_stub("openai", {"OpenAI": object})
