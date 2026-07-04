# Tabduct host — Python

✅ **First-class Python reference host** (official [`mcp`](https://pypi.org/project/mcp/)
SDK). Passes the full conformance suite. The shared extension + wire protocol are
reused unchanged.

## Run

```bash
pip install mcp            # Python 3.10+ (miniconda etc.)
```

Chrome launches the host via the native-messaging manifest; it speaks the stdio
wire protocol and runs the MCP server on `127.0.0.1:<ephemeral>/mcp`.

## Conformance

From the repo root:

```bash
node protocol/conformance/run.mjs -- python hosts/python/tabduct_host/__main__.py
```

→ `CONFORMANCE PASSED` (14 tools).

## Layout

```
tabduct_host/
  __main__.py          entry: stdio loop + lifecycle (open/close/ping)
  native_messaging.py  uint32-LE + JSON framing (Windows binary-safe)
  bridge.py            invoke → correlated reply (asyncio futures)
  mcp_server.py        streamable-HTTP MCP + ASGI auth gate (Bearer/Origin/Host)
  constants.py         catalog load, protocol version, error codes
  discovery.py         ~/.tabduct/instances/<id>.json
pyproject.toml
```

## Register (wire it to Chrome)

```bash
python hosts/python/tabduct_host/__main__.py register        # or --browser edge|brave|chromium
python hosts/python/tabduct_host/__main__.py unregister
```

`register` writes the native-messaging manifest (+ a launcher pinning this Python)
for macOS/Linux/Windows so Chrome launches this host; the manifest's extension id is
computed from the shared `extension/manifest.json` key. Consent, tools, and auth all
live in the shared extension / protocol.
