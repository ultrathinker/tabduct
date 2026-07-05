# Architecture

## The whole picture

```
┌─────────────────────────────────────────────────────────────────┐
│ CLI agent  (Claude Code / Kilo / OpenCode / Cursor …)             │
│   speaks MCP — knows nothing about Tabduct internals              │
└───────────────┬───────────────────────────────────────────────────┘
                │  MCP  (streamable HTTP)   http://127.0.0.1:<port>/mcp
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Tabduct HOST   (hosts/node | hosts/python | hosts/dotnet)         │
│   • MCP server: registers tools from protocol/tools.schema.json   │
│   • Native-messaging client: stdio framing (protocol/PROTOCOL.md)  │
│   • Bridge: MCP call → tool_call msg → await response → MCP result │
│   • register/doctor CLI: installs native-messaging manifest        │
└───────────────┬───────────────────────────────────────────────────┘
                │  Chrome Native Messaging (stdin/stdout, length-prefixed JSON)
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Tabduct EXTENSION  (MV3, the one shared JS impl)                  │
│   • background.js: connectNative, start/stop (open/close), dispatch │
│   • handlers/: implement each tool via chrome.tabs / chrome.scripting│
│   • popup: status + port + Start button                            │
└───────────────┬───────────────────────────────────────────────────┘
                │  chrome.scripting.executeScript / chrome.tabs / captureVisibleTab
                ▼
        Your live, logged-in browser tab
```

## Why this split

- **Agent-agnosticism is free.** The north edge is MCP; any MCP client works
  with no Tabduct-specific code. "Support Kilo/OpenCode" = "they speak MCP".
- **Host-language-agnosticism is cheap.** The south edge is a small, fully
  specified wire protocol (`protocol/`). A host is a thin adapter, ~300–500 LOC.
- **The extension is the only thing that must be JS** and the only place real
  browser capability lives. It changes rarely; hosts are interchangeable.

## Request lifecycle (execute_script example)

1. Agent calls MCP tool `execute_script { code, tabId }` over HTTP.
2. Host's MCP handler generates an `id`, sends over stdio:
   `{ type:"invoke", id, payload:{ tool:"execute_script", args } }`.
3. Extension `background.js` receives it, runs
   `chrome.scripting.executeScript` in the target tab, captures the result.
4. Extension replies: `{ replyTo:id, ok:true, result }`.
5. Host resolves the pending promise, returns `result` as the MCP tool result.
6. Timeout guard (default 20 s) rejects to an MCP error if step 4 never comes.

## Trust & safety model

- **Auth is mandatory, not the bind address.** `127.0.0.1` is shared by every
  local process and OS user, so binding local is *not* access control. The
  extension mints a random bearer token on Start; the host requires
  `Authorization: Bearer <token>` on every MCP request, rejects any request that
  carries an `Origin` header, and verifies the `Host` header
  (DNS-rebinding defense). CORS is belt-and-braces only. See PROTOCOL.md §6.
- The host makes **no external network calls** — enforced by contract and
  checked in conformance.
- **Inherent risk:** whatever agent you connect gets a handle on your logged-in
  browser. That's the feature. Keep the server *on-demand* (Start + per-session
  agent launcher) so it isn't ambient.
- **Prompt-injection risk (must state honestly):** content returned by
  `get_page_content` / `execute_script` is attacker-authored input to the agent,
  and that same agent holds `execute_script` over your logged-in sessions. A
  hostile page can try to steer the agent. Mitigations: keep it on-demand, flash
  the toolbar icon on every `invoke` (activity signal), and treat page text as
  untrusted in agent prompts.

## MV3 service-worker lifetime

The extension background is an MV3 service worker and can be evicted.

- While the native-messaging port is connected, Chrome ≥116 keeps the worker
  alive — hence `minimum_chrome_version: 116` (do not lower it).
- On eviction the port dies → host gets stdin EOF → host stops and exits
  (authoritative shutdown).
- The extension persists `{ port, token, state }` in `chrome.storage.session`
  and re-`connect()`s from `chrome.runtime.onStartup`, so a restarted worker or
  browser restores the endpoint without a manual reconnect. The popup reads
  state from storage, never from worker globals. See PROTOCOL.md §8.

