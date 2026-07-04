# Tabduct host — Python (planned)

📋 Not built yet. A Python host is a first-class citizen: implement
[`../../protocol/PROTOCOL.md`](../../protocol/PROTOCOL.md) and pass
[`../../protocol/conformance`](../../protocol/conformance). The shared extension
is reused unchanged.

## Shape

- **North edge:** the official MCP Python SDK (`mcp`) with a streamable-HTTP
  server on `127.0.0.1:<port>/mcp`.
- **South edge:** read/write Chrome native-messaging frames on
  `sys.stdin.buffer` / `sys.stdout.buffer` (uint32 LE length + UTF-8 JSON).
- **Bridge:** map each MCP tool call → `invoke` message → await the correlated
  `replyTo`. Tools come from `../../protocol/tools.schema.json` — do not
  hand-duplicate them.

## Suggested layout

```
tabduct_host/
  __main__.py        entry (lifecycle: open/close/ping)
  native_messaging.py
  bridge.py
  mcp_server.py
  register.py
pyproject.toml
```

Build only when there's a reason (a Node-free machine, embedding in a Python
app, contributor preference). Until then, the Node host serves every MCP agent.
