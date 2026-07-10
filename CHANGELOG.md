# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims for
[Semantic Versioning](https://semver.org/) once it reaches 1.0.

## [1.4.0] — 2026-07-10

### Added
- **Cross-instance sharing view in the popup.** The shared-tab list is now grouped by
  browser — **Current** first, then every other browser behind the hub that is sharing
  something — so you can see, in one popup, exactly what each of your browsers exposes.
- **Unshare across browsers.** The ✕ next to any tab works on *other* browsers too, and an
  instance in Share-Everything mode shows a single **⚡ Sharing all tabs** row with its own
  ✕ that turns it off — all from whichever popup you have open.
- **"Revoke all sharing"** — a compact link at the bottom of the popup that appears whenever
  anything is shared *anywhere* and clears sharing across **every** browser at once.
- Share-Everything now shows a **⚡ Sharing all tabs** row in the list (previously the list
  was empty in that mode), with a ✕ to stop it — so it can be stopped from the list as well
  as the button.

### Security
- Cross-instance status and unshare travel over a **separate, non-MCP `/control` endpoint**
  on the hub, authed with a distinct `tControl` bearer that is **never disclosed to the
  agent** (the agent's `/mcp` path refuses the internal `_td/*` ops). The popup reaches it
  only through its own host, so the "`Origin` always rejected" invariant is preserved. The
  control ops can only ever **reduce** sharing — never grant it. See `PROTOCOL.md` §11a.

## [1.3.0] — 2026-07-09

### Changed
- The shared hub is now the **only** agent-facing endpoint — the "Shared hub" toggle is
  removed. The popup always shows the stable hub endpoint (`127.0.0.1:12311`); each
  browser's per-instance port is internal (the hub proxies it) and never surfaced, so your
  agent config never changes.

### Added
- **Auto-join** — opening a browser while a hub is already running connects it
  automatically (no Start click). Start Tabduct in one browser and every other browser you
  open joins the same hub. An explicit **Stop** opts that browser out for the rest of the
  browser session (sticky across popup reopens and service-worker sleep); reloading the
  extension or restarting the browser clears it and re-enables auto-join.

### Fixed
- **Hub auto-start on Windows** — the host spawned the hub via `cmd /c start /B … 2>>log`,
  where the redirect bound to `start` (not the hub), so the hub silently never came up and
  the popup fell back to a per-instance direct port (multi-instance appeared "invisible").
  Now spawned directly with its output captured to `hub.log`. If the hub still can't start,
  the popup shows a **loud error** instead of silently exposing a direct endpoint.

### Documentation
- Setup instructions (README, the in-app **How it works**, and the **Set up with your AI**
  prompt) now recommend registering the MCP server at the **global / user scope** (e.g.
  `claude mcp add --scope user`) so Tabduct is visible from any working directory — not
  just the folder it was configured in. Agents like Claude Code otherwise scope MCP servers
  per-project, so a session started elsewhere wouldn't see it.

## [1.2.0] — 2026-07-06

### Added
- **CSP-safe interaction tools** — `click`, `type`, `wait_for`, `get_dom_snapshot`,
  and `get_console_logs`, implemented as injected functions so they work even on
  strict-CSP sites (GitHub, banks, SaaS) with no extra permission.
- **Network inspection** — `list_network_requests` and `get_network_request` (method,
  status, timing, request/response headers, response body), captured via CDP under the
  same opt-in as console capture.
- **"Set up with your AI"** — a one-click panel (a one-time button on first run, plus a
  permanent one in Settings) with a copy-paste prompt that walks your AI coding agent
  (Claude Code, Cursor, any MCP client) through connecting Tabduct as an MCP server.
- Screenshot tool gained optional `selector` / `scrollTo` to scroll a target into view
  before capturing the viewport.
- Extension version shown at the bottom of the Settings screen.
- **CDP mode** (opt-in via an in-popup toggle, default off): `execute_script` gains
  an `engine` (auto/scripting/cdp) with a CSP-blocked → CDP fallback; a
  developer-mode toggle that routes all eval through CDP; and full
  console/exception/browser-log capture surfaced through `get_console_logs`. Gated
  by the `allowCdp` toggle + consent (never under read-only), signalled by a "CDP"
  header chip and Chrome's "being debugged" banner. Note: Chrome does not allow
  `debugger` as an optional/runtime permission, so it is declared as a required
  permission (granted at install) — but nothing attaches until the toggle is on.

- **Python host** (`hosts/python`, official `mcp` SDK) and **.NET host**
  (`hosts/dotnet`, `ModelContextProtocol` SDK, net10.0) — both pass the full
  conformance suite, each with its own per-OS `register` (native-messaging manifest
  install for macOS/Linux/Windows). Multi-language is no longer paper-only.

### Changed
- Settings popup redesigned into a widened two-column layout (no vertical scroll,
  auto-balancing multi-column cards).

### Fixed
- Critical: corrected a native-host module import path that prevented the extension's
  service worker from loading (nothing worked until fixed).
- Hardened origin-drift (TOCTOU) checks: an in-page origin re-check immediately before a
  screenshot capture, and a `pendingUrl` check for the network tools (closes a
  pending-navigation data-leak window).

### Removed
- Full-page screenshot capture — unreliable on virtualized / infinite-scroll SPAs
  (YouTube, Facebook) where beyond-viewport capture repeats/wraps content. Use the
  visible-area capture with `selector` / `scrollTo` instead.

## [0.1.0] — pre-release

First public reference implementation.

### Added
- **MV3 extension** — the fixed point and security boundary: per-tab consent
  (tiers `none`/`tabs`/`all`), origin filter with **Block/Allow** modes,
  **lock-to-domain**, **read-only**, **auto-expire**, and **don't-auto-share** of
  agent-opened tabs.
- **Sharing UX** — Share Current Tab / Share Everything, a tab-count badge, a
  three-state toolbar icon, a two-way "⚡" tab group (drag in to share, out to
  unshare), a page context-menu toggle, and the `Ctrl+Shift+Y` shortcut.
- **Node reference host** — MCP streamable-HTTP server with token auth, the Chrome
  native-messaging wire protocol, per-OS `register`, and a `doctor` command.
- **Hub** — an MCP reverse-proxy that aggregates multiple browsers behind one
  stable endpoint (`127.0.0.1:12311`); on by default, with per-tab
  `instanceLabel` surfaced to the agent.
- **Protocol** — `PROTOCOL.md`, JSON schemas, and conformance runners (host + hub).
- **Tools** — `list_tabs`, `get_active_tab`, `get_page_content`, `screenshot`,
  `navigate`, `open_tab`, `activate_tab`, `close_tab`, `execute_script`.
- Cross-platform native-host registration (macOS / Linux / Windows;
  Chrome / Chromium / Edge / Brave).

### Security
- Local-only (`127.0.0.1`), bearer-token auth, `Origin` rejected, `Host` pinned.
- Authorization checked before the denylist (no origin-membership oracle).
- Hub discloses its token only after verifying the listener is genuinely our hub.
- In-page origin re-check on `get_page_content` / `execute_script` (TOCTOU).

[Unreleased]: https://github.com/ultrathinker/tabduct/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ultrathinker/tabduct/releases/tag/v0.1.0
