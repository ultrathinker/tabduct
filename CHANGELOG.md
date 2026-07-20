# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims for
[Semantic Versioning](https://semver.org/) once it reaches 1.0.

## [Unreleased]

### Added
- **CSP-safe interaction tools** — `click`, `type`, `wait_for`, `get_dom_snapshot`,
  and `get_console_logs`, implemented as injected functions so they work even on
  strict-CSP sites (GitHub, banks, SaaS) with no extra permission.
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
- Settings popup redesigned into a widened two-column layout (no vertical scroll).

## [0.0.1] — unreleased

> The published code manifests (`package.json`, `extension/manifest.json`,
> `hosts/python/pyproject.toml`) all declare version `0.0.1`; this changelog
> follows them. There is no released `0.0.1` tag yet.

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
