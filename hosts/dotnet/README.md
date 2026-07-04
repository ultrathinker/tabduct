# Tabduct host — .NET (planned)

📋 Not built yet. A .NET host implements
[`../../protocol/PROTOCOL.md`](../../protocol/PROTOCOL.md) and passes
[`../../protocol/conformance`](../../protocol/conformance). The shared extension
is reused unchanged.

## Shape

- **North edge:** the official MCP C# SDK (`ModelContextProtocol` NuGet) with a
  streamable-HTTP server on `127.0.0.1:<port>/mcp`.
- **South edge:** read/write Chrome native-messaging frames on
  `Console.OpenStandardInput()` / `OpenStandardOutput()` (uint32 LE length +
  UTF-8 JSON). Keep stdout binary-clean.
- **Bridge:** map each MCP tool call → `invoke` message → await the correlated
  `replyTo`, using a `ConcurrentDictionary<string, TaskCompletionSource>`.
  Tools come from `../../protocol/tools.schema.json`.

## Suggested layout

```
Tabduct.Host/
  Program.cs           entry (lifecycle: open/close/ping)
  NativeMessaging.cs
  Bridge.cs
  McpServer.cs
  Register.cs
Tabduct.Host.csproj
```

Build only when there's a reason (embedding in a .NET app, Node-free machine,
contributor preference). Until then, the Node host serves every MCP agent.
