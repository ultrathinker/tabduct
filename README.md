# Tabduct

**Give your CLI coding agent a handle on the real browser you're already using — the tabs you're logged into, not a throwaway sandbox.**

[![CI](https://github.com/ultrathinker/tabduct/actions/workflows/ci.yml/badge.svg)](https://github.com/ultrathinker/tabduct/actions/workflows/ci.yml) ![license](https://img.shields.io/badge/license-MIT-blue) ![manifest](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4) ![node](https://img.shields.io/badge/Node-%E2%89%A518-339933) ![local](https://img.shields.io/badge/network-127.0.0.1%20only-important) ![protocol](https://img.shields.io/badge/protocol-MCP-000000)

Tabduct is a tiny, local, **agent-agnostic** bridge. It exposes your *already-open,
already-logged-in* browser tabs to any agent that speaks the
[Model Context Protocol (MCP)](https://modelcontextprotocol.io) — Claude Code
today; Kilo, OpenCode, Cursor, and anything MCP-capable tomorrow.

No built-in chat. No embedded LLM. No vector DB. No telemetry. No native modules.
It does exactly one thing: hand your agent the tab you point it at — **under your
consent, on your machine only.**

<p align="center">
  <img src="docs/screenshots/popup.jpg" alt="Tabduct — Share Current Tab / Share Everything" width="270">
  &nbsp;&nbsp;
  <img src="docs/screenshots/settings.jpg" alt="Tabduct — Settings: connection, origin filter, sharing defaults" width="270">
</p>

```
   CLI agent (Claude Code / Kilo / OpenCode / …)
        │  MCP  (streamable HTTP, 127.0.0.1)         ← standard, language-neutral
        ▼
   Tabduct host   (Node — the reference host)         ← implements /protocol
        │  Chrome Native Messaging (stdio)           ← Tabduct wire protocol
        ▼
   Tabduct extension  (MV3 background service worker) ← the one shared impl
        │  chrome.tabs / chrome.scripting
        ▼
   Your live browser tab (cookies, sessions, DOM)
```

## Why Tabduct

- **Your real session.** The agent works with your logged-in tabs — no re-login, no captchas, no throwaway profile.
- **Local-only & private.** Binds `127.0.0.1`, guarded by a per-session bearer token. Nothing ever leaves your machine — no server, no telemetry, no external calls.
- **You're always in control.** Default-deny consent: share one tab or everything, block- *or* allow-list origins, read-only mode, auto-expiry, and a visible "⚡" group of shared tabs (drag a tab in to share it).
- **Agent- and language-agnostic.** MCP to the north, a tiny documented wire protocol to the south. One extension is the fixed point; every host is a thin adapter.
- **Minimal & auditable.** Reference host ~1–1.5k lines, zero native dependencies.

## Quickstart

Runs on **macOS, Linux, and Windows**, with **Chrome, Chromium, Edge, or Brave**. Requires **Node ≥ 18**.

```bash
git clone https://github.com/ultrathinker/tabduct.git && cd tabduct
npm install
npm run register        # installs the native-messaging manifest for your OS + browser
                        # other browsers: node hosts/node/bin/tabduct.js register --browser edge|brave|chromium
```

`register` writes the manifest to the right place automatically — `~/Library/Application Support/…/NativeMessagingHosts` on macOS, `~/.config/…/NativeMessagingHosts` on Linux, or an `HKCU` registry key on Windows (and makes the launcher executable on POSIX). Then:

1. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the **`extension/`** folder.
2. Click the **Tabduct** toolbar icon → **Start** (launches the local server; the header dot turns green). Click the dot again to **Stop**: a dialog asks what you mean, because the hub is shared by every connected browser: **restart the hub for all browsers** (shared tabs stay shared; the way to pick up new code), **stop in this browser only**, or **stop for all browsers** (every browser disconnects and stays stopped until you press Start in it).
3. Open **Settings (⚙)** → copy the **MCP endpoint** and **Authorization** token.
4. Paste them into your agent's MCP config (below) and reload the agent.
5. **Share** what the agent may touch: **Share Current Tab**, or **Share Everything**. That's it.

> Diagnose the host anytime with `npm run doctor`. In-app help lives under **Settings → How it works**.

## Point your agent at it (MCP)

> **Use the Node host.** The "shared hub" below is implemented only in
> `hosts/node/src/hub.js`, and the current extension requires it. The Python and .NET
> hosts are direct-mode ports that predate the hub (see the host table below), so they
> cannot be used with this extension yet.

With the shared hub (on by default **when using the Node host**), every browser
you connect appears behind one stable endpoint with a token that never changes:

```json
{
  "mcpServers": {
    "tabduct": {
      "type": "http",
      "url": "http://127.0.0.1:12311/mcp",
      "headers": { "Authorization": "Bearer PASTE_TOKEN_FROM_SETTINGS" }
    }
  }
}
```

Reload your agent and it discovers the Tabduct tools below. Start Tabduct in one
browser and any other browser you open joins the same hub automatically — you always
point your agent at `127.0.0.1:12311`, never at a per-browser port.

> **Tip — add it at the global / user scope.** Some agents (Claude Code included) scope
> MCP servers to the directory you configured them in, so a session launched from another
> folder won't see Tabduct. Register it globally instead — e.g. in Claude Code:
> `claude mcp add --scope user tabduct http://127.0.0.1:12311/mcp --header "Authorization: Bearer <token>"`.
> Cursor and most GUI clients already store MCP servers globally.

## Tools

| Tool | What it does |
|------|--------------|
| `list_tabs` / `get_active_tab` | Enumerate / get the focused tab — **filtered to shared tabs only** |
| `get_page_content` / `get_dom_snapshot` | Read a shared tab's text/HTML, or a compact outline of its interactive elements |
| `screenshot` | Capture the visible tab (returned as an MCP image) |
| `click` / `type` | Click an element / type into a field (or pick a `<select>` option), by CSS selector. `trusted: true` sends real browser-level input |
| `press_key` | Press a key (Enter, Tab, Ctrl+C…) as real keyboard input — terminals, custom widgets |
| `wait_for` | Wait for a selector, a piece of visible text, a URL fragment, or a load state (bounded; any one of them ends the wait) |
| `navigate` | Point a shared tab at a URL |
| `open_tab` / `activate_tab` / `close_tab` | Tab management |
| `get_console_logs` | Read the tab's console output (plus uncaught errors, in CDP mode) |
| `list_network_requests` / `get_network_request` | Inspect captured network traffic (CDP developer mode) |
| `execute_script` | Run arbitrary JS in a shared tab — read *and* modify the page |
| `list_frames` | List the iframes inside a shared tab — target one with `frameId` |

**Frames.** Embedded forms and widgets often live in an iframe from another domain
(HubSpot, Typeform, payment and sign-up forms), where page scripts can't reach.
`get_dom_snapshot` outlines each visible frame under its own `--- frame N ---`
header, and the page tools (`get_page_content`, `get_dom_snapshot`, `click`,
`type`, `wait_for`, `execute_script`, `get_console_logs`) take a `frameId` to work
inside it. The origin filter applies to each frame's own site.

**Trusted input.** Terminals (xterm.js — AWS CloudShell), Cloudscape/Material dropdowns and
canvas editors only react to events the browser itself generated. `type` / `click` with
`trusted: true`, and `press_key`, send exactly that through the DevTools Protocol. It needs the
same opt-in as CDP eval (**Allow CDP eval**, read-only off) and works inside cross-origin
frames for typing and keys. A terminal: `click` it (or `type` into its helper textarea,
`.xterm-helper-textarea`) with `trusted: true`, then `press_key Enter`. Paste shortcuts are refused
(they would read your clipboard).

Most tools — including `click` / `type` / `wait_for` / `get_dom_snapshot` — run as
**injected functions**, so they work even on strict-CSP sites (GitHub, banks, SaaS).
Only arbitrary-string `execute_script` is blocked by a page's CSP; for that, opt into
**CDP mode** (see below). Unshared tabs are **completely invisible** — the agent
can't even read their title.

## Using Tabduct without disturbing the user (rules for agents)

Tabduct works with the user's real browser, so an agent that raises the window interrupts a game, a call or a
presentation. The rules, also written into the tool descriptions:

1. **Read in the background.** `get_page_content`, `execute_script`, `get_dom_snapshot`, `list_frames`, console and network reads work on a
   minimized window or a background tab. Prefer them. A screenshot needs a drawn page: use it only when text will not do.
2. **For polling and scheduled checks pass `quiet: true`.** The call never brings the window forward, never activates a tab;
   when the page cannot answer without that you get an error that says so, and you can report it instead of interrupting the user.
3. **Without `quiet`**, and with the user's *Wake the browser* setting on, `screenshot`, `type`, `click`, `press_key`, `get_page_content` and
   `get_dom_snapshot` may bring a minimized or covered window forward and put it back afterwards. `activate_tab`, `screenshot` with
   `activate:true` and `open_tab` with `active:true` always take the user's focus: last resort only.
4. **A page Chrome has frozen is thawed silently** (see below) before the call, so a long-hidden tab is not a reason to raise anything.
   A call the page does not answer ends with `TIMEOUT` after 18 s: look for a dialog ("Leave site?") instead of retrying blindly, and do not call
   `location.reload()` from `execute_script` on a tab the user has been using.

**Why a tab stops answering.** Chrome slows timers in a hidden tab (once a second, once a minute after 5 minutes), can unload it from memory
(Tabduct marks shared tabs non-discardable) and, with Energy Saver on, *freezes* one that has been hidden and silent for more than five minutes: a
frozen page runs nothing, so every call to it hangs. Tabduct sees `tab.frozen` and thaws the page through the debugger (`Page.setWebLifecycleState`),
which needs *Allow CDP eval* on; without it, the usual wake (raising the window) is the fallback unless the call is `quiet`. Chrome has no extension
API for its "Always keep these sites active" list, so Tabduct does not touch it.

## Security & consent

The endpoint is **token-authenticated** — not merely bound to localhost (which
every local process shares). On Start the extension mints a bearer token; the
host requires `Authorization: Bearer <token>` on every request, rejects
`Origin`-bearing requests, and pins the `Host` header (DNS-rebinding defense).

Consent is **default-deny** and enforced inside the extension (the sole path to
the browser). All of these are in the popup:

- **Origin filter** — *Block* mode (listed sites are never shared) or *Allow* mode (only listed sites can ever be shared). Overrides every sharing mode.
- **Lock shared tabs to their domain** (default on) — a shared tab that navigates to another site is *paused*: the agent is refused and the tab disappears from its list, so a shared shopping tab can't follow you into your bank; the share is kept and resumes when the tab is back. It is a live setting — switching it off frees tabs you already shared.
- **Read-only** — the agent may look but never click, type, navigate, run scripts, or open/close tabs.
- **Auto-expire** — un-shares tabs after a chosen time (5 min … 10 h), counted from when each was shared or from when you changed the setting.
- **Wake the browser** (default on) — a minimized window, a window covered by others or a background tab does not draw, shows no focus and cannot be screenshotted, so `screenshot`, `type`, `click`, `press_key` and page reads come back stale or ignored. With this on, the extension brings that window forward for the call and puts it back afterwards (a minimized one is minimized again a few seconds after the last call; Windows gives the focus back to the app you were in). A window you are working in is never touched. Turn it off if you don't want the browser to pop up. A tab Chrome unloaded to save memory is never woken, since that would reload the page; shared tabs are marked as not discardable while shared.
- **Full access / Safe defaults** — one click over the flags above for "let the agent work freely on what I shared" (lock off, read-only off, no expiry, CDP eval on), or back to the safe side (lock on, CDP options off; read-only and expiry stay as you set them). The origin list is never touched.
- **Don't auto-share tabs the agent opens** (default on).
- **CDP mode** (Advanced, opt-in, default off) — lets `execute_script` bypass a page's CSP via the DevTools Protocol, with an optional "developer mode" that routes all eval through it and full console/error capture. Chrome forbids requesting `debugger` at runtime, so it's a **required** permission granted at install — but **nothing attaches until you flip this toggle on**, and use is still gated by consent (never in read-only). Chrome shows a "being debugged" banner whenever it's actually in use.
- Sharing resets when the browser restarts (so nothing stays shared by accident), but survives reloading the extension — handy after a `git pull`.

The full trust model and honest limitations are in [`SECURITY.md`](SECURITY.md) —
which is also where to report a vulnerability (please don't open a public issue).

## Multiple browsers & profiles

> This section describes the Node-host hub. The Python and .NET hosts expose one
> per-instance endpoint each, do not aggregate behind a shared endpoint and do not
> work with the current extension.

Install Tabduct in each Chrome profile you use (each Google account / profile is
separate). Start it in **one** browser — any other profile you open joins the same
hub automatically (no need to Start each). They all sit behind the one endpoint
(`127.0.0.1:12311`), and the agent tells them apart by their **Label** (auto-named
like `Chrome-abcd` — rename to `Work` / `Personal` in Settings).

The popup gives you **one place to manage all of them**: the shared-tab list is grouped
by browser (**Current** first, then each other browser that's sharing something), so you
can see everything that's exposed across every profile at a glance. The ✕ next to any tab
unshares it **even on another browser**; a browser in Share-Everything mode shows a single
**⚡ Sharing all tabs** row you can switch off the same way; and a **Revoke all sharing**
link clears every browser at once. (Cross-browser management flows through the hub over a
separate, token-authed control channel that the agent never sees — it can only ever
*reduce* sharing, never grant it; see [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md) §11a.)

## Two protocols, one extension, many hosts

Tabduct is defined by **contracts**, not implementations:

- **North (agent ↔ host): MCP.** Already standardized; SDKs for Node, Python, .NET. Nothing to invent.
- **South (host ↔ extension): the Tabduct wire protocol.** Chrome Native Messaging framing + message schema + tool catalog. Specified once in [`protocol/`](protocol/) — the single source of truth.
- **The extension is the fixed point** (it must be JS): it defines *what the browser can do*; every host is a thin relay of MCP calls to it (~1k lines in any language — see the per-host counts in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)).

| Host | Status | Hub | Notes |
|------|--------|-----|-------|
| [`hosts/node`](hosts/node) | ✅ reference impl | ✅ yes | zero native deps, Node ≥ 18, MCP SDK wired, conformance-passing; ships the shared hub facade (`hosts/node/src/hub.js`) |
| [`hosts/python`](hosts/python) | ⚠ direct mode only | ❌ no | official `mcp` SDK + `register` (macOS/Linux/Windows); predates the shared hub and the version/feature handshake, so the current extension (which requires the hub) can't use it |
| [`hosts/dotnet`](hosts/dotnet) | ⚠ direct mode only | ❌ no | `ModelContextProtocol` SDK, `net10.0` + `register`; same limitation |

> **Hub is currently a Node-host feature.** The shared hub (one stable endpoint
> behind which every connected browser appears) is implemented only in
> `hosts/node/src/hub.js`. The Python and .NET hosts do not read `payload.hub`
> and expose only their own per-instance MCP endpoint. See
> [`docs/ROADMAP.md`](docs/ROADMAP.md) for plans to bring the hub to the other hosts.

New languages need no permission — implement [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md) and pass [`protocol/conformance/`](protocol/conformance/).

## Project layout

```
extension/            MV3 extension (the fixed point): consent, sharing, popup, icons
hosts/node/           reference host — CLI (register/doctor/run/instances/hub) + src/
protocol/             PROTOCOL.md + JSON schemas + conformance runners
docs/                 ARCHITECTURE, DESIGN-consent-and-multibrowser, ROADMAP
scripts/              tests (consent, store, handlers, gate, wake, host; opt-in real-Chrome e2e), icon/key generators
```

Run the full test suite (pure JS, no browser needed): `npm test` — the consent, store,
handler, wake, gate and host tests (mock chrome / fake host) + host conformance + hub
conformance. Two opt-in runs use a real, throwaway Chrome: `npm run test:e2e` (headless)
and `npm run test:e2e-wake` (opens a window for a few seconds).

## Status

Working reference implementation, **pre-1.0**. Developed and exercised on Windows;
the macOS/Linux code paths are implemented (per-OS manifest install, POSIX file
modes, launcher `chmod`) but deserve a smoke test on each before you lean on them.
See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Originality

Tabduct is written from scratch. It reuses **no** third-party source code — only
standard, public interfaces: Chrome's Native Messaging framing (a documented OS
transport) and the Model Context Protocol. Nothing here carries a third-party
attribution obligation.

## License

MIT — see [`LICENSE`](LICENSE).
