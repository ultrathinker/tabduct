"""Tabduct host — shared constants.

Single source of truth for the protocol version is the language-neutral
protocol/tools.schema.json (same as hosts/node/src/constants.js). Nothing is
hand-duplicated here: the catalog is read once at import time.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from typing import Any

NATIVE_HOST_NAME = "com.tabduct.host"
DEFAULT_PORT = 12310  # direct-mode host default/fallback (the popup MAY pin a port)
MCP_PATH = "/mcp"
BIND_HOST = "127.0.0.1"

MAX_FRAME_BYTES = 32 * 1024 * 1024  # inbound frame cap (screenshots); oversize is skipped, not fatal
OUT_FRAME_MAX_BYTES = 1024 * 1024  # Chrome hard cap host->extension (1 MB)
MCP_REQUEST_MAX_BYTES = 8 * 1024 * 1024  # max HTTP request body we buffer (nice-to-have)
INVOKE_TIMEOUT_MS = 20_000  # per tool_call round-trip
INVOKE_TIMEOUT_S = INVOKE_TIMEOUT_MS / 1000.0
STOP_GRACE_S = 2.0  # force-close hung connections after this

# Resolve the repo-relative catalog regardless of CWD / install layout. This file
# lives at <repo>/hosts/python/tabduct_host/constants.py → repo root is 3 levels up.
_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.abspath(os.path.join(_HERE, "..", "..", ".."))
CATALOG_PATH = os.path.join(_REPO, "protocol", "tools.schema.json")


def base_dir() -> str:
    """Where Tabduct keeps its state (~/.tabduct). TABDUCT_DIR overrides for tests."""
    return os.environ.get("TABDUCT_DIR") or os.path.join(os.path.expanduser("~"), ".tabduct")


@lru_cache(maxsize=1)
def _load_catalog() -> dict[str, Any]:
    with open(CATALOG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


CATALOG: dict[str, Any] = _load_catalog()
PROTOCOL_VERSION: int = CATALOG["protocolVersion"]

# Tool catalog served verbatim over MCP tools/list (name/description/inputSchema).
TOOLS: list[dict[str, Any]] = [
    {"name": t["name"], "description": t.get("description"), "inputSchema": t.get("inputSchema", {})}
    for t in CATALOG["tools"]
]


def allowed_hosts(port: int) -> set[str]:
    """Loopback hosts accepted by the DNS-rebinding Host check (all pin to loopback)."""
    return {f"{BIND_HOST}:{port}", f"localhost:{port}", f"[::1]:{port}"}


# Wire error codes (PROTOCOL.md §6).
class ERR:
    UNKNOWN_TOOL = "UNKNOWN_TOOL"
    TAB_NOT_FOUND = "TAB_NOT_FOUND"
    TIMEOUT = "TIMEOUT"
    CSP_BLOCKED = "CSP_BLOCKED"
    SCRIPT_ERROR = "SCRIPT_ERROR"
    FRAME_TOO_LARGE = "FRAME_TOO_LARGE"
    VERSION_MISMATCH = "VERSION_MISMATCH"
    INVALID_ARGS = "INVALID_ARGS"
    INTERNAL = "INTERNAL"
    NOT_SHARED = "NOT_SHARED"
    ORIGIN_DRIFT = "ORIGIN_DRIFT"
    ORIGIN_DENIED = "ORIGIN_DENIED"
    CAP_NOT_GRANTED = "CAP_NOT_GRANTED"
    CDP_NOT_PERMITTED = "CDP_NOT_PERMITTED"
    AMBIGUOUS_INSTANCE = "AMBIGUOUS_INSTANCE"
    INSTANCE_GONE = "INSTANCE_GONE"
