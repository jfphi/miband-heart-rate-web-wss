from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[2]
load_dotenv(ROOT_DIR / ".env")

BackendName = str


def normalize_backend(value: str | None) -> str:
    raw = (value or "fastapi_wss").strip().lower()
    if raw in {"firebase"}:
        return "firebase"
    if raw in {"fastapi_wss", "wss", "fastapi"}:
        return "fastapi_wss"
    return "fastapi_wss"


def get_public_config() -> dict:
    backend = normalize_backend(os.getenv("MIBAND_BACKEND"))
    ws_url = (os.getenv("MIBAND_WS_URL") or "").strip()
    return {
        "backend": backend,
        "wsUrl": ws_url,
        "firebase": {
            "apiKey": (os.getenv("MIBAND_FIREBASE_API_KEY") or "").strip(),
            "authDomain": (os.getenv("MIBAND_FIREBASE_AUTH_DOMAIN") or "").strip(),
            "databaseURL": (os.getenv("MIBAND_FIREBASE_DATABASE_URL") or "").strip(),
            "projectId": (os.getenv("MIBAND_FIREBASE_PROJECT_ID") or "").strip(),
            "appId": (os.getenv("MIBAND_FIREBASE_APP_ID") or "").strip(),
        },
    }
