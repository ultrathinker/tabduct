# Tabduct host — Python

⚠ **Direct mode only — not usable with the current extension.** This host speaks the wire
protocol and passed the conformance suite when it was written, but it predates the shared
hub (`open{hub:true}`, `peers*`), feature gating (`EXTENSION_OUTDATED`), `relabel` and the
per-call timeout budgets. The extension now requires the hub, so Start fails with "Couldn't
start the shared hub" against this host. Use the Node host (`hosts/node`). It is kept as a
protocol reference; bringing it up to date is a port of `hub.js` and the `open` handling.

Built on the official [`mcp`](https://pypi.org/project/mcp/) SDK; the wire protocol is
the same as the Node host's.

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

→ the direct-mode checks of `run.mjs` pass; the hub-era checks (feature gating, numeric bounds,
404 for an unknown session) are skipped for non-Node hosts, because this host predates them (see the
note at the top).

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
