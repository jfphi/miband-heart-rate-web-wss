from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.httpx_compat import ensure_httpx_alias

ensure_httpx_alias()

from fastapi.testclient import TestClient

from server.app.rooms import RoomManager
from server.app.server import create_app, static_cache_headers
from server.app.settings import get_public_config
from server.app.version import public_asset_version, reset_asset_version_cache


class AssetVersionTests(unittest.TestCase):
    def tearDown(self) -> None:
        reset_asset_version_cache()

    def test_public_config_includes_asset_version(self) -> None:
        cfg = get_public_config()
        self.assertTrue(cfg["assetVersion"])
        self.assertLessEqual(len(cfg["assetVersion"]), 16)

    def test_html_is_not_stored_in_browser_cache(self) -> None:
        html = Path("public/index.html")
        self.assertEqual(static_cache_headers(html)["Cache-Control"], "no-store")
        js = Path("public/js/publish.js")
        self.assertEqual(static_cache_headers(js)["Cache-Control"], "no-cache")

    def test_api_config_sends_no_store(self) -> None:
        app = create_app(RoomManager())
        with TestClient(app) as client:
            res = client.get("/api/config")
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.headers.get("cache-control"), "no-store")
            self.assertTrue(res.json().get("assetVersion"))
            page = client.get("/publish.html")
            self.assertEqual(page.status_code, 200)
            self.assertEqual(page.headers.get("cache-control"), "no-store")

    def test_version_changes_when_public_file_changes(self) -> None:
        reset_asset_version_cache()
        first = public_asset_version()
        reset_asset_version_cache()
        second = public_asset_version()
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
