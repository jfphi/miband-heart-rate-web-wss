from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.httpx_compat import ensure_httpx_alias

ensure_httpx_alias()

from fastapi.testclient import TestClient

from server.app.lovense import LovenseTokenError, fetch_auth_token, sign_uid
from server.app.server import create_app
from server.app.settings import get_public_config

ENV = {
    "LOVENSE_DEVELOPER_TOKEN": "dev-token-value",
    "LOVENSE_PLATFORM": "MiBandHR",
    "LOVENSE_SESSION_SECRET": "session-secret-value",
}
BLANK = {key: "" for key in ENV}


class _Body:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload

    def __enter__(self) -> _Body:
        return self

    def __exit__(self, *args: object) -> bool:
        return False

    def read(self) -> bytes:
        return self.payload


class LovenseSessionTests(unittest.TestCase):
    def test_disabled_status_and_session(self) -> None:
        with patch.dict(os.environ, BLANK, clear=False):
            with TestClient(create_app()) as client:
                status = client.get("/api/lovense/status")
                self.assertEqual(status.status_code, 200)
                self.assertEqual(status.json(), {"enabled": False})
                session = client.post("/api/lovense/session", json={"uid": "attacker"})
                self.assertEqual(session.status_code, 404)

    def test_session_issues_token_and_ignores_body_uid(self) -> None:
        def fake_fetch(token: str, uid: str, opener=None) -> str:
            self.assertEqual(token, ENV["LOVENSE_DEVELOPER_TOKEN"])
            self.assertNotEqual(uid, "attacker-chosen")
            return "user-auth-token"

        with patch.dict(os.environ, ENV, clear=False):
            with patch("server.app.lovense.fetch_auth_token", fake_fetch):
                with TestClient(create_app()) as client:
                    first = client.post(
                        "/api/lovense/session",
                        json={"uid": "attacker-chosen"},
                    )
                    self.assertEqual(first.status_code, 200)
                    self.assertEqual(first.headers["cache-control"], "no-store")
                    body = first.json()
                    self.assertEqual(body["authToken"], "user-auth-token")
                    self.assertEqual(body["platform"], "MiBandHR")
                    self.assertNotEqual(body["uid"], "attacker-chosen")
                    self.assertNotIn("dev-token-value", first.text)
                    self.assertNotIn("session-secret-value", first.text)
                    cookie = first.headers["set-cookie"]
                    self.assertIn("lovense_uid=", cookie)
                    self.assertIn("HttpOnly", cookie)
                    self.assertNotIn("Secure", cookie)

                    second = client.post("/api/lovense/session")
                    self.assertEqual(second.status_code, 200)
                    self.assertEqual(second.json()["uid"], body["uid"])

    def test_tampered_cookie_gets_a_new_uid(self) -> None:
        def fake_fetch(token: str, uid: str, opener=None) -> str:
            return "user-auth-token"

        with patch.dict(os.environ, ENV, clear=False):
            with patch("server.app.lovense.fetch_auth_token", fake_fetch):
                with TestClient(create_app()) as client:
                    first = client.post("/api/lovense/session")
                    original = first.json()["uid"]
                    client.cookies.set(
                        "lovense_uid",
                        "00000000-0000-4000-8000-000000000000.deadbeef",
                    )
                    third = client.post(
                        "/api/lovense/session",
                        json={"uid": original},
                    )
                    self.assertEqual(third.status_code, 200)
                    self.assertNotEqual(third.json()["uid"], original)
                    self.assertNotIn(original, third.json()["uid"])

    def test_public_config_omits_secrets(self) -> None:
        with patch.dict(os.environ, ENV, clear=False):
            raw = json.dumps(get_public_config())
            self.assertNotIn("dev-token-value", raw)
            self.assertNotIn("session-secret-value", raw)
            self.assertNotIn("LOVENSE", raw)

    def test_lovense_failure_is_502_without_token(self) -> None:
        def boom(token: str, uid: str, opener=None) -> str:
            raise LovenseTokenError()

        with patch.dict(os.environ, ENV, clear=False):
            with patch("server.app.lovense.fetch_auth_token", boom):
                with TestClient(create_app()) as client:
                    res = client.post("/api/lovense/session")
                    self.assertEqual(res.status_code, 502)
                    self.assertEqual(res.json()["detail"], "無法取得玩具授權")
                    self.assertNotIn("dev-token-value", res.text)

    def test_fetch_rejects_bad_code_and_timeout(self) -> None:
        def bad_code(request, timeout=10):
            self.assertEqual(timeout, 10)
            sent = json.loads(request.data.decode())
            self.assertEqual(set(sent), {"token", "uid"})
            return _Body(b'{"code": 500, "message": "bad dev-token-value"}')

        with self.assertRaises(LovenseTokenError) as raised:
            fetch_auth_token("dev-token-value", "uid-1", opener=bad_code)
        self.assertNotIn("dev-token-value", str(raised.exception))

        def timed_out(request, timeout=10):
            raise TimeoutError("slow")

        with self.assertRaises(LovenseTokenError):
            fetch_auth_token("dev-token-value", "uid-1", opener=timed_out)

    def test_signed_cookie_round_trip(self) -> None:
        signed = sign_uid(
            "00000000-0000-4000-8000-000000000001",
            ENV["LOVENSE_SESSION_SECRET"],
        )
        self.assertTrue(signed.startswith("00000000-0000-4000-8000-000000000001."))
