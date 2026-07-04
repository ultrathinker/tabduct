# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims for
[Semantic Versioning](https://semver.org/) once it reaches 1.0.

## [Unreleased]

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
