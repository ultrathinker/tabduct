# Tabduct — Implementation Plan

Living checklist. Design references: [ARCHITECTURE.md](ARCHITECTURE.md),
[../protocol/PROTOCOL.md](../protocol/PROTOCOL.md),
[DESIGN-consent-and-multibrowser.md](DESIGN-consent-and-multibrowser.md),
[ROADMAP.md](ROADMAP.md). Each step lists **files** and an **acceptance** check.
Work top-to-bottom; check items off as they land.

> Already done (scaffold + review fixes): protocol request/reply + auth spec,
> corrected frame limits, fatal-framing, navigate/screenshot/execute_script
> fixes, tab tools, MV3 storage+reconnect, register per-OS + unregister + doctor,
> gen-key clobber fix, icons, identity minted. See git/notes.

---

## Phase 0 — MVP core: make the MCP loop real
Goal: an agent can actually call tools through the host into the extension.

- [x] **0.1 Install SDK** — `@modelcontextprotocol/sdk` in `hosts/node`.
      *Files:* `hosts/node/package.json`. *Accept:* `npm ls` shows it; pure-JS,
      installs clean on Node 24.
- [x] **0.2 Wire `mcp-server.js`** — low-level `Server` +
      `StreamableHTTPServerTransport` at `/mcp`; session handling; keep the
      auth/Origin/Host gate; delegate tools to `tools.js`.
      *Files:* `hosts/node/src/mcp-server.js`. *Accept:* server answers a JSON-RPC
      `initialize` + `tools/list` over HTTP with the bearer token.
- [x] **0.3 Wire `tools.js`** — `setRequestHandler(ListToolsRequestSchema…)` and
      `CallToolRequestSchema` → `bridge.invoke`; screenshot → MCP image content.
      *Files:* `hosts/node/src/tools.js`. *Accept:* `tools/list` returns the
      catalog verbatim; `tools/call` routes an `invoke` onto the wire.
- [x] **0.4 Self-contained smoke (no Chrome)** — `scripts/smoke-host.mjs` spawns
      the host, feeds a framed `open`, plays the extension, drives MCP over HTTP.
      ✅ PASSES: open handshake, port bind, initialize+session, 401 on bad token,
      tools/list == catalog (9), tools/call emits invoke + result returns.
- [ ] **0.5 `register` + real browser E2E** — `tabduct register`; load
      `extension/` unpacked; Connect; point `ccodew-br` (`--mcp-config`) at
      `127.0.0.1:12310/mcp` + token; drive `list_tabs` + `execute_script` +
      `screenshot`. *Accept:* recolor an element on a real page from the CLI.

## Phase 1 — Feature B v1: per-tab consent (extension-only) — ✅ DONE
Goal: default-deny; share one tab and work; never leak unshared tabs.
Landed: `extension/consent.js` (pure `evaluate`/`denyMatch`/`visibleTabIds`),
consent chokepoint in `background.js`, enumerate filtering, per-tab badge,
hotkey (`Ctrl+Shift+Y`), popup Sharing section, origin denylist, error codes,
PROTOCOL §6a. Verified: `scripts/test-consent.mjs` 22/22 + host smoke green.

- [ ] **1.1 Error codes** — add `NOT_SHARED`, `ORIGIN_DRIFT`, `ORIGIN_DENIED`,
      `CAP_NOT_GRANTED`. *Files:* `hosts/node/src/constants.js` (ERR),
      `protocol/PROTOCOL.md` §6.
- [ ] **1.2 Consent store** — `extension/consent.js`: tier (`none`|`tabs`|`all`),
      allowlist in `chrome.storage.session`, denylist in `chrome.storage.local`;
      cached, write-invalidated. *Accept:* unit-reasoned; survives SW eviction.
- [ ] **1.3 `consentGate`** — in `handleInvoke` before the handler; fresh
      `chrome.tabs.get` → current origin; deny/origin-drift/denylist/caps checks.
      *Files:* `extension/background.js`, `extension/handlers/index.js`
      (`resolveTabId`). *Accept:* invoke on an unshared tab → `NOT_SHARED`.
- [ ] **1.4 Leak-proof enumeration** — `list_tabs`/`get_active_tab` return only
      shared tabs; never disclose unshared titles/URLs. *Accept:* unshared tab
      absent from `list_tabs`.
- [ ] **1.5 `open_tab` auto-share** — under `tabs` tier, a tab the agent opens
      auto-joins the allowlist (stickyOrigin), denylist still applies.
- [ ] **1.6 Popup Sharing section** — segmented tier control, "Share this tab",
      shared-tab list (favicon/title/origin + per-row ✕, click→activate),
      "Revoke all". *Files:* `extension/popup.{html,js,css}`.
- [ ] **1.7 Per-tab badge** — `chrome.action.setBadgeText({tabId})` marks shared
      tabs; red flash on denied invoke. *Files:* `extension/background.js`.
- [ ] **1.8 Hotkey** — `chrome.commands` "toggle share current tab".
      *Files:* `extension/manifest.json`, `extension/background.js`.
