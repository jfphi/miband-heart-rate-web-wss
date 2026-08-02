"""從 .env 產生 public/js/config.generated.js（Cloudflare Pages 等純靜態部署用）。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.app.settings import get_public_config  # noqa: E402


def main() -> None:
    cfg = get_public_config()
    # 前端內部仍用 wss | firebase
    frontend = {
        "backend": "firebase" if cfg["backend"] == "firebase" else "wss",
        "wsUrl": cfg["wsUrl"],
        "firebase": cfg["firebase"],
    }
    out = ROOT / "public" / "js" / "config.generated.js"
    body = (
        "/* Generated from .env — do not edit by hand */\n"
        f"export const appConfig = {json.dumps(frontend, ensure_ascii=False, indent=2)};\n"
    )
    out.write_text(body, encoding="utf-8")
    print(f"Wrote {out} (backend={frontend['backend']})")


if __name__ == "__main__":
    main()
