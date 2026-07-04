"""Tabduct Python host — native-messaging registration (PROTOCOL.md §9).

Installs/removes the Chrome native-messaging manifest (+ Windows registry key) and
generates a launcher with the ABSOLUTE python path + entry script embedded, so
Chrome's minimal-env spawn resolves the interpreter. The extension id is computed
from the shared extension/manifest.json `key` (no separate id to drift) — it MUST
match every other host's id. Mirrors hosts/node/src/register.js.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from tabduct_host.constants import NATIVE_HOST_NAME

HOST_DIR = Path(__file__).resolve().parent.parent          # hosts/python
REPO = HOST_DIR.parent.parent                              # repo root
MANIFEST = REPO / "extension" / "manifest.json"
ENTRY = HOST_DIR / "tabduct_host" / "__main__.py"

_DARWIN = {"chrome": "Google/Chrome", "chromium": "Chromium", "edge": "Microsoft Edge", "brave": "BraveSoftware/Brave-Browser"}
_LINUX = {"chrome": "google-chrome", "chromium": "chromium", "brave": "BraveSoftware/Brave-Browser", "edge": "microsoft-edge"}
_WIN_VENDOR = {"chrome": r"Google\Chrome", "edge": r"Microsoft\Edge", "brave": r"BraveSoftware\Brave-Browser", "chromium": "Chromium"}


def extension_id() -> str:
    """Chrome id = sha256(SPKI DER) first 16 bytes, each nibble 0..f -> a..p."""
    m = json.loads(MANIFEST.read_text(encoding="utf-8"))
    key = m.get("key")
    if not key:
        raise SystemExit("extension/manifest.json has no `key` — run scripts/gen-key.js first")
    der = base64.b64decode(key)
    hex32 = hashlib.sha256(der).hexdigest()[:32]
    return "".join(chr(97 + int(c, 16)) for c in hex32)


def _launcher_path() -> Path:
    return HOST_DIR / ("run_host.bat" if os.name == "nt" else "run_host.sh")


def _write_launcher() -> Path:
    """Emit a launcher pinning the current python + entry script (Chrome spawns this)."""
    lp = _launcher_path()
    py, entry = sys.executable, str(ENTRY)
    if os.name == "nt":
        lp.write_text(f'@echo off\r\n"{py}" "{entry}"\r\n', encoding="utf-8")
    else:
        lp.write_text(f'#!/usr/bin/env bash\nexec "{py}" "{entry}"\n', encoding="utf-8")
        lp.chmod(0o755)
    return lp


def _manifest_dir(browser: str) -> Path | None:
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / _DARWIN.get(browser, _DARWIN["chrome"]) / "NativeMessagingHosts"
    if sys.platform.startswith("linux"):
        return home / ".config" / _LINUX.get(browser, "google-chrome") / "NativeMessagingHosts"
    return None  # win32 → registry


def _win_reg_key(browser: str) -> str:
    return rf"HKCU\Software\{_WIN_VENDOR.get(browser, r'Google\Chrome')}\NativeMessagingHosts\{NATIVE_HOST_NAME}"


def _manifest_body() -> str:
    return json.dumps({
        "name": NATIVE_HOST_NAME,
        "description": "Tabduct native host (Python)",
        "path": str(_launcher_path()),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id()}/"],
    }, indent=2)


def register(browser: str = "chrome") -> None:
    _write_launcher()
    body = _manifest_body()
    if os.name == "nt":
        mpath = HOST_DIR / f"{NATIVE_HOST_NAME}.json"
        mpath.write_text(body, encoding="utf-8")
        subprocess.run(["reg", "add", _win_reg_key(browser), "/ve", "/t", "REG_SZ", "/d", str(mpath), "/f"], check=True)
        print(f"[tabduct] registered (python, {browser}, Windows). manifest: {mpath}", file=sys.stderr)
    else:
        d = _manifest_dir(browser)
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{NATIVE_HOST_NAME}.json").write_text(body, encoding="utf-8")
        print(f"[tabduct] registered (python, {browser}). manifest: {d / (NATIVE_HOST_NAME + '.json')}", file=sys.stderr)


def unregister(browser: str = "chrome") -> None:
    if os.name == "nt":
        subprocess.run(["reg", "delete", _win_reg_key(browser), "/f"], check=False)
        (HOST_DIR / f"{NATIVE_HOST_NAME}.json").unlink(missing_ok=True)
    else:
        d = _manifest_dir(browser)
        (d / f"{NATIVE_HOST_NAME}.json").unlink(missing_ok=True)
    print(f"[tabduct] unregistered (python, {browser}).", file=sys.stderr)
