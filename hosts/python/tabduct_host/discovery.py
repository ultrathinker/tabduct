"""Tabduct host — instance discovery (PROTOCOL.md §9a).

Each running host writes its OWN file under ``~/.tabduct/instances/<id>.json``
(per-instance files → no shared-file write race). Written on ``open``, removed on
clean shutdown. Files are 0600 and the dir 0700 (they hold a live bearer token).
On Windows, POSIX mode bits are a no-op, so — like the Node host — we apply an
explicit ACL (strip inheritance, grant only the current user). Mirrors
hosts/node/src/discovery.js.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import uuid

from tabduct_host.constants import base_dir

_acl_done: set[str] = set()


def _probe_writable(d: str) -> bool:
    """Create+read+delete a probe file in ``d`` to confirm we still have access."""
    name = f".tabduct-acl-probe-{uuid.uuid4().hex}.tmp"
    p = os.path.join(d, name)
    try:
        with open(p, "w", encoding="utf-8") as f:
            f.write("ok")
        with open(p, "r", encoding="utf-8") as f:
            if f.read() != "ok":
                raise OSError("readback mismatch")
        os.remove(p)
        return True
    except OSError:
        try:
            if os.path.exists(p):
                os.remove(p)
        except OSError:
            pass
        return False


def _restrict_windows_acl(d: str) -> None:
    """Mirror Node's restrictWindowsAcl: 0o700 is a no-op on Windows → set an ACL.

    Defensive: ``/inheritance:r`` strips all inherited ACEs. If the resulting
    ACL would lock our own process out (e.g. DOMAIN\\user string didn't match
    the actual owner identity), we wouldn't notice until a later write/read
    failed inside ``write_entry``. So after restricting we PROBE
    create+read+delete in the dir; on failure we restore inherited
    (user-private, profile-scoped) ACLs and warn rather than brick the state dir.
    """
    if sys.platform != "win32" or d in _acl_done:
        return
    _acl_done.add(d)
    dom = os.environ.get("USERDOMAIN")
    name = os.environ.get("USERNAME")
    user = f"{dom}\\{name}" if dom and name else (name or "")
    if not user:
        return
    try:
        subprocess.run(
            ["icacls", d, "/inheritance:r", "/grant:r", f"{user}:(OI)(CI)F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )  # args as a list → no shell injection
    except OSError as e:
        sys.stderr.write(
            f"[tabduct] icacls restriction failed on {d} (leaving inherited ACLs in place): {e}\n"
        )
        sys.stderr.flush()
        return
    if not _probe_writable(d):
        sys.stderr.write(
            f"[tabduct] ACL restriction on {d} made the dir unwritable for the "
            "current process; restoring inherited (user-private) ACLs\n"
        )
        sys.stderr.flush()
        # Restore inherited ACEs from the parent. Still user-private: the profile
        # root (~) is ACL'd to the current user only on a normal Windows install,
        # so inheritance is the safe fallback, not a regression.
        try:
            subprocess.run(
                ["icacls", d, "/reset"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        except OSError:
            pass


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
    _restrict_windows_acl(d)
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