- [ ] **1.9 Protocol semantics** — PROTOCOL.md section: filter-vs-deny per tool;
      wire `event` for `permission_revoked`/`tab_removed`.

## Phase 2 — Feature A Phase 1: auto-port + discovery (kill manual ports) — ✅ DONE
Landed: ephemeral port (`open port:0` → bound port echoed), extension mints
stable `instanceId`+label, `hosts/node/src/discovery.js` (per-instance files in
`~/.tabduct/instances/`, written on open / removed on close+exit),
`tabduct instances` CLI (emits `--mcp-config`). Verified in smoke.
- [ ] **2.1 Ephemeral port** — host `listen(0)`; report the bound port back in the
      `open` reply. *Files:* `hosts/node/src/{mcp-server,index}.js`.
- [ ] **2.2 instanceId + label** — extension mints stable `instanceId`
      (`storage.local`) + editable label; sent in `open`. *Files:* extension.
- [ ] **2.3 Discovery file** — host writes `~/.tabduct/instances.json` (0600)
      `{instanceId,label,port,token,pid}`; removes its entry on exit.
      *Files:* `hosts/node/src/index.js`, new `discovery.js`.
- [ ] **2.4 Agent config helper** — `tabduct instances` prints an `--mcp-config`
      JSON listing all live instances. *Files:* `hosts/node/bin/tabduct.js`.

## Phase 3 — Feature A Phase 2: on-demand hub (one stable endpoint) — ✅ DONE
Built as an **MCP reverse-proxy** (revised after Fable's plan review; see
docs/HUB-PLAN.md): `hosts/node/src/hub.js` (facade via injected registrar + MCP
clients to instances from discovery + composite-id routing/fan-out + idle
self-exit), `secrets.js` (stable tAgent, atomic, TABDUCT_DIR-aware),
`index.js` `ensureHub()` on `open{hub:true}` + hub endpoint/token reply,
`bin hub`/`instances` hub-aware, extension "Shared hub" toggle + tabId hardening,
`protocol/conformance/run-hub.mjs`. Verified: hub conformance 14/14 (aggregation,
composite routing, AMBIGUOUS/INSTANCE_GONE, failover, auth); `npm test` green.
Hosts unchanged → Phases 0–2 stay green.
- [ ] **3.1 Composite tab handles** — `"<instanceId>:<tabId>"` in tool schemas;
      bump `protocolVersion`; back-compat bare int for single instance.
      *Files:* `protocol/*`, extension handlers.
- [ ] **3.2 `list_instances` / `set_instance_label`** tools + `AMBIGUOUS_INSTANCE`,
      `INSTANCE_GONE` codes.
- [ ] **3.3 Hub process** — `tabduct hub` mode: MCP server + backend listener
      (named pipe / AF_UNIX, 0700); router by instanceId; parallel `list_tabs`
      fan-out; stream large replies. *Files:* new `hosts/node/src/hub.js`.
- [ ] **3.4 Backend mode** — host dials the hub instead of binding TCP; registers;
      relays. First host auto-spawns hub `detached`; hub self-exits ~60s idle.
- [ ] **3.5 Stable token file** — `~/.tabduct/token` (0600) as `T_agent`+`T_backend`;
      popup shows the one stable URL+token; `tabduct rekey`.
- [ ] **3.6 Failover test** — close one browser; others + agent uninterrupted;
      calls to gone tabs → `INSTANCE_GONE`.

## Phase 4 — Feature B v2 — ✅ DONE
- [x] `all` tier with confirm (session-scoped) · per-tab `caps` (read-only mode,
      enforced via REQUIRED_CAP → CAP_NOT_GRANTED) · TTL/expiry (+ alarms sweep) ·
      opt-in Tab-Group "⚡ agent" marking (`tabGroups`) · instance label field.
      Verified: consent tests 34/34 (added caps + TTL), smoke green.

## Phase 5 — Hardening / roadmap — ✅ CORE DONE
Landed: `protocol/conformance/run.mjs` (host-neutral conformance runner, `-- <cmd>`
for any host), `protocol/messages.schema.json` (shared wire-name enum), root
`npm test` (consent + conformance). Remaining below are documented future work.
- [ ] `chrome.userScripts` for CSP-proof `execute_script` (min_chrome 116→135,
      `userScripts` perm, popup toggle).
- [ ] `protocol/conformance/run.mjs` + vectors; run against every host in CI.
- [ ] `messages.schema.json` shared wire-name enum (kill vocabulary drift).
- [ ] Capability handshake · get_page_content pagination · Python/.NET hosts ·
      Firefox scoping · prompt-injection UX polish.

---

## Working rules
- One step at a time; validate syntax after each; keep `TODO(build)` markers
  honest. Update this file's checkboxes as steps land.
- Extension is the security boundary — consent logic lives there, never in hosts.
- After each phase: a self-contained smoke (Phase 0.4 pattern) before moving on.
