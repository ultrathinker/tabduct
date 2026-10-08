# Architecture

## The whole picture

```
┌─────────────────────────────────────────────────────────────────┐
│ CLI agent  (Claude Code / Kilo / OpenCode / Cursor …)             │
│   speaks MCP — knows nothing about Tabduct internals              │
└───────────────┬───────────────────────────────────────────────────┘
                │  MCP  (streamable HTTP)   http://127.0.0.1:12311/mcp
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Tabduct HUB    (hosts/node/src/hub.js, started on demand)         │
│   • ONE stable endpoint + token for every connected browser       │
│   • routes a call to the right browser (composite tabId),         │
│     refuses calls the extension build cannot do (EXTENSION_OUTDATED)│
└───────────────┬───────────────────────────────────────────────────┘
                │  per-browser MCP endpoint (loopback, own token)
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Tabduct HOST   (hosts/node; Python and .NET: direct mode only)    │
│   • MCP server: registers tools from protocol/tools.schema.json   │
│   • Native-messaging client: stdio framing (protocol/PROTOCOL.md)  │
│   • Bridge: MCP call → tool_call msg → await response → MCP result │
│   • register/doctor CLI: installs native-messaging manifest        │
│   • watchdog: brings a dead hub back                              │
└───────────────┬───────────────────────────────────────────────────┘
                │  Chrome Native Messaging (stdin/stdout, length-prefixed JSON)
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Tabduct EXTENSION  (MV3, the one shared JS impl)                  │
│   • background.js: connectNative, start/stop (open/close), the consent│
│     gate, dispatch; wake.js brings a sleeping window forward        │
│   • handlers/: implement each tool via chrome.tabs / chrome.scripting│
│     / the debugger (CDP), each page tool on ONE pinned document     │
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
  specified wire protocol (`protocol/`). A host is a thin adapter: Node ≈1.5k LOC
  (it also carries the hub and the watchdog), Python ≈1.1k, .NET ≈1.2k, including
  `register`. Only the Node host has the hub the current extension requires; Python
  and .NET are direct-mode ports that have not been brought up to it.
- **The extension is the only thing that must be JS** and the only place real
  browser capability lives. It changes rarely; hosts are interchangeable.

## Request lifecycle (execute_script example)

1. Agent calls MCP tool `execute_script { code, tabId }` over HTTP to the hub, which
   picks the browser from the composite tab id and forwards the call to that host.
2. Host's MCP handler generates an `id`, sends over stdio:
   `{ type:"invoke", id, payload:{ tool:"execute_script", args } }`.
3. Extension `background.js` receives it, checks consent (`gate`), wakes the window if
   it is asleep and the user allows waking that tab, then runs
   `chrome.scripting.executeScript` in the target tab, captures the result.
4. Extension replies: `{ replyTo:id, ok:true, result }`.
5. Host resolves the pending promise, returns `result` as the MCP tool result.
6. Timeout guard (default 20 s, longer for `wait_for`) rejects to an MCP error if
   step 4 never comes.

## Trust & safety model

- **Auth is mandatory, not the bind address.** `127.0.0.1` is shared by every
  local process and OS user, so binding local is *not* access control. The
  extension mints a random bearer token on Start; the host requires
  `Authorization: Bearer <token>` on every MCP request, rejects any request that
  carries an `Origin` header, and verifies the `Host` header
  (DNS-rebinding defense). CORS is belt-and-braces only. See PROTOCOL.md §6.
- The host makes **no external network calls** — a design rule of the host
  (it only listens on loopback and talks to the hub and the extension); the
  conformance suite does not verify it.
- **Inherent risk:** whatever agent you connect gets a handle on your logged-in
  browser. That's the feature. Keep the server *on-demand* (Start + per-session
  agent launcher) so it isn't ambient.
- **Prompt-injection risk (must state honestly):** content returned by
  `get_page_content` / `execute_script` is attacker-authored input to the agent,
  and that same agent holds `execute_script` over your logged-in sessions. A
  hostile page can try to steer the agent. Mitigations: keep it on-demand, the
  origin filter / read-only / lock-to-domain limit the blast radius, the toolbar
  badge flashes a red ✕ when a call is denied (there is no signal for successful
  calls), and treat page text as untrusted in agent prompts.

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

## Waking a sleeping tab

A minimized window, a window covered by others or a background tab is "hidden" to
Chrome: the page stops drawing, reports no focus and cannot be screenshotted (DOM reads
and input still work, but the page is stale). Chrome offers no way to render a hidden
page, where waking is allowed (below) `extension/wake.js` brings the window
forward for `screenshot`, `type`, `click`, `press_key`, `get_page_content` and
`get_dom_snapshot` (and for any page tool when the page is frozen), and puts it back about 2.5 s after the last call (a minimized window
is minimized again; a covered one stays on top, an extension cannot lower a window). A
window the user is working in is never touched, and a tab Chrome unloaded to save memory
is never woken (that would reload the page). Shared tabs are marked non-discardable
while shared.

Two more cases. A page Chrome has *frozen* (hidden and silent for a long time, mostly under
Energy Saver) runs nothing, so scripting and CDP calls to it hang; the extension sees
`tab.frozen` and thaws it before the call through the debugger (`Page.setWebLifecycleState`
"active", `thawIfFrozen`), with no window involved; this needs the *Allow CDP eval* opt-in.
The debugger stays attached to the thawed tab for the call and a short linger after it (`thawHold`,
`releaseThaw`): a page nobody inspects can freeze again. `thawIfFrozen` tries three ways in turn
(`THAW_STEPS`: "active"; "frozen" then "active"; `Page.enable` then "active"), counts a try only when
`tab.frozen` stays false for a moment (`watchThaw`), and keeps a trace of what each did. A hung call's
`TIMEOUT` reports the freeze, the thaw outcome and that trace (`freezeNote`); the thaw's time counts
against the call's budget.
Chrome 154 does not let the debugger thaw every kind of freeze (one Chrome applied by itself was not
thawed; one applied from `chrome://discards` was), so a frozen page that stays frozen is
brought forward like a hidden one (as a click on its tab would): `wake(tabId, { force: true })` raises the window without asking the page
(it cannot answer) and waits for `tab.frozen` to go. If nothing may raise the window, the call fails at once
with `TAB_FROZEN` (the thaw trace and what to do) instead of waiting out the deadline.
And a call may carry `quiet:true` (feature `quiet`): the window is then never raised, not even
after a timeout, and a call that cannot be answered without it fails with an explanation.

