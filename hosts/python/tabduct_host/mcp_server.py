"""Tabduct host — MCP streamable-HTTP server (the "north" edge).

HTTP server on ``127.0.0.1:<port>/mcp`` using the official MCP Python SDK's
low-level ``Server`` + ``StreamableHTTPSessionManager``. Auth + origin/host
checks (PROTOCOL.md §6) gate EVERY request in a pure-ASGI middleware that runs
BEFORE the session manager (the SDK transport consumes the request body, so the
gate must read headers first and short-circuit). Mirrors
hosts/node/src/mcp-server.js + hosts/node/src/tools.js.

The catalog is served VERBATIM from protocol/tools.schema.json — tools are built
from the JSON (name/description/inputSchema), never hand-written.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import re
from typing import Any

import uvicorn
from mcp.server.lowlevel.server import Server as MCPServer
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.types import CallToolResult, ImageContent, TextContent, Tool

from tabduct_host.bridge import Bridge, ToolError
from tabduct_host.constants import (
    BIND_HOST,
    CATALOG,
    ERR,
    MCP_PATH,
    MCP_REQUEST_MAX_BYTES,
    STOP_GRACE_S,
    allowed_hosts,
)


# --- catalog → MCP tools -------------------------------------------------------

def _type_ok(type_decl: Any, v: Any) -> bool:
    types = type_decl if isinstance(type_decl, list) else [type_decl]
    for t in types:
        if t == "string":
            if isinstance(v, str):
                return True
        elif t == "integer":
            if isinstance(v, int) and not isinstance(v, bool):
                return True
        elif t == "number":
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                return True
        elif t == "boolean":
            if isinstance(v, bool):
                return True
        elif t == "array":
            if isinstance(v, list):
                return True
        elif t == "object":
            if isinstance(v, dict):
                return True
        elif t == "null":
            if v is None:
                return True
        else:
            return True  # unknown/missing type → lenient
    return False


def _validate_args(schema: dict[str, Any] | None, args: dict[str, Any]) -> str | None:
    """Minimal, dependency-free schema check (required fields, types, enums).

    additionalProperties is intentionally lenient (the hub adds routing fields).
    Returns an error string or None.
    """
    if not schema or schema.get("type") != "object":
        return None
    for req in schema.get("required", []) or []:
        if args.get(req) is None:
            return f'missing required argument "{req}"'
    for key, spec in (schema.get("properties") or {}).items():
        v = args.get(key)
        if v is None:
            continue
        if spec.get("type") and not _type_ok(spec["type"], v):
            td = spec["type"]
            td = "/".join(td) if isinstance(td, list) else td
            return f'argument "{key}" must be of type {td}'
        if spec.get("enum") and v not in spec["enum"]:
            return f'argument "{key}" must be one of: {", ".join(map(str, spec["enum"]))}'
    return None


def _to_content(tool_name: str, result: Any) -> list:
    """Convert an extension tool result into MCP content blocks.

    screenshot → image content ONLY (never dump multi-MB base64 as text).
    """
    if tool_name == "screenshot":
        data_url = (result or {}).get("dataUrl", "") if isinstance(result, dict) else ""
        m = re.match(r"^data:([^;,]+);base64,([\s\S]+)$", data_url)
        if not m:
            raise ToolError(ERR.INTERNAL, "screenshot result missing base64 dataUrl")
        mime = m.group(1)
        data = re.sub(r"\s+", "", m.group(2))
        return [ImageContent(type="image", mimeType=mime, data=data)]
    return [TextContent(type="text", text=json.dumps(result))]


def build_mcp_server(bridge: Bridge) -> MCPServer:
    """Create a low-level MCP Server with catalog tools registered on it."""
    server: MCPServer = MCPServer("tabduct", "0.0.1")

    @server.list_tools()
    async def _list_tools() -> list[Tool]:
        # Served VERBATIM from the catalog — single source of truth.
        return [
            Tool(name=t["name"], description=t.get("description"), inputSchema=t.get("inputSchema", {}))
            for t in CATALOG["tools"]
        ]

    @server.call_tool(validate_input=False)
    async def _call_tool(name: str, arguments: dict[str, Any] | None) -> CallToolResult:
        tool = next((t for t in CATALOG["tools"] if t["name"] == name), None)
        if tool is None:
            return CallToolResult(
                content=[TextContent(type="text", text=f"UNKNOWN_TOOL: Unknown tool: {name}")],
                isError=True,
            )
        args = arguments or {}
        bad = _validate_args(tool.get("inputSchema"), args)
        if bad:
            return CallToolResult(
                content=[TextContent(type="text", text=f"INVALID_ARGS: {bad}")],
                isError=True,
            )
        try:
            result = await bridge.invoke(name, args)
            content = _to_content(name, result)
            return CallToolResult(content=content, isError=False)
        except ToolError as e:
            return CallToolResult(
                content=[TextContent(type="text", text=f"{e.code}: {e.message}")],
                isError=True,
            )

    return server


# --- HTTP server ---------------------------------------------------------------

class McpHttpServer:
    """Bound on ``open``; stopped on ``close``. Loopback-only, auth-gated."""

    def __init__(self, bridge: Bridge) -> None:
        self._bridge = bridge
        self._uvicorn: uvicorn.Server | None = None
        self._serve_task: asyncio.Task[None] | None = None
        self._session_manager: StreamableHTTPSessionManager | None = None
        self._sm_ctx: Any = None  # the session_manager.run() async context
        self._token: str | None = None
        self._port: int | None = None
        self._allowed_hosts: set[str] | None = None
        self.is_running = False
        self._starting = False

    # PROTOCOL.md §6 gatekeeper. Returns None if OK, else (status, message).
    def _reject(self, scope: dict[str, Any]) -> tuple[int, str] | None:
        origin = None
        host = None
        authorization = None
        content_length = None
        for name_b, value_b in scope.get("headers", []):
            name = name_b.decode("latin-1")
            if name == "origin":
                origin = value_b.decode("latin-1")
            elif name == "host":
                host = value_b.decode("latin-1")
            elif name == "authorization":
                authorization = value_b.decode("latin-1")
            elif name == "content-length":
                content_length = value_b.decode("latin-1")
        if origin:
            return (403, "origin not permitted")  # no non-browser MCP client sends Origin
        if host not in (self._allowed_hosts or set()):
            return (403, "bad host header — use 127.0.0.1")
        m = re.match(r"^Bearer\s+(.+)$", authorization or "")
        if not m or not hmac.compare_digest(m.group(1), self._token or ""):
            return (401, "unauthorized")
        # Cap the request body (parity with Node's MCP_REQUEST_MAX_BYTES). The SDK
        # transport would otherwise read an unbounded body into memory.
        if content_length is not None:
            try:
                if int(content_length) > MCP_REQUEST_MAX_BYTES:
                    return (413, "request body too large")
            except ValueError:
                return (400, "bad content-length")
        return None

    # --- ASGI app (auth gate → path route → session manager) -------------------

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        stype = scope.get("type")
        if stype == "lifespan":
            await self._lifespan(receive, send)
            return
        if stype != "http":
            return  # we only handle http (+ lifespan)
        bad = self._reject(scope)
        if bad is not None:
            await self._send_status(send, bad[0], bad[1])
            return
        path = scope.get("path", "")
        if path == MCP_PATH:
            # session_manager.handle_request is the ASGI entry that creates/reuses
            # sessions and dispatches JSON-RPC to the MCP server.
            assert self._session_manager is not None
            await self._session_manager.handle_request(scope, receive, send)
        else:
            await self._send_status(send, 404, "not found")

    async def _send_status(self, send: Any, status: int, message: str) -> None:
        body = message.encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"text/plain; charset=utf-8"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    async def _lifespan(self, receive: Any, send: Any) -> None:
        while True:
            msg = await receive()
            mtype = msg.get("type")
            if mtype == "lifespan.startup":
                try:
                    assert self._session_manager is not None
                    self._sm_ctx = self._session_manager.run()
                    await self._sm_ctx.__aenter__()
                    await send({"type": "lifespan.startup.complete"})
                except Exception as e:
                    await send({"type": "lifespan.startup.failed", "message": str(e)})
            elif mtype == "lifespan.shutdown":
                try:
                    if self._sm_ctx is not None:
                        await self._sm_ctx.__aexit__(None, None, None)
                        self._sm_ctx = None
                    await send({"type": "lifespan.shutdown.complete"})
                except Exception as e:
                    await send({"type": "lifespan.shutdown.failed", "message": str(e)})
                break

    # --- lifecycle -------------------------------------------------------------

    async def start(self, port: int, token: str) -> int:
        if self.is_running or self._starting:
            raise RuntimeError("Server already running")
        self._starting = True
        self._token = token
        try:
            self._session_manager = StreamableHTTPSessionManager(
                app=build_mcp_server(self._bridge),
            )
            config = uvicorn.Config(
                app=self,  # this object is the ASGI app
                host=BIND_HOST,
                port=port,
                loop="asyncio",
                http="h11",
                lifespan="on",
                access_log=False,
                log_level="error",
                timeout_graceful_shutdown=STOP_GRACE_S,
            )
            self._uvicorn = uvicorn.Server(config)
            self._serve_task = asyncio.create_task(self._uvicorn.serve())
            # Wait until the listening socket is up so we can read the bound port.
            for _ in range(500):  # up to ~5s
                if self._uvicorn.started and self._uvicorn.servers:
                    break
                if self._serve_task.done():
                    break
                await asyncio.sleep(0.01)
            if not (self._uvicorn.started and self._uvicorn.servers):
                # Surface the failure reason if the serve task died.
                exc = self._serve_task.exception() if self._serve_task.done() else None
                raise RuntimeError(f"server failed to start: {exc}")
            sockname = self._uvicorn.servers[0].sockets[0].getsockname()
            self._port = int(sockname[1])
            self._allowed_hosts = allowed_hosts(self._port)
            self.is_running = True
            return self._port
        finally:
            self._starting = False

    async def stop(self) -> None:
        uv = self._uvicorn
        task = self._serve_task
        self._uvicorn = None
        self._serve_task = None
        if uv is not None and task is not None:
            uv.should_exit = True
            try:
                await asyncio.wait_for(task, timeout=10)
            except asyncio.TimeoutError:
                uv.force_exit = True
                try:
                    await asyncio.wait_for(task, timeout=5)
                except (asyncio.TimeoutError, Exception):
                    pass
        # Closes the listening socket (→ connections refused afterwards) and runs
        # lifespan shutdown which exits the session_manager context (reaps sessions).
        self._session_manager = None
        self._sm_ctx = None
        self._token = None
        self._port = None
        self._allowed_hosts = None
        self.is_running = False
