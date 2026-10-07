# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims for
[Semantic Versioning](https://semver.org/) once it reaches 1.0.

## [1.6.3] — 2026-10-07

### Fixed
- **A script that never finishes no longer blocks every later `execute_script` on that tab.** Evals
  on one tab run one after another (they share the Runtime domain); with no deadline, one that never
  completed (code awaiting an animation frame in a minimized window, an open dialog, a promise nobody
  resolves) held the queue for good, so every later `execute_script` on that tab timed out while
  reads through `get_page_content` kept working. After 18 s the debugger is detached (the pending
  command fails), the caller gets `SCRIPT_ERROR` saying the script did not finish, and the next eval
  runs. Covered by a mock test and, in a real Chrome, by `npm run test:e2e`.

### Changed
- Documentation brought in line with the code: the architecture diagram shows the hub, the host
  watchdog and `wake.js`; the roadmap marks the capability handshake as done and the Python and .NET
  hosts as direct-mode only; the test commands (`npm test` chain, `test:e2e`, `test:e2e-wake`) are
  described as they are; `PROTOCOL.md` no longer cites `cmd /c start /B` for the hub (it is a plain
  detached child, restarted by the host watchdog); the conformance README says checks 4-6 are
  skipped, not failed, for non-Node hosts; the `get_dom_snapshot.maxChars` description matches the
  code (0 uses the 40000 default).

## [1.6.2] — 2026-10-07

### Fixed
- `type` (trusted) no longer says "the page did not report focus" when the focus simply showed up a
  moment after `focus()` (a frame in another process such as CloudShell, or a window that was just
  brought forward): it looks again after 150 ms and warns only if the page still reports none.

## [1.6.1] — 2026-10-07

### Added
- **Wake the browser** (Settings, default on). A minimized window, a window covered by others or a
  tab in the background does not draw, reports no focus and cannot be screenshotted, so an agent
  saw its input "ignored" and pages that never repainted (a scheduled check of a terminal, a
  dropdown). Now `screenshot`, `type`, `click`, `press_key`, `get_page_content` and
  `get_dom_snapshot` bring such a window forward for the call: a minimized window is restored, used,
  and minimized again a few seconds after the last call (Windows hands the focus back to the app you
  were in; a maximized window comes back maximized); a covered window is raised and its tab shown,
  the previously active tab put back. A window you are working in is never touched, and with the
  setting off nothing is. Verified in a real Chrome (`npm run test:e2e-wake`, opt-in, opens a window
  for a few seconds).
- Shared tabs are marked `autoDiscardable: false` while shared (given back on unshare), so Chrome's
  Memory Saver does not unload them (a discarded tab reloads with a new tab id and loses its state).
  A tab that is discarded anyway is not woken: the agent gets a clear error instead of a silent reload.

### Changed
- The `type` warning "the page did not report focus" now says what it means: the tab or window is in
  the background, the input was sent but may not have been handled or drawn yet.

## [1.6.0] — 2026-10-07

### Added
- **Trusted input.** `type` and `click` take `trusted: true`, and there is a new tool
  `press_key` (Enter, Tab, Escape, arrows, F-keys, Ctrl+C…). They send real, browser-level
  input (`Input.insertText` / mouse / key events through the DevTools Protocol), which is what
  terminals (xterm.js — e.g. AWS CloudShell), Cloudscape/Material dropdowns and canvas or
  rich-text editors require: they ignore scripted `el.click()` and synthetic `input` events.
  Same opt-in as CDP eval (*Allow CDP eval* on, read-only off); refused while the page contains
  (even hidden) a frame of a site the origin filter excludes - re-checked over the very debugger
  session that sends the events; typing and keys also work inside cross-origin frames. Paste
  shortcuts are refused (they would read your clipboard). `type` with `trusted` takes an optional `selector` (omit it to type into whatever has focus).
- **Full access / Safe defaults presets** in Settings: one click over the ordinary flags
  (lock-to-domain off, read-only off, no auto-expire, CDP eval on — never the origin list or the
  frame rule), with a confirmation and a header chip while active. *Safe defaults* turns the lock
  on and the CDP options off and leaves read-only and the expiry time alone.
- **Version/feature handshake.** `open` carries `extensionVersion` and `features`. A call that
  needs a feature the loaded extension build lacks (`list_frames`, a `frameId`, trusted input)
  is refused with `EXTENSION_OUTDATED` instead of being silently run somewhere else — an older
  extension used to ignore `frameId` and execute the script in the top page. The host also warns
  (visible in the popup) when the running extension is older than the code on disk, and
  `list_instances` shows each browser's extension version and features.
- Sharing **survives an extension Reload** (after every `git pull`): grants are mirrored to
  `storage.local` and restored on `onInstalled(update)` for tabs that still exist on the host they
  were shared on. A browser restart still clears sharing.
- `tabs.onReplaced` is handled (Chrome swapping a tab id no longer drops the share).
- Popup: paused shares are listed greyed with a stop button; a host warning is visible while connected.
- Tests: `scripts/test-store.mjs`, `test-handlers.mjs`, `test-gate.mjs`, `test-host.mjs` (mock
  chrome / fake host) and an opt-in real-Chrome end-to-end run, `npm run test:e2e`.

### Changed
- **Lock-to-domain and auto-expire are live settings.** They used to be sealed into each share at the
  moment it was made, so switching the lock off later left already-shared tabs locked (and a tab
  that changed subdomain "vanished"). Now turning the lock off frees tabs shared while it was on,
  turning it on pins every share to the host its tab is on at that moment, and the TTL is counted
  from the later of the share time and the moment the setting changed.
- **Origin drift pauses, it no longer revokes.** A shared tab that leaves its host (lock on) is
  refused with `ORIGIN_DRIFT` and hidden from `list_tabs`, but the share is kept: access resumes when
  the tab is back (or the lock is turned off). With the lock on, `navigate` off the shared host is
  refused up front instead of silently cutting the agent's own access. CDP capture is detached while paused.
- **Every page tool acts on one probed document** — the page itself exactly like a frame — targeted by
  its `documentId`. This replaces the per-tool in-page `location.host` check, which gave false
  `ORIGIN_DRIFT` on every cross-host redirect even with the lock off (`wait_for`, calls racing a
  navigation), and was switched off for host-less pages.
- The "⚡" group: taking a tab out of the group no longer unshares it unless you opt in (new setting,
  off by default — Chrome also reports group changes for window moves and closed groups) and the tab
  stays where you put it; new shared tabs join the window's existing group instead of opening another;
  a tab Chrome itself puts into the group (a link opened from a grouped tab) is not auto-shared;
  overlapping group moves are masked correctly and run one at a time.
- Switching the lock **off** wakes the tabs paused on a related site (a sub-domain of where they were
  shared - the AWS regions case) and releases those you took to an unrelated site (your webmail).
- The share button, hotkey and context menu treat a paused tab as not shared: using them shares it
  again on the site it is on now, instead of ending the dormant grant behind your back.
- With the lock on, `navigate` from a shared blank tab is refused up front like any other navigation
  off the shared origin (it would have paused the tab at once); `open_tab` is the way to a new site.
- `navigate` reports `completed: false` after its 15 s deadline instead of looking successful;
  `get_page_content {maxChars: 0}` is capped at 8,000,000 characters; a reply over 30 MiB is answered
  with `FRAME_TOO_LARGE` instead of timing out; `wait_for` may wait its full 25 s.
- The extension always asks for an ephemeral port (no stale remembered port) and waits long enough
  for the hub to start; a late disconnect of a replaced native port no longer tears down the new connection.
- Python and .NET hosts: they predate the hub, feature gating and `relabel` and only work in direct
  mode, which the current extension no longer uses — documented as such (not ported).

### Fixed
- `type` on a `<select>` wiped the element's options; non-editable elements were overwritten; both now
  behave (option picked by value/text; clear `INVALID_ARGS`). An invalid CSS selector is `INVALID_ARGS`
  instead of a misleading "no result frame" or a `wait_for` timeout.
- `get_console_logs {clear: true}` silently stopped the CDP capture.
- The "Everything" share's auto-expire was erased by unsharing any single tab.
- After a quick Stop → Start of a browser the hub kept a dead client, so `list_tabs` came back empty
  with no error; the hub now reconnects by the entry's fingerprint, names browsers that did not answer
  (`unavailable`), and `Revoke all` reports a browser that failed to clear instead of claiming success.
- A request naming an unknown MCP session now gets HTTP 404 (the spec's cue to re-initialize), not 400.
- A dead hub is brought back by the host (checked every 10 s) instead of staying dead until Stop/Start.
- The `tabduct-ttl` alarm was re-created on every service-worker start; the denied-badge flash shared
  one timer across tabs; a dismissed "being debugged" banner was re-armed on the next refresh.
- `npm test` could register a fake instance in the real `~/.tabduct` (a live hub picked it up); the
  conformance runners now always use an isolated state dir and refuse the live hub port.

### Security
- Origin filter: a `blob:` / `filesystem:` document, or `about:blank` page, of a blocked site no longer
  slips through as "host-less" (a document is judged by its own origin `self.origin` - for an `about:blank`
  popup `location.origin` is `null` -, by its URL's origin and by its URL's host); a sandboxed frame or one
  nested inside a blocked frame is judged by its URL and ancestors; `screenshot` is refused while the page
  shows a visible frame of a blocked site (checked before and after the capture); a redirected request is
  hidden from the network log when *any* hop - or the document that issued it - is on a blocked origin;
  CDP console lines are filtered by the origin of the context that logged them and by their source URL
  (an unidentifiable source is withheld while a filter is active).
- **CDP eval is bound to the judged JavaScript context** (`Runtime.evaluate` with `uniqueContextId`)
  instead of embedding a copy of your block list in the evaluated expression, which the agent's own
  code could read and a hostile page could tamper with. A navigation between check and evaluation
  makes the call fail with `ORIGIN_DRIFT`.
- `navigate` no longer describes a page it ended on after a redirect when the caller may not see it
  (address and title are withheld); the block list's rules are matched in punycode, so a rule typed in
  a non-Latin script (an internationalized domain) really blocks the site; the destination filter is judged only after the call is
  authorized (no probing of the list with `open_tab`/`navigate` when nothing is shared).
- Trusted input: paste shortcuts are refused; a `frameId` without a `selector` must name the frame that
  holds the focus; the browser's frame tree is re-read right before the events go out, and a hidden frame
  of a blocked site stops them; a key sequence stops if the page navigates between presses; an overlay on
  an ancestor document over an iframe is detected for trusted clicks.
- `Revoke all` and `list_tabs` also name a browser that is alive but that the hub could not reach; the
  hub refuses a call that needs a feature the target browser's build lacks (a not yet restarted host)
  and answers 502 when the browser refuses an unshare/stop request.
- An extension update applied together with a browser start can no longer bring last session's shares
  back (the start-up revoke is queued with the restore).
- A grant whose tab sits on a filtered-out site is still listed (paused) in the popup.
- The auto-expire setting now applies to tabs that are already shared (it used to be sealed at share time).

## [1.5.0] — 2026-09-25

### Added
- **Frames.** Page tools can now work inside iframes — including cross-origin ones, such as
  embedded HubSpot/Typeform/sign-up forms, which neither page scripts nor CDP's top-level eval
  could reach, so an agent saw an empty form. `get_page_content`, `get_dom_snapshot`, `click`,
  `type`, `wait_for`, `execute_script` and `get_console_logs` take an optional `frameId`.
- **`list_frames`** — the frames of a shared tab (frameId, url, title, depth, size).
- `get_dom_snapshot` on a page now also outlines every visible frame under a
  `--- frame N ---` header, so the agent finds embedded form fields with no extra call;
  `<iframe>` elements appear in the page's own outline, labelled by their `src`.

No new permission and no debugger: `chrome.scripting` already reaches every frame.

### Changed
- `scripts/gen-key.js` keeps the extension's private key in `keys/extension.pem` (gitignored),
  outside `extension/`. Chrome loads that folder as-is and warned about a key file inside it.
  An existing `extension/key.pem` can simply be moved there; it is not needed at runtime.

### Security
- A frame is reachable only inside an authorized tab, only while the tab's page is still the
  authorized origin, and only if the **frame's own** origin passes the origin filter — a blocked
  site embedded as an iframe stays blocked. Lock-to-domain governs the tab, not its frames.
  The approved frame is then targeted by its `documentId`, so a frame that navigates between
  the check and the action is never acted on (PROTOCOL.md §6a).
- The extension now drops any `_`-prefixed argument arriving from the wire. Those names are
  internal (set from the consent gate: `_authHost`, `_engine`, …) and must never be caller-supplied
  (defense in depth — the gate already overwrote them; no known bypass).

## [1.4.2] — 2026-07-25

### Fixed
- **Start could get permanently stuck on "Couldn't start the shared hub."** If an orphaned or
  half-dead hub was still answering on port 12311 without a matching `hub.json` — e.g. one that
  removed its `hub.json` during idle-shutdown but then hung on a dead MCP client and never
  released the port — the host treated *any* HTTP responder as "hub is up," skipped spawning a
  fresh hub, and then (correctly) refused to hand the agent token to an unverified listener. The
  result was a wedged Start with an empty `hub.log` and no way to recover except waiting for the
  zombie to die on its own. Two fixes:
  - `ensureHub` now only accepts a hub it can **verify is ours** (reachable *and* a live
    `hub.json` on our port), and otherwise brings our own hub up — spawning the moment the port
    is actually free, so a stray occupant clearing heals within a single Start. It also logs the
    stray case instead of leaving `hub.log` silent.
  - The hub's idle-shutdown now has a hard failsafe: it always exits within a short grace even if
    a `close()` hangs, and removes `hub.json` last (only once the listener is down) — so it can
    never linger as a port-holding zombie with a stale `hub.json`.

## [1.4.1] — 2026-07-13

### Fixed
- **Shared-tab favicons could turn into the Tabduct logo.** When Chrome discarded an idle
  tab (Memory Saver), its `favIconUrl` went empty and the popup fell back to the extension's
  own icon — so long-open shared tabs looked like they'd been stamped with the black-fork
  logo. The list now sources icons from Chrome's own favicon cache (the `_favicon` API, same
  icons as the tab strip), which survives tab discard, and only ever falls back to a neutral
  globe — never the extension icon.

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

