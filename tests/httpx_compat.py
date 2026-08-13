from __future__ import annotations

import sys


def ensure_httpx_alias() -> None:
    """Make `import httpx` resolve to httpx2. Safe to call more than once.

    If another `httpx` is already imported (for example the original package),
    leave it in place so TestClient can still use it.
    """
    import httpx2

    existing = sys.modules.get("httpx")
    if existing is httpx2:
        return
    if existing is not None:
        return
    try:
        httpx2.alias_httpx()
    except RuntimeError as err:
        raise RuntimeError(
            "無法把 httpx 指向 httpx2：請在任何 import httpx 之前呼叫 ensure_httpx_alias()"
        ) from err
