# Tabduct Wire Protocol

**Version:** `0` (unstable — pre-1.0, may change)

This document is the **single source of truth** for the boundary between a
*Tabduct host* (any language) and the *Tabduct extension* (JS). Implement this
plus pass [`conformance/`](conformance/) and your host is valid.

The other boundary — host ↔ agent — is plain [MCP](https://modelcontextprotocol.io)
(streamable HTTP). Use your language's MCP SDK there; nothing custom.

> This protocol is Tabduct's own design. The only externally-fixed part is §1
> (Chrome mandates the stdio framing); everything else is defined here.

---

## 1. Transport: Chrome Native Messaging

The extension launches the host via Chrome Native Messaging. Framing is
**mandated by Chrome**, not by us:

- Each message is a UTF-8 JSON object.
- Prefixed by its byte length as a **32-bit unsigned integer, little-endian**.
- Read from `stdin`, written to `stdout`. `stderr` is free for logging.

**Size limits (Chrome, per direction — do not get these backwards):**

| Direction | Chrome hard cap | What travels here |
|-----------|-----------------|-------------------|
| **host → extension** | **1 MB** | `invoke` requests (tool + args, e.g. `execute_script` code) |
| **extension → host** | **64 MiB** | replies (screenshots, page content) |

(Source: Chrome native-messaging docs — host stdout is capped at 1 MB; messages
*to* the host are capped at 64 MiB.) So the *reply* direction (big payloads) is
comfortable; the **1 MB cap bites the `invoke` direction**. A host MUST measure
each outbound frame and, if it would exceed 1 MB, fail that tool call with
`FRAME_TOO_LARGE` instead of writing it (Chrome silently severs the whole
connection on overflow). `MAX_FRAME_BYTES` (default 32 MB) is Tabduct's *own*
inbound sanity cap (about half of Chrome's real 64 MiB inbound limit); an inbound
frame larger than it is skipped (the invoke times out), not fatal.

```
[ uint32 LE length ][ JSON bytes ][ uint32 LE length ][ JSON bytes ] ...
```

A malformed length header or non-JSON body is **unrecoverable** on a
length-prefixed stream (there is no delimiter to resync on). The host MUST log
to stderr and exit non-zero; Chrome surfaces the disconnect and the extension
handles it. Do **not** pretend to resync.

Each `connectNative()` from the extension spawns **one dedicated host process**
bound to that extension instance's stdio. One process, one browser instance.
(Multiple browsers → multiple processes on distinct ports; see §7.)

---

## 2. Message envelope

Every message is either a **request** (has `type`) or a **reply** (has
`replyTo`). The shape is uniform in both directions. Unknown fields MUST be
ignored (forward-compat).

```jsonc
// Request (expects exactly one reply):
{ "type": "<string>", "id": "<uuid>", "payload": { ... } }

// Reply (correlated by id):
{ "replyTo": "<uuid>", "ok": true,  "result": { ... } }
{ "replyTo": "<uuid>", "ok": false, "error": { "code": "<CODE>", "message": "<text>" } }

// Notification (fire-and-forget, no id, no reply):
{ "type": "notice" | "event", "payload": { ... } }
```

`id` is REQUIRED (UUIDv4) on every request. A reply MUST echo it verbatim in
`replyTo`. Error `code` is from the enum in §6.

---

## 3. Requests: extension → host

| `type` | payload | reply `result` |
|--------|---------|----------------|
| `open` | `{ port, token, protocolVersion, instanceId?, label? }` | `{ port, protocolVersion }` — bind MCP server on `127.0.0.1:port` (**`port: 0` = ephemeral**; the reply echoes the actually-bound port). Require `token` for auth (§5). Mismatched `protocolVersion` → `VERSION_MISMATCH`. `instanceId`/`label` register the instance for discovery (§7). |
| `close` | — | `{}` — stop the MCP server (process keeps running). |
| `ping` | — | `{ pong: true }` — liveness. |

## 4. Requests: host → extension

| `type` | payload | reply `result` |
|--------|---------|----------------|
| `invoke` | `{ tool, args }` | the tool's result object (see `tools.schema.json`). Errors use §6 codes. |

## 5. Notifications (no reply)

| `type` | direction | payload | meaning |
|--------|-----------|---------|---------|
| `notice` | host → ext | `{ level, message }` | unsolicited host log/status. |
| `event`  | ext → host | `{ kind, ... }` | out-of-band browser event (e.g. `kind:"tab_removed"`, `"permission_revoked"`). Hosts MAY ignore. |

**Core loop:** MCP tool call arrives → host sends
`{ type:"invoke", id, payload:{ tool, args } }` → extension runs it and replies
`{ replyTo:id, ok, result|error }` → host returns it as the MCP result.

---

## 6. Authentication & error codes

**Auth (mandatory).** Binding `127.0.0.1` is NOT access control — every local
process and OS user shares localhost. So:

1. On Connect, the **extension generates a random `token`** and sends it in the
   `open` payload. The popup displays it so the user pastes the full endpoint
   (`http://127.0.0.1:<port>/mcp` + `Authorization: Bearer <token>`) into their
   agent's MCP config.
2. The host requires `Authorization: Bearer <token>` on **every** MCP request;
   missing/wrong → HTTP 401.
3. The host MUST reject any request that carries an `Origin` header (no browser
   page has a legitimate reason to reach this endpoint) and MUST verify the
   `Host` header equals `127.0.0.1:<port>` (DNS-rebinding defense, per MCP's own
   local-server guidance). CORS is then belt-and-braces, not the gate.

**Error codes** (reply `error.code`): `UNKNOWN_TOOL`, `TAB_NOT_FOUND`,
`TIMEOUT`, `CSP_BLOCKED`, `SCRIPT_ERROR`, `FRAME_TOO_LARGE`, `VERSION_MISMATCH`,
`INVALID_ARGS`, `INTERNAL`, and the consent codes (§6a) `NOT_SHARED`,
`ORIGIN_DRIFT`, `ORIGIN_DENIED`, `CAP_NOT_GRANTED`.

## 6a. Consent semantics (Feature B)

Access is **default-deny** and enforced **inside the extension** (the sole path
to the browser; hosts are dumb relays and never authorize). Tiers: `none`
(default), `tabs` (explicit per-tab allowlist), `all` (current + future). A
persistent per-host **denylist** overrides every tier. The unit of trust is the
**host** (hostname), port- and scheme-agnostic, so users running sites on
non-standard ports should list origins by bare hostname (e.g. `mail.example.com`,
not `mail.example.com:8443`).

Per-tool behaviour a conforming extension MUST implement:
- **Enumerate** (`list_tabs`, `get_active_tab`): **filter** to shared tabs. Never
  return the title/URL of an unshared tab (a title is sensitive). `get_active_tab`
  on an unshared tab → `NOT_SHARED`.
- **Tab-targeting** (`navigate`, `get_page_content`, `execute_script`,
  `screenshot`, `activate_tab`, `close_tab`): the target tab's **current** origin
  is checked fresh at invoke time. Not shared → `NOT_SHARED`; on the denylist →
  `ORIGIN_DENIED`; a `stickyOrigin` grant whose tab has navigated away →
  `ORIGIN_DRIFT` (grant auto-revoked).
- **Create** (`open_tab`): denied under `none`; under `tabs` the created tab is
  auto-added to the allowlist.

The extension MAY send `event` notifications (ext→host, no reply) for
`permission_revoked` and `tab_removed`; hosts MAY ignore them.

---

## 7. Ports & multiple browsers

Because port↔browser is 1:1 (§1), the extension requests an **ephemeral port
(`port: 0`)** by default so N browsers need zero manual port config; the host
binds a free port and echoes it in the `open` reply. Each host records
`{ instanceId, label, port, token, pid }` in `~/.tabduct/instances/<id>.json`
(§9a); an agent gets a ready `--mcp-config` for every live instance via
`tabduct instances`. The popup MAY pin a fixed port instead; `12310` is the
documented default/fallback. A busy pinned port fails the `open` reply with
`INTERNAL` so the popup can show it and re-enable Connect.

### 9a. Discovery

Per-instance files under `~/.tabduct/instances/` (dir `0700`, files `0600` — they
hold the bearer token). Written on `open`, removed on clean shutdown; readers and
a self-heal-on-write drop entries whose `pid` is dead (survives SIGKILL). The
final multi-browser story (one stable endpoint) is the hub (roadmap Phase 3);
discovery is the zero-config interim.

---

## 8. MV3 service-worker lifetime

The extension's background is an MV3 service worker; it can be evicted. Contract:

- While the native-messaging port is connected, Chrome (≥116) keeps the worker
  alive — this is why `manifest.json` sets `minimum_chrome_version: 116`.
- If the worker is nonetheless evicted, the port dies → the host sees stdin EOF
  → it stops the server and exits (authoritative shutdown).
- The extension persists connection intent in `chrome.storage.session` and
  re-`connect()`s (with a fresh ephemeral port) from `chrome.runtime.onStartup`.
  **Scope:** `chrome.storage.session` is cleared on browser *exit*, so this
  restores an in-session evicted worker — NOT a full browser restart (on which
  the host process also died and removed its discovery entry). True
  cross-restart recovery is a hub-era feature. The popup reads state from
  storage, not from worker globals.

---

## 9. Registration (host responsibility, platform-specific)

A host ships `register` / `unregister` commands that install/remove the Chrome
Native Messaging manifest and (Windows) the registry key. The manifest's
`allowed_origins` MUST list the extension's stable ID, computed from
`extension/manifest.json`'s `key` (SHA-256 of the SPKI DER, first 16 bytes,
nibble→`a..p`). `register` templates an **absolute node path** into the launcher
so Chrome's minimal-env spawn resolves the runtime. See each host's README.

```jsonc
// com.tabduct.host.json
{
  "name": "com.tabduct.host",
  "description": "Tabduct native host",
  "path": "<absolute path to launcher>",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<STABLE_EXTENSION_ID>/"]
}
```

Per-OS manifest locations (Chrome): Windows → registry key
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tabduct.host`; macOS →
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`; Linux →
`~/.config/google-chrome/NativeMessagingHosts/`. Chromium/Edge/Brave use their
own dirs/keys — `register --browser` selects them.

---

## 10. Versioning

`protocolVersion` (int) lives in [`tools.schema.json`](tools.schema.json) and is
exchanged in the `open` handshake (§3). Mismatch → `VERSION_MISMATCH`. Breaking
changes bump the integer; additive tool changes do not.

## 11. Hub (Feature A, Phase 3)

Optional aggregation layer giving the agent **one stable endpoint** across many
browser instances. Reverse-proxy design (see docs/HUB-PLAN.md):

- The hub (`tabduct hub`) is an MCP **client** to each live direct host (found via
  discovery §9a, authed with that host's own token) and exposes one MCP **server**
  facade on `HUB_PORT` (12311, distinct from direct 12310), authed with a stable
  `tAgent` in `~/.tabduct/token` (0600 + Windows ACL).
- On-demand: a host whose extension sent `open{hub:true}` spawns the hub if
  `~/.tabduct/hub.json` is absent/dead, and its `open` reply returns
  `{ hub:true, endpoint, token }` (the stable hub URL+token, shown in the popup).
  The host still binds its own port + discovery so the hub can proxy it.
- **Composite tab handles** `"<instanceId>:<tabId>"` are created/parsed at the hub;
  the extension and base tool catalog are unchanged. The hub serves a *derived*
  catalog (composite `tabId`, optional `instanceId`, extra `list_instances` tool);
  no `protocolVersion` bump. Routing: composite `tabId` → that instance; else
  explicit `instanceId`; else single instance; else `AMBIGUOUS_INSTANCE`. Calls to
  a vanished instance → `INSTANCE_GONE`. Results (`list_tabs`/`get_active_tab`/
  `open_tab`/`navigate`) have their ids re-composited; screenshots pass through.
- Consent is still enforced by each extension; the hub makes no authorization
  decision. The hub self-exits ~60s after its registry is empty.
- **Accepted risks:** the shared `tAgent` reaches every instance's popup (blast
  radius = all shared tabs, bounded by consent); a well-known `HUB_PORT` on a
  multi-user box can be pre-bound to harvest `tAgent` (fate shared with any local
  MCP server); mixed hub+direct instances break "one endpoint" (`instances`/`doctor`
  warn). **Instance spoofing:** the hub proxies whatever instances appear in the
  0700 discovery dir, so a same-OS-user process could register a fake one — instance
  trust == same-OS-user trust (the hub does a `tools/list` shape check to drop
  obvious impostors, but this is not authentication). On Windows, a hub spawned by a
  browser-launched host may be job-killed when that browser closes — mitigated by
  `cmd /c start /B` (escapes the job); verify at real-browser E2E.
