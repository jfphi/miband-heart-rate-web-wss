from __future__ import annotations

import hashlib
import os
from pathlib import Path

from .settings import ROOT_DIR

_ASSET_SUFFIXES = {".js", ".css", ".html"}
_SKIP_NAMES = {"config.generated.js", "config.local.js"}

_cache: dict[str, str | None] = {"sig": None, "version": None}


def _pinned_version() -> str:
    for key in ("MIBAND_ASSET_VERSION", "RENDER_GIT_COMMIT", "CF_PAGES_COMMIT_SHA"):
        raw = (os.getenv(key) or "").strip()
        if raw:
            return raw[:16]
    return ""


def _public_signature(public_dir: Path) -> str:
    parts: list[str] = []
    if not public_dir.is_dir():
        return ""
    for path in sorted(public_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.name in _SKIP_NAMES:
            continue
        if path.suffix.lower() not in _ASSET_SUFFIXES:
            continue
        stat = path.stat()
        rel = path.relative_to(public_dir).as_posix()
        parts.append(f"{rel}:{stat.st_mtime_ns}:{stat.st_size}")
    return "\n".join(parts)


def public_asset_version(*, public_dir: Path | None = None) -> str:
    """Stable stamp for public JS/CSS/HTML. Changes when those files change."""
    pinned = _pinned_version()
    if pinned:
        return pinned
    root = public_dir or (ROOT_DIR / "public")
    sig = _public_signature(root)
    if _cache["sig"] == sig and _cache["version"]:
        return str(_cache["version"])
    digest = hashlib.sha256(sig.encode("utf-8")).hexdigest()[:12]
    _cache["sig"] = sig
    _cache["version"] = digest
    return digest


def reset_asset_version_cache() -> None:
    _cache["sig"] = None
    _cache["version"] = None
