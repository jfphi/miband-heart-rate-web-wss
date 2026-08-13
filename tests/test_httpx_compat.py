from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.httpx_compat import ensure_httpx_alias


class HttpxCompatTests(unittest.TestCase):
    def test_alias_is_idempotent_and_exposes_httpx2(self) -> None:
        import httpx2

        ensure_httpx_alias()
        ensure_httpx_alias()
        import httpx

        self.assertIs(httpx, httpx2)

    def test_leaves_preexisting_httpx_module_in_place(self) -> None:
        import types

        previous = sys.modules.get("httpx")
        fake = types.ModuleType("httpx")
        sys.modules["httpx"] = fake
        try:
            ensure_httpx_alias()
            self.assertIs(sys.modules["httpx"], fake)
        finally:
            if previous is None:
                sys.modules.pop("httpx", None)
            else:
                sys.modules["httpx"] = previous

    def test_rejects_preexisting_other_httpcore(self) -> None:
        import types

        previous_httpx = sys.modules.pop("httpx", None)
        previous_httpcore = sys.modules.get("httpcore")
        fake = types.ModuleType("httpcore")
        sys.modules["httpcore"] = fake
        try:
            with self.assertRaisesRegex(RuntimeError, "import httpcore"):
                ensure_httpx_alias()
        finally:
            if previous_httpcore is None:
                sys.modules.pop("httpcore", None)
            else:
                sys.modules["httpcore"] = previous_httpcore
            if previous_httpx is not None:
                sys.modules["httpx"] = previous_httpx
            else:
                ensure_httpx_alias()

    def test_wraps_alias_runtime_error(self) -> None:
        import httpx2

        previous = sys.modules.pop("httpx", None)
        try:
            with patch.object(
                httpx2, "alias_httpx", side_effect=RuntimeError("already imported")
            ):
                with self.assertRaisesRegex(RuntimeError, "httpx/httpcore"):
                    ensure_httpx_alias()
        finally:
            if previous is not None:
                sys.modules["httpx"] = previous
            else:
                ensure_httpx_alias()


if __name__ == "__main__":
    unittest.main()
