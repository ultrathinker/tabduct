# Phase 3 — Hub (MCP reverse-proxy design)

Goal: one **stable endpoint + token** that aggregates every running browser
instance. **Revised after Fable's plan review** to the far simpler *reverse-proxy*
design instead of a custom control channel + backend mode.

## Why proxy (not control-channel + backends)
Hosts already bind an ephemeral MCP server and publish `{port, token, pid}` to
`~/.tabduct/instances/` with liveness reaping (Phase 2, `discovery.js`). So the
hub can just be an **MCP client to each live instance + one MCP-server facade**.
This DELETES: `backend.js`, the loopback control channel, `T_backend`, the
`FramedChannel` refactor of `native-messaging.js`, the host dual-mode, backend
reconnect/respawn, and the Windows job-object hazard for backends. Hosts stay
**unchanged** (Phases 0–2 stay green). Failover falls out of pid-reaping.
Trade accepted: instances keep their loopback ports bound (already true today);
the hub parses our own hosts' `content[0].text` JSON to rewrite ids (deterministic —
we own both ends).

```
 Agent ─MCP/HTTP─▶ HUB facade 127.0.0.1:12311/mcp   [stable endpoint + T_agent]
                       │  MCP client (SDK) per instance, auth = that instance's token
        ┌──────────────┼──────────────┐   (read from ~/.tabduct/instances/*.json)
   instance A     instance B     instance C   ← unchanged direct hosts (own port+token+discovery)
     ext A          ext B          ext C       ← consent still enforced per-extension
```

## Design decisions
- **Hub = new process** `tabduct hub` (`hosts/node/src/hub.js`). On-demand: a host
  whose extension sent `open{hub:true}` calls `ensureHub()` → spawns `tabduct hub`
  detached if `~/.tabduct/hub.json` is absent/dead. (Host otherwise UNCHANGED —
  still binds its own port + writes discovery.) Spawn escaping the Windows job:
  `cmd /c start "" /B node … hub` on win32 (per ccode_restart_setup note); verify
  at runtime that the hub survives its spawner's browser closing.
- **Port `HUB_PORT = 12311`** (distinct from direct `DEFAULT_PORT 12310`). Bind is
  the singleton mutex — a second hub loses the bind and exits 0. Fail loudly
  (popup-visible) if it can't bind.
- **Secrets** `secrets.js`: `ensureSecrets()` atomic create-if-absent (`wx`) of
  `~/.tabduct/token` = `{ tAgent }` (0600 + win ACL, reuse discovery's helper,
  factored out). `hub.json` `{ mcpPort, pid }` written **after** the facade binds,
  deleted **before** self-exit teardown. Token file never deleted (endpoint
  stability). The hub authenticates to each instance with that instance's own
  token from its discovery file.
- **Registry = discovery dir.** Hub polls `~/.tabduct/instances/` (readAll, which
  already filters dead pids) every ~3 s + on connect error: opens an MCP client to
  each new instance, drops clients for vanished ones. `TABDUCT_DIR` env overrides
  the base dir (needed for test isolation — add to `discovery.js` + `secrets.js`).
- **Composite tab handles at the hub, extension & base catalog UNCHANGED.** Hub
  serves a **derived catalog**: for each base tool, `tabId` schema → `oneOf:[integer,
  {type:string, pattern:"…:\\d+"}]`; adds optional `instanceId`; appends
  `list_instances`. No `protocolVersion` bump. Routing:
  - explicit composite `tabId` `"<instanceId>:<n>"` → split on FIRST `:`, validate
    instanceId∈registry (else `INSTANCE_GONE`), suffix integer (else `INVALID_ARGS`),
    forward to that instance with raw `tabId=n`.
  - explicit `instanceId` arg (for `open_tab`/`get_active_tab`/omitted-tabId tools) → route there.
  - neither, and exactly 1 instance → route there; >1 → `AMBIGUOUS_INSTANCE`.
  - **Result rewriting** (exhaustive): `list_tabs` fan-out → merge, prefix every
    `id` with `instanceId:`; `get_active_tab`/`open_tab` single result → prefix its
    `id`. screenshot→image passes through (done once, at the source host).
- **Consent unchanged** — each instance's extension runs the gate; hub is a pure
  router, makes no authorization decision.
- **Idle self-exit**: hub exits ~60 s after the registry is empty (timer armed from
  startup so a spawner that died pre-registration still cleans up). Deletes `hub.json`.