## execute_script & page CSP

Arbitrary-string eval via `chrome.scripting.executeScript` is blocked by a page's
CSP in the MAIN world (GitHub, banks, most SaaS) — it surfaces cleanly as
`CSP_BLOCKED`. (ISOLATED world was removed: the extension CSP forbids eval there,
so it could never succeed.) Tabduct addresses this on three levels:

1. **Injected-function tools sidestep CSP entirely.** `click`, `type`, `wait_for`,
   `get_dom_snapshot`, `get_page_content`, and the console hook run as injected
   *functions* (not string eval), which a page's CSP does not block — so the common
   interaction/read cases work everywhere, with no extra permission or banner.
2. **CDP mode** (opt-in via the *Allow CDP eval* toggle, default off) runs arbitrary
   `execute_script` via the DevTools Protocol with `allowUnsafeEvalBlockedByCSP`,
   bypassing CSP. Chrome forbids `debugger` as an optional/runtime permission, so it
   is a **required** permission granted at install; the toggle — not a permission
   prompt — is the actual opt-in, and nothing attaches until it is on.
   `execute_script`'s `engine` is `auto|scripting|cdp` (auto falls back to CDP on
   `CSP_BLOCKED` when enabled) and the result carries a `via:"cdp"|"scripting"` marker
   so the caller can tell which path ran; a developer-mode toggle forces CDP
   everywhere; and full console/exception/Log capture rides the same attach. Gated
   by consent (never under read-only), signalled by Chrome's "being debugged"
   banner (and a red header chip in the persistent developer-mode variants). See
   PROTOCOL.md §6b and the cdpConsole section below.
3. **`chrome.userScripts`** (roadmap, Chrome 135+) — the banner-free, CSP-proof eval
   for once the min version is raised + a user "Allow user scripts" toggle is
   surfaced; `engine:auto` should prefer it over CDP when available. Tracked in
   [ROADMAP.md](ROADMAP.md).

## CDP console capture (cdpConsole, developer mode)

`get_console_logs` has two capture paths. The default is a CSP-safe injected
console monkeypatch (MAIN world, no debugger) — but it only sees `console.*`
calls made *after* it installs, and misses uncaught exceptions and browser log
entries (network/CSP/deprecation warnings). When the user opts into **"Capture
full console & errors via CDP"** (requires "Allow CDP eval"), the extension
proactively attaches the Chrome DevTools Protocol debugger to every shared tab
with `Runtime` + `Log` domains enabled and buffers every
`Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, and `Log.entryAdded`
event. `get_console_logs` then returns that full buffer (the result's `source`
field is `"cdp"`; otherwise `"inject"`). The trade-off is the same one as force
mode: the browser keeps a visible **"this tab is being debugged" banner** up on
every shared tab while capture is on. Attachment is reconciled in
`refreshBadges()`: turning the option on attaches capture to all shared tabs,
sharing a new tab attaches it, and unsharing/closing/disabling stops it. A tab
may be held attached by two independent reasons (cdpEval force mode and console
capture); detach is gated on a shared `cdpHeld(tabId)` predicate so neither
path tears the other's session down.

## Repo map

```
tabduct/
├── protocol/            # THE CONTRACT (language-neutral, source of truth)
│   ├── PROTOCOL.md          wire protocol (framing + messages + host rules)
│   ├── tools.schema.json    tool catalog (names + JSON Schemas + version)
│   └── conformance/         tests every host must pass
├── extension/           # the one shared MV3 extension (JS)
├── hosts/
│   ├── node/                reference host (build first)
│   ├── python/              mcp SDK — passes conformance, per-OS register
│   └── dotnet/              ModelContextProtocol SDK — passes conformance, per-OS register
├── scripts/             # gen-key etc.
└── docs/
```

## Build order (recommended)

1. `scripts/gen-key.js` → stable extension ID.
2. Extension: manifest + background + one tool (`execute_script`) + popup.
3. Node host: native-messaging + bridge + MCP server + register.
4. End-to-end smoke test with Claude Code (`--mcp-config` → 12310).
5. Fill in remaining tools.
6. `protocol/conformance/run.mjs`.
7. Python / .NET hosts (only when wanted) against the same conformance suite.
```
