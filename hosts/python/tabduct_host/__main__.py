#!/usr/bin/env python3
"""Tabduct host — entry point.

Boots native messaging, wires the bridge + MCP server, and handles the
request/reply lifecycle (open/close/ping). Requests are SERIALIZED so an
open/close race can't tear down a still-starting server. Mirrors
hosts/node/src/index.js.

Run either as a module (``python -m tabduct_host``) or as a script
(``python hosts/python/tabduct_host/__main__.py``) — the conformance runner uses
the latter. The bootstrap below makes the package importable in both cases.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time

# --- bootstrap: make `tabduct_host` importable when run as a bare script ------
# When executed as `python .../tabduct_host/__main__.py`, __package__ is empty and
# the script's own dir (not its parent) is on sys.path. Add the parent (hosts/python)
# so the package and its absolute imports resolve. Cheap + idempotent.
if __package__ in (None, ""):
    _PARENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if _PARENT not in sys.path:
        sys.path.insert(0, _PARENT)

from tabduct_host.bridge import Bridge  # noqa: E402
from tabduct_host.constants import DEFAULT_PORT, ERR, PROTOCOL_VERSION  # noqa: E402
from tabduct_host.discovery import remove_entry, write_entry  # noqa: E402
from tabduct_host.mcp_server import McpHttpServer  # noqa: E402
from tabduct_host.native_messaging import NativeMessaging  # noqa: E402


def _set_binary_stdio() -> None:
    """On Windows, force stdin/stdout to BINARY so CRLF translation never corrupts frames."""
    if sys.platform == "win32":
        import msvcrt

        try:
            msvcrt.setmode(0, os.O_BINARY)  # stdin
            msvcrt.setmode(1, os.O_BINARY)  # stdout
        except OSError:
            pass


class Host:
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._nm = NativeMessaging(loop)
        self._bridge = Bridge(self._nm, loop)
        self._server = McpHttpServer(self._bridge)
        self._current_instance: str | None = None
        self._stop_event = asyncio.Event()
        # Serialize lifecycle requests; replies to our invokes skip the queue.
        self._lock = asyncio.Lock()

    async def run(self) -> None:
        self._nm.on_message(self._on_message)
        self._nm.on_end(self._on_end)
        self._nm.start()
        try:
            await self._stop_event.wait()
        finally:
            try:
                await self._server.stop()
            except Exception as e:
                sys.stderr.write(f"[tabduct] stop error: {e}\n")
                sys.stderr.flush()
            self._bridge.reject_all("extension disconnected")

    # --- dispatch (loop thread) ------------------------------------------------

    def _on_message(self, msg: dict) -> None:
        # Replies to our invokes are correlated by the bridge and skip the queue.
        if msg.get("replyTo") is not None:
            self._bridge.handle_reply(msg)
            return
        asyncio.create_task(self._handle_serialized(msg))

    async def _handle_serialized(self, msg: dict) -> None:
        async with self._lock:
            try:
                await self._handle(msg)
            except Exception as e:
                sys.stderr.write(f"[tabduct] handler error: {e}\n")
                sys.stderr.flush()

    def _on_end(self) -> None:
        # stdin closed → authoritative shutdown. Already on the loop thread.
        self._stop_event.set()

    # --- request handlers ------------------------------------------------------

    def _reply(self, reply_to, ok: bool, payload: dict) -> None:
        if reply_to is None:
            return
        try:
            if ok:
                self._nm.send({"replyTo": reply_to, "ok": True, "result": payload})
            else:
                self._nm.send({"replyTo": reply_to, "ok": False, "error": payload})
        except Exception as e:
            sys.stderr.write(f"[tabduct] failed to send reply: {e}\n")
            sys.stderr.flush()

    async def _handle(self, msg: dict) -> None:
        mtype = msg.get("type")
        mid = msg.get("id")
        payload = msg.get("payload") or {}

        if mtype == "open":
            await self._handle_open(mid, payload)
        elif mtype == "close":
            await self._handle_close(mid)
        elif mtype == "ping":
            self._reply(mid, True, {"pong": True})
        else:
            self._reply(mid, False, {"code": ERR.INVALID_ARGS, "message": f"unknown request type: {mtype}"})

    async def _handle_open(self, mid, payload: dict) -> None:
        if payload.get("protocolVersion") != PROTOCOL_VERSION:
            self._reply(
                mid,
                False,
                {
                    "code": ERR.VERSION_MISMATCH,
                    "message": f"host v{PROTOCOL_VERSION}, extension v{payload.get('protocolVersion')}",
                },
            )
            return
        token = payload.get("token")
        if not isinstance(token, str) or len(token) < 16:
            self._reply(mid, False, {"code": ERR.INVALID_ARGS, "message": "missing or too-short token"})
            return
        port = payload.get("port", DEFAULT_PORT)
        if not (isinstance(port, int) and not isinstance(port, bool) and 0 <= port <= 65535):
            self._reply(mid, False, {"code": ERR.INVALID_ARGS, "message": "invalid port"})
            return
        if self._server.is_running or self._server._starting:  # noqa: SLF001
            # A second open while running is rejected (PROTOCOL.md §1: one host per process).
            self._reply(mid, False, {"code": ERR.INTERNAL, "message": "already running"})
            return

        try:
            bound = await self._server.start(port, token)
        except Exception as e:
            self._reply(mid, False, {"code": ERR.INTERNAL, "message": f"open failed: {e}"})
            return

        iid = payload.get("instanceId")
        self._current_instance = iid if isinstance(iid, str) and iid else "default"
        try:
            write_entry(
                {
                    "instanceId": self._current_instance,
                    "label": payload.get("label") or "Chrome",
                    "port": bound,
                    "token": token,
                    "pid": os.getpid(),
                    "updatedAt": int(time.time() * 1000),
                }
            )
        except Exception as e:
            sys.stderr.write(f"[tabduct] discovery write failed: {e}\n")
            sys.stderr.flush()

        self._reply(mid, True, {"port": bound, "protocolVersion": PROTOCOL_VERSION})

    async def _handle_close(self, mid) -> None:
        try:
            await self._server.stop()
        except Exception as e:
            self._reply(mid, False, {"code": ERR.INTERNAL, "message": f"close failed: {e}"})
            return
        if self._current_instance:
            remove_entry(self._current_instance)
            self._current_instance = None
        self._reply(mid, True, {})


def main() -> None:
    _set_binary_stdio()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    host = Host(loop)
    try:
        loop.run_until_complete(host.run())
    except KeyboardInterrupt:
        pass
    finally:
        try:
            loop.run_until_complete(loop.shutdown_asyncgens())
        except Exception:
            pass
        loop.close()


if __name__ == "__main__":
    main()
