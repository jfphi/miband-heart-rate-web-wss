from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.httpx_compat import ensure_httpx_alias


class HttpxCompatTests(unittest.TestCase):
    def test_alias_is_idempotent_and_exposes_httpx2(self) -> None:
        import httpx2

        ensure_httpx_alias()
        ensure_httpx_alias()
        import httpx

        self.assertIs(httpx, httpx2)


if __name__ == "__main__":
    unittest.main()
