"""Tabduct host — instance discovery (PROTOCOL.md §9a).

Each running host writes its OWN file under ``~/.tabduct/instances/<id>.json``
(per-instance files → no shared-file write race). Written on ``open``, removed on
clean shutdown. Files are 0600 and the dir 0700 (they hold a live bearer token).
On Windows, POSIX mode bits are a no-op (best-effort; the Node host additionally
applies an ACL — out of scope for conformance). Mirrors
hosts/node/src/discovery.js.
"""

from __future__ import annotations

import json
import os
import re
import tempfile

from tabduct_host.constants import base_dir


def _instances_dir() -> str:
    return os.path.join(base_dir(), "instances")


def _entry_path(instance_id: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", str(instance_id))
    return os.path.join(_instances_dir(), f"{safe}.json")


def write_entry(entry: dict) -> None:
    """Atomically publish a discovery entry (0600 file in a 0700 dir)."""
    d = _instances_dir()
    os.makedirs(d, exist_ok=True)
    try:
        os.chmod(d, 0o700)
    except OSError:
        pass
    path = _entry_path(entry["instanceId"])
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp", prefix="entry.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(entry, f, indent=2)
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, path)  # atomic publish — readers never see a partial file
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass


def remove_entry(instance_id: str) -> None:
    try:
        os.remove(_entry_path(instance_id))
    except OSError:
        pass
