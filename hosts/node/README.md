# Tabduct host — Node (reference implementation)

Pure-JS host. No native modules → runs on any modern Node (≥ 18), no build toolchain.
This is the host the extension and conformance suite are validated against.

## Layout

```
src/
  constants.js         ports, host name, timeouts, size caps, error codes
  native-messaging.js  Chrome stdio framing (uint32 LE + JSON)      [PROTOCOL.md §1]
  bridge.js            MCP call -> `invoke` msg -> awaited reply     [PROTOCOL.md §2-4]
  mcp-server.js        MCP streamable-HTTP server (north edge, token auth)
  tools.js             serves protocol/tools.schema.json + validates args
  register.js          native-messaging manifest (per-OS) + Windows registry
  discovery.js         ~/.tabduct/instances/<id>.json registry
  secrets.js           ~/.tabduct dir + stable agent token (0o600 / Windows ACL)
  hub.js               MCP reverse-proxy aggregating N browsers behind one endpoint
  index.js             entry: lifecycle (open/close/ping) + hub spawn
bin/tabduct.js         CLI: register | unregister | doctor | run | instances | hub
```

## Setup

```bash
npm install            # from the repo root (workspaces) or here
npm run register       # install the native-messaging manifest for Chrome
# other browsers:
node bin/tabduct.js register --browser edge|brave|chromium
```

Then load `../../extension` unpacked in `chrome://extensions`, click the Tabduct
icon → **Start**, open **Settings** and paste the shown MCP endpoint + token into
your agent's config. The shared hub endpoint is `http://127.0.0.1:12311/mcp`.

## CLI

| Command | Purpose |
|---------|---------|
| `register [--browser …]` | Install the native-messaging manifest (+ registry key on Windows). |
| `unregister [--browser …]` | Remove it. |
| `doctor` | Diagnose install (manifest present, node path, launcher, permissions). |
| `run` | Run the host directly (Chrome normally spawns this via the manifest). |
| `instances` | Print a ready `--mcp-config` for the live instance(s) / hub. |
| `hub` | Run the hub in the foreground (debugging; normally auto-spawned). |

## Notes

- **Extension identity.** The manifest's pinned `key` fixes the extension id so
  `register` can scope `allowed_origins` correctly. Maintainers regenerating it:
  `node ../../scripts/gen-key.js` (writes the gitignored `extension/key.pem`).
- **Chrome's minimal-env spawn.** `register` records the absolute `node` path in
  `node_path.txt`, and the launcher (`run_host.sh` / `run_host.bat`) uses it so the
  host starts even when Chrome spawns it with a bare `PATH`.
- **Tests.** From the repo root: `npm test` (consent unit + host & hub conformance).