**Who may wake a tab** (`consent.wakeAllowed`, resolved in the gate and handed on as `decision.wake`):
Silent mode (`silentMode` in storage.local, switched from the popup's header button, fanned out to every
browser through the hub's `setSilent` op) beats everything; then the tab's own switch (`allow[tabId].wake`,
written only when the user flips it: `setTabWake`, popup bell, or `_td/set_wake` from another browser's
popup); every other tab and the "Everything" tier follow the default (`wakeBrowser`, on, live). The same rule
covers the explicit requests to take the focus: `activate_tab` and `screenshot` with `activate:true` are
refused with `WAKE_NOT_ALLOWED`, and in Silent mode `open_tab` opens in the background. `list_tabs` reports
`wakeAllowed:false` and `frozen:true`. Unlike the other `_td/*` control ops (which only ever reduce what is
shared), `_td/set_wake` and `_td/set_silent` can switch things on, because they decide only whether a window
may be raised, never what an agent may read or do.
A call the page does not answer within 18 s ends with `TIMEOUT` (typically a "Leave site?"
dialog); unless quiet, the window is raised and left up so the user can answer it.

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
│   ├── python/              mcp SDK — direct mode only (no hub), per-OS register
│   └── dotnet/              ModelContextProtocol SDK — direct mode only (no hub), per-OS register
├── scripts/             # gen-key etc. and the tests (mock chrome, gate, wake, e2e)
└── docs/
```

## Build order (recommended)

1. `scripts/gen-key.js` → stable extension ID.
2. Extension: manifest + background + one tool (`execute_script`) + popup.
3. Node host: native-messaging + bridge + MCP server + register.
4. End-to-end smoke test with Claude Code (`--mcp-config` → the hub endpoint, 12311).
5. Fill in remaining tools.
6. `protocol/conformance/run.mjs`.
7. Python / .NET hosts (only when wanted) against the same conformance suite.
```
