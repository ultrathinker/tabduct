"""Tabduct host — the bridge.

Turns "call a tool" (MCP side) into an ``invoke`` message on the wire and
resolves when the extension replies (correlated by ``id``). Heart of the host,
mirrors hosts/node/src/bridge.js. Futures live on the asyncio loop; the stdin
reader thread resolves them via the loop (``handle_reply`` is always called on
the loop thread), so no cross-thread future mutation.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

from tabduct_host.constants import ERR, INVOKE_TIMEOUT_S
from tabduct_host.native_messaging import FrameTooLargeError, NativeMessaging


class ToolError(Exception):
    """A tool invocation that the extension reported as failed (or timed out)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _wire_error(code: str, message: str) -> ToolError:
    return ToolError(code, message)


class Bridge:
    def __init__(self, nm: NativeMessaging, loop: asyncio.AbstractEventLoop) -> None:
        self._nm = nm
        self._loop = loop
        self._pending: dict[str, asyncio.Future[Any]] = {}

    def handle_reply(self, msg: dict[str, Any]) -> bool:
        """Feed replies from the extension. Returns True if consumed.

        Always called on the loop thread (the native-messaging reader posts via
        ``call_soon_threadsafe``), so resolving futures here is safe.
        """
        rid = msg.get("replyTo")
        if not isinstance(rid, str):
            return False
        fut = self._pending.get(rid)
        if fut is None:
            return True  # reply for an unknown/already-resolved id — drop quietly
        del self._pending[rid]
        if msg.get("ok"):
            if not fut.done():
                fut.set_result(msg.get("result"))
        else:
            err = msg.get("error") or {}
            code = err.get("code") or ERR.INTERNAL
            message = err.get("message") or "tool failed"
            if not fut.done():
                fut.set_exception(_wire_error(code, message))
        return True

    async def invoke(self, tool: str, args: dict[str, Any] | None = None) -> Any:
        """Ask the extension to run a tool; resolves with its result object."""
        if args is None:
            args = {}
        rid = str(uuid.uuid4())
        fut: asyncio.Future[Any] = self._loop.create_future()
        self._pending[rid] = fut
        try:
            self._nm.send({"type": "invoke", "id": rid, "payload": {"tool": tool, "args": args}})
        except FrameTooLargeError as e:
            self._pending.pop(rid, None)
            raise _wire_error(ERR.FRAME_TOO_LARGE, str(e)) from e
        except Exception as e:  # e.g. EPIPE after Chrome died — fail fast, no timeout wait
            self._pending.pop(rid, None)
            raise _wire_error(ERR.INTERNAL, str(e)) from e
        try:
            return await asyncio.wait_for(fut, timeout=INVOKE_TIMEOUT_S)
        except asyncio.TimeoutError:
            self._pending.pop(rid, None)
            raise _wire_error(
                ERR.TIMEOUT, f'Tool "{tool}" timed out after {int(INVOKE_TIMEOUT_S * 1000)}ms'
            ) from None

    def reject_all(self, reason: str) -> None:
        """Reject everything in flight (extension/Chrome went away)."""
        for rid, fut in list(self._pending.items()):
            if not fut.done():
                fut.set_exception(_wire_error(ERR.INTERNAL, reason))
        self._pending.clear()
