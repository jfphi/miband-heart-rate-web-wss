from __future__ import annotations

import sys


def ensure_httpx_alias() -> None:
    """Make `import httpx` resolve to httpx2. Safe to call more than once."""
    import httpx2

    if sys.modules.get("httpx") is httpx2:
        return
    httpx2.alias_httpx()
