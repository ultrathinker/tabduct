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
   Tabduct host   (Node · Python · .NET — pick one)  ← implements /protocol
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
- **You're always in control.** Default-deny consent: share one tab or everything, block- *or* allow-list origins, read-only mode, auto-expiry, and a visible "⚡" group of shared tabs you can drag in and out.
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
2. Click the **Tabduct** toolbar icon → **Start** (launches the local server; the header dot turns green). Click the dot again to **Stop** it.
3. Open **Settings (⚙)** → copy the **MCP endpoint** and **Authorization** token.
4. Paste them into your agent's MCP config (below) and reload the agent.
5. **Share** what the agent may touch: **Share Current Tab**, or **Share Everything**. That's it.

> Diagnose the host anytime with `npm run doctor`. In-app help lives under **Settings → How it works**.

## Point your agent at it (MCP)

Every browser you connect appears behind one stable shared-hub endpoint with a token
that never changes — so your agent config is fixed:

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
| `click` / `type` | Click an element / type into a field, by CSS selector |
| `wait_for` | Wait for a selector, URL fragment, or load state (bounded) |
| `navigate` | Point a shared tab at a URL |
| `open_tab` / `activate_tab` / `close_tab` | Tab management |
| `get_console_logs` | Read the tab's console output (plus uncaught errors, in CDP mode) |
| `execute_script` | Run arbitrary JS in a shared tab — read *and* modify the page |

Most tools — including `click` / `type` / `wait_for` / `get_dom_snapshot` — run as
**injected functions**, so they work even on strict-CSP sites (GitHub, banks, SaaS).
Only arbitrary-string `execute_script` is blocked by a page's CSP; for that, opt into
**CDP mode** (see below). Unshared tabs are **completely invisible** — the agent
can't even read their title.

## Security & consent

The endpoint is **token-authenticated** — not merely bound to localhost (which
every local process shares). On Start the extension mints a bearer token; the
host requires `Authorization: Bearer <token>` on every request, rejects
`Origin`-bearing requests, and pins the `Host` header (DNS-rebinding defense).

Consent is **default-deny** and enforced inside the extension (the sole path to
the browser). All of these are in the popup:

- **Origin filter** — *Block* mode (listed sites are never shared) or *Allow* mode (only listed sites can ever be shared). Overrides every sharing mode.
- **Lock shared tabs to their domain** (default on) — a shared tab that navigates away loses access, so a shared shopping tab can't follow you into your bank.
- **Read-only** — the agent may look but never click, type, navigate, run scripts, or open/close tabs.
- **Auto-expire** — un-shares everything after a chosen time (5 min … 10 h).
- **Don't auto-share tabs the agent opens** (default on).
- **CDP mode** (Advanced, opt-in, default off) — lets `execute_script` bypass a page's CSP via the DevTools Protocol, with an optional "developer mode" that routes all eval through it and full console/error capture. Chrome forbids requesting `debugger` at runtime, so it's a **required** permission granted at install — but **nothing attaches until you flip this toggle on**, and use is still gated by consent (never in read-only). Chrome shows a "being debugged" banner whenever it's actually in use.
- Sharing lives in session storage → it resets when the browser restarts.

The full trust model and honest limitations are in [`SECURITY.md`](SECURITY.md) —
which is also where to report a vulnerability (please don't open a public issue).

## Multiple browsers & profiles

Install Tabduct in each Chrome profile you use (each Google account / profile is
separate). Start it in **one** browser — any other profile you open joins the same
hub automatically (no need to Start each). They all sit behind the one endpoint
(`127.0.0.1:12311`), and the agent tells them apart by their **Label** (auto-named
like `Chrome-abcd` — rename to `Work` / `Personal` in Settings).

## Two protocols, one extension, many hosts

Tabduct is defined by **contracts**, not implementations:

- **North (agent ↔ host): MCP.** Already standardized; SDKs for Node, Python, .NET. Nothing to invent.
- **South (host ↔ extension): the Tabduct wire protocol.** Chrome Native Messaging framing + message schema + tool catalog. Specified once in [`protocol/`](protocol/) — the single source of truth.
- **The extension is the fixed point** (it must be JS): it defines *what the browser can do*; every host is a thin relay of MCP calls to it (~300–500 lines in any language).

| Host | Status | Notes |
|------|--------|-------|
| [`hosts/node`](hosts/node) | ✅ reference impl | zero native deps, Node ≥ 18, MCP SDK wired, conformance-passing |
| [`hosts/python`](hosts/python) | ✅ passes conformance | official `mcp` SDK + `register` (macOS/Linux/Windows) |
| [`hosts/dotnet`](hosts/dotnet) | ✅ passes conformance | `ModelContextProtocol` SDK, `net10.0` + `register` |

New languages need no permission — implement [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md) and pass [`protocol/conformance/`](protocol/conformance/).

## Project layout

```
extension/            MV3 extension (the fixed point): consent, sharing, popup, icons
hosts/node/           reference host — CLI (register/doctor/run/instances/hub) + src/
protocol/             PROTOCOL.md + JSON schemas + conformance runners
docs/                 ARCHITECTURE, DESIGN-consent-and-multibrowser, ROADMAP
scripts/              consent unit tests, icon/key generators
```

Run the full test suite (pure JS, no browser needed): `npm test` — consent unit
tests + host conformance + hub conformance.

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