- **MCP session reaper note**: exempt sessions with a live GET/SSE stream from the
  10-min idle reap (a long-lived hub client may not POST for >10 min).

## Reuse (Fable: the seam is tiny)
- `McpHttpServer` (`mcp-server.js`): inject a **registrar** via constructor
  (`new McpHttpServer({ registerTools })`) instead of hardcoding `registerTools(server, this._bridge)`
  at `:74`. Auth (`_reject`), sessions, reaper, start/stop reused byte-for-byte.
  Direct host passes today's registrar; hub passes the router registrar.
- MCP **client**: `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport`,
  one per instance, `Authorization: Bearer <instanceToken>`, `Host: 127.0.0.1:<port>`.
- `tools.js` `toContent` screenshot→image reused for pass-through.
- Reuse `tokenEqual` (`mcp-server.js:16`) for the facade's T_agent check (already in `_reject`).

## Files
NEW: `hosts/node/src/secrets.js`, `hosts/node/src/hub.js`, `protocol/conformance/run-hub.mjs`.
CHANGED: `mcp-server.js` (registrar injection), `index.js` (ensureHub on `open{hub:true}`; reply `{endpoint, token}` from `~/.tabduct/token`; still binds direct as normal), `discovery.js` (factor ACL to secrets; `TABDUCT_DIR` override), `constants.js` (HUB_PORT, `AMBIGUOUS_INSTANCE`, `INSTANCE_GONE`), `bin/tabduct.js` (`hub` subcommand; `instances` hub-aware + mixed-mode warning), `extension/{background.js,popup.{html,js}}` ("Shared hub" toggle → `open{hub:true}`, show reply endpoint+token; disable port input in hub mode; toggling reconnects; non-numeric `tabId` → `INVALID_ARGS` hardening at `background.js:151`), `protocol/PROTOCOL.md` (§11 Hub), `protocol/messages.schema.json` (codes), `protocol/tools.schema.json` (note only — derived catalog is built at runtime).

## Accepted risks (document in PROTOCOL §11 / ROADMAP)
- Shared `T_agent` across all instances' popups (blast radius = all shared tabs) —
  mitigated by Feature B consent.
- Well-known `HUB_PORT` on a multi-user machine: a hostile local user could pre-bind
  it and harvest `T_agent` from the first request — same fate as any local MCP server;
  loopback+bearer can't authenticate the server to the agent. State honestly.
- Mixed mode (some instances hub, some direct) breaks "one endpoint" — `instances`/`doctor` warn.

## Validation — `run-hub.mjs` (no Chrome), wired into `npm test`
Uses `TABDUCT_DIR` = a temp dir (never touches the real `~/.tabduct` or hub port).
Spawns the hub + 2 **fake instances** (each a tiny real MCP server that answers
tools/list+tools/call like our host would). Asserts: single-instance bare-int ok →
2nd instance ⇒ `AMBIGUOUS_INSTANCE`; explicit `instanceId`/composite routing;
`list_tabs` merge with prefixed ids; `open_tab`/`get_active_tab` result ids
composited; `list_instances`; wrong T_agent → 401; instance drop mid-flight →
`INSTANCE_GONE` (immediate, not 20 s), other traffic fine; multi-MB (≈5 MB)
screenshot traverses intact; two hubs → one survives; hub killed → survivor path
respawns, same port+token; self-exit with empty registry, not while an instance
remains. Extension toggle has NO automated coverage → manual smoke (state this).

## Step order (green-gated)
1. `secrets.js` + factor ACL out of `discovery.js` + `TABDUCT_DIR` override (tests depend on it). `npm test` green.
2. Registrar injection into `McpHttpServer`; direct path unchanged. `npm test` green — commit gate.
3. Protocol/catalog on paper: derived-catalog rules, `instanceId`+ambiguity, result-rewrite table, `AMBIGUOUS_INSTANCE`/`INSTANCE_GONE` in constants+messages.schema, PROTOCOL §11. Extension one-line `tabId` hardening.
4. `hub.js`: facade (registrar), per-instance MCP clients from discovery poll, router + composite rewrite + fan-out, idle self-exit, hub.json write-after-bind/delete-before-exit.
5. `index.js` `ensureHub()` on `open{hub:true}` + reply endpoint/token. `bin` `hub` subcommand.
6. `run-hub.mjs` full assertions + `npm test` green.
7. Windows job-object runtime check (real Chrome spawn) → confirm/adjust spawn.
8. Extension toggle + popup plumbing; manual smoke. `bin instances` hub-aware + docs.
