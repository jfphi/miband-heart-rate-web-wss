from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import urllib.error
import urllib.request
import uuid
from typing import Any

COOKIE_NAME = "lovense_uid"
COOKIE_MAX_AGE = 365 * 24 * 60 * 60
TOKEN_URL = "https://api.lovense-api.com/api/basicApi/getToken"
TOKEN_ERROR = "無法取得玩具授權"

_UID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


class LovenseTokenError(Exception):
    def __init__(self) -> None:
        super().__init__(TOKEN_ERROR)


def lovense_settings() -> dict[str, str] | None:
    token = (os.getenv("LOVENSE_DEVELOPER_TOKEN") or "").strip()
    platform = (os.getenv("LOVENSE_PLATFORM") or "").strip()
    secret = (os.getenv("LOVENSE_SESSION_SECRET") or "").strip()
    if not token or not platform or not secret:
        return None
    return {"token": token, "platform": platform, "secret": secret}


def new_uid() -> str:
    return str(uuid.uuid4())


def sign_uid(uid: str, secret: str) -> str:
    sig = hmac.new(secret.encode(), uid.encode(), hashlib.sha256).hexdigest()
    return f"{uid}.{sig}"


def verify_uid(value: str | None, secret: str) -> str | None:
    if not value or not secret:
        return None
    uid, dot, sig = value.partition(".")
    if not dot or not _UID_RE.match(uid) or not sig:
        return None
    expected = hmac.new(secret.encode(), uid.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        return None
    return uid


def fetch_auth_token(
    developer_token: str,
    uid: str,
    *,
    opener: Any = urllib.request.urlopen,
) -> str:
    body = json.dumps({"token": developer_token, "uid": uid}).encode()
    request = urllib.request.Request(
        TOKEN_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
        method="POST",
    )
    try:
        with opener(request, timeout=10) as response:
            raw = response.read()
    except (OSError, TimeoutError, urllib.error.URLError) as exc:
        raise LovenseTokenError() from exc
    try:
        payload = json.loads(raw.decode())
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise LovenseTokenError() from exc
    if not isinstance(payload, dict) or payload.get("code") != 0:
        raise LovenseTokenError()
    data = payload.get("data")
    auth = data.get("authToken") if isinstance(data, dict) else None
    if not isinstance(auth, str) or not auth.strip():
        raise LovenseTokenError()
    return auth


def issue_session(cookie_value: str | None) -> tuple[dict[str, str], str]:
    settings = lovense_settings()
    if settings is None:
        raise LovenseTokenError()
    uid = verify_uid(cookie_value, settings["secret"]) or new_uid()
    auth = fetch_auth_token(settings["token"], uid)
    signed = sign_uid(uid, settings["secret"])
    return (
        {"uid": uid, "authToken": auth, "platform": settings["platform"]},
        signed,
    )
