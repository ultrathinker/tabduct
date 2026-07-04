"""Tabduct host — Chrome native-messaging transport (PROTOCOL.md §1).

Frames: ``[uint32 LE length][UTF-8 JSON]``. Read from stdin, write to stdout.
- A bad length header (<=0) or non-JSON body is a genuine desync → FATAL exit.
- An oversize frame (> MAX_FRAME_BYTES) is NOT a desync (the length is valid):
  we skip exactly that many bytes and keep the stream alive; the corresponding
  invoke reply is lost and times out. Mirrors hosts/node/src/native-messaging.js.

stdin is a blocking stream in Python, so the read loop runs on a dedicated
daemon thread and hands each decoded message to the asyncio loop via
``loop.call_soon_threadsafe``. Outbound writes (lifecycle replies + ``invoke``
requests) originate on the loop thread and are serialized under a lock.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
from typing import Any, Callable

from tabduct_host.constants import MAX_FRAME_BYTES, OUT_FRAME_MAX_BYTES


class FrameTooLargeError(Exception):
    """Raised when an outbound frame would exceed Chrome's 1 MB host->ext cap."""

    code = "FRAME_TOO_LARGE"


class NativeMessaging:
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._on_message: Callable[[dict[str, Any]], None] | None = None
        self._on_end: Callable[[], None] | None = None
        self._out_lock = threading.Lock()
        self._thread = threading.Thread(target=self._read_loop, name="tabduct-nm-reader", daemon=True)
        self._stopped = False

    def on_message(self, fn: Callable[[dict[str, Any]], None]) -> None:
        self._on_message = fn

    def on_end(self, fn: Callable[[], None]) -> None:
        self._on_end = fn

    def start(self) -> None:
        self._thread.start()

    # --- inbound (reader thread) ------------------------------------------------

    def _read_loop(self) -> None:
        try:
            while True:
                header = self._read_exact(4)
                if header is None:
                    break  # stdin closed (extension gone / Chrome evicted worker)
                length = int.from_bytes(header, "little")
                if length <= 0:
                    self._fatal(f"bad length header: {length}")
                    return
                if length > MAX_FRAME_BYTES:
                    sys.stderr.write(
                        f"[tabduct] dropping oversize frame: {length}B (cap {MAX_FRAME_BYTES})\n"
                    )
                    sys.stderr.flush()
                    self._skip(length)
                    continue
                body = self._read_exact(length)
                if body is None:
                    break  # EOF mid-frame
                try:
                    msg = json.loads(body.decode("utf-8"))
                except Exception as e:  # non-JSON → unrecoverable desync
                    self._fatal(f"non-JSON frame: {e}")
                    return
                if not isinstance(msg, dict):
                    self._fatal(f"non-object frame: {type(msg).__name__}")
                    return
                self._loop.call_soon_threadsafe(self._dispatch, msg)
        except Exception as e:  # reader thread must never crash silently the wrong way
            sys.stderr.write(f"[tabduct] native-messaging reader error: {e}\n")
            sys.stderr.flush()
        finally:
            # Always signal end on the loop so the host shuts the server down.
            if not self._stopped:
                self._stopped = True
                try:
                    self._loop.call_soon_threadsafe(self._end)
                except RuntimeError:
                    pass  # loop already closed

    def _dispatch(self, msg: dict[str, Any]) -> None:
        if self._on_message is not None:
            self._on_message(msg)

    def _end(self) -> None:
        if self._on_end is not None:
            self._on_end()

    def _read_exact(self, n: int) -> bytes | None:
        """Read exactly ``n`` bytes. Returns None on EOF."""
        chunks: list[bytes] = []
        remaining = n
        while remaining > 0:
            chunk = sys.stdin.buffer.read(remaining)
            if not chunk:
                return None  # EOF
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _skip(self, n: int) -> None:
        remaining = n
        while remaining > 0:
            chunk = sys.stdin.buffer.read(min(remaining, 65536))
            if not chunk:
                return  # EOF while skipping
            remaining -= len(chunk)

    def _fatal(self, reason: str) -> None:
        sys.stderr.write(f"[tabduct] fatal framing error: {reason}\n")
        sys.stderr.flush()
        os._exit(1)  # length-prefixed desync is unrecoverable; Chrome surfaces the disconnect

    # --- outbound (loop thread) -------------------------------------------------

    def send(self, msg: dict[str, Any]) -> None:
        """Encode ``msg`` as a native-messaging frame and write it to stdout."""
        body = json.dumps(msg, separators=(",", ":")).encode("utf-8")
        if len(body) > OUT_FRAME_MAX_BYTES:
            raise FrameTooLargeError(
                f"outbound frame {len(body)}B exceeds 1 MB cap"
            )
        frame = len(body).to_bytes(4, "little") + body
        with self._out_lock:
            sys.stdout.buffer.write(frame)
            sys.stdout.buffer.flush()
