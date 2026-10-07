# Tabduct host — .NET

⚠ **Direct mode only — not usable with the current extension.** This host speaks the wire
protocol and passed the conformance suite when it was written, but it predates the shared
hub (`open{hub:true}`, `peers*`), feature gating (`EXTENSION_OUTDATED`), `relabel` and the
per-call timeout budgets. The extension now requires the hub, so Start fails with "Couldn't
start the shared hub" against this host. Use the Node host (`hosts/node`). It is kept as a
protocol reference; bringing it up to date is a port of `hub.js` and the `open` handling.

Built on the official [`ModelContextProtocol`](https://www.nuget.org/packages/ModelContextProtocol)
SDK (`net10.0`); the wire protocol is the same as the Node host's.

## Build & run

```bash
dotnet build hosts/dotnet
```

Chrome launches the built host via the native-messaging manifest; it speaks the
stdio wire protocol and runs the MCP server on `127.0.0.1:<ephemeral>/mcp`. Logs go
to **stderr** so stdout stays a clean native-messaging frame stream.

## Conformance

From the repo root, after `dotnet build hosts/dotnet`:

```bash
node protocol/conformance/run.mjs -- dotnet hosts/dotnet/bin/Debug/net10.0/Tabduct.Host.dll
```

→ the direct-mode checks of `run.mjs` pass; the hub-era checks (feature gating, numeric bounds,
404 for an unknown session) are skipped for non-Node hosts, because this host predates them (see the
note at the top). (Run the built dll, not `dotnet run`, which would
print build output onto stdout and corrupt the frame stream.)

## Layout

```
Tabduct.Host/
  Program.cs           entry: stdio loop + lifecycle (open/close/ping)
  NativeMessaging.cs   uint32-LE + JSON framing (binary-clean stdout)
  Bridge.cs            invoke → correlated reply (ConcurrentDictionary<…,TCS>)
  McpServer.cs         Kestrel + MCP (low-level catalog tools) + auth middleware
  Tabduct.Host.csproj
Tabduct.slnx
```

## Register (wire it to Chrome)

After `dotnet build hosts/dotnet`:

```bash
dotnet hosts/dotnet/bin/Debug/net10.0/Tabduct.Host.dll register     # or --browser edge|brave|chromium
dotnet hosts/dotnet/bin/Debug/net10.0/Tabduct.Host.dll unregister
```

`register` writes the native-messaging manifest pointing at the built apphost
(`Tabduct.Host.exe`/`Tabduct.Host`) for macOS/Linux/Windows so Chrome launches this
host; the extension id is computed from the shared `extension/manifest.json` key.
Consent, tools, and auth all live in the shared extension / protocol.
