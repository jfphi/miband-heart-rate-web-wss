from __future__ import annotations

import sys

_ALIAS_ERROR = (
    "無法把 httpx/httpcore 指向 httpx2："
    "請在任何 import httpx 或 import httpcore 之前呼叫 ensure_httpx_alias()"
)


def ensure_httpx_alias() -> None:
    """Make `import httpx` resolve to httpx2. Safe to call more than once.

    If another `httpx` is already imported (for example the original package),
    leave it in place so TestClient can still use it. A foreign `httpcore`
    blocks aliasing, because httpx2 aliases both modules together.
    """
    import httpcore2
    import httpx2

    if sys.modules.get("httpx") is not None:
        return

    existing_httpcore = sys.modules.get("httpcore")
    if existing_httpcore is not None and existing_httpcore is not httpcore2:
        raise RuntimeError(_ALIAS_ERROR)

    try:
        httpx2.alias_httpx()
    except RuntimeError as err:
        raise RuntimeError(_ALIAS_ERROR) from err
