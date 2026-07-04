# Design: per-tab consent (B) + multi-browser access (A)

> Status: **chosen direction**, pending final owner confirmation before coding.
> Synthesized from two independent design reviews (Fable subagent + Kilo glm-5.2)
> that converged strongly; divergences resolved below. Sequencing: **B first.**

## Decisions at a glance
- **Feature B (per-tab consent):** enforce in the extension at the single
  `handleInvoke` chokepoint. Default-DENY. Tiers + origin safety + visual marking.
- **Feature A (multi-browser):** **on-demand hub** process owning one stable
  endpoint; per-instance hosts dial in as backends. Ship **discovery-file
  (auto-port)** as Phase-1 first (kills manual ports cheaply); hub is Phase-2.
- Rejected for A: leader-election among hosts (failover blip: MCP session dies
  with the leader's browser; re-election races) and a login-time daemon (ambient,
  against project ethos). The hub self-exits after ~60s idle → not ambient.

---

## Feature B — per-tab consent (build first; pure extension work)

### Enforcement boundary
A `consentGate(tool, args)` inserted in `extension/background.js` immediately
before the handler runs in `handleInvoke`. This is the **sole** path to
`chrome.tabs`/`chrome.scripting`, and lives in the one shared JS impl → every
host inherits it. Hosts are agent-side of the trust line and never enforce.

### Consent model (default-deny)
Tiers: `none` (default) · `tabs` (explicit allowlist) · `all` (current+future).
"Share all currently-open" is a popup button that snapshots `chrome.tabs.query`
into the `tabs` allowlist (not a separate tier).

Per shared tab: `{ origin (captured at share), mode: stickyOrigin|anyOrigin,
caps: [read|execute], expiresAt }`.

### Origin safety (the "never my email/bank tab" guarantee — two layers)
1. **`stickyOrigin` (default):** the next invoke after a shared tab navigates to
   a different origin → `ORIGIN_DRIFT`, auto-revoke that tab, emit
   `permission_revoked`. (The navigation itself succeeds; access is downgraded.)
   `anyOrigin` is an opt-in per-tab relaxation for navigation-heavy agent work.
2. **Origin denylist** (persisted, `chrome.storage.local`): hard block that
   overrides even `all`. Add `mail.google.com` once → no tier can ever touch it.
Both checked **fresh at invoke time** (TOCTOU-safe), against the tab's *current*
origin.

### Leak prevention
`list_tabs` / `get_active_tab` return **only shared tabs**; titles/URLs of
unshared tabs are never disclosed (a tab title is sensitive data). `open_tab`
under `tabs` tier auto-adds the new tab (stickyOrigin) so "open a tab and work"
doesn't require escalating to `all`; denylist still applies.

### Storage
Per-tab grants + tier → `chrome.storage.session` (tab IDs are meaningless across
a browser restart; grants correctly reset each session, survive SW eviction).
Denylist → `chrome.storage.local` (persists). Gate reads cached, invalidated on write.

### Popup UX
Two decoupled sections: **Connection** (endpoint up/down) vs **Sharing** (what's
exposed) — you can be connected and sharing nothing (safe idle).
- Segmented tier control (`None`/`Pick tabs`/`All open`/`Everything`+confirm).
- Shared-tab list: favicon + title + origin + per-row revoke; clicking a row
  `activate_tab`s it so you physically see which tab.
- **"Share this tab"** one-click (the focused tab) — the #1 flow.
- **"Revoke all"** one-click.
- **Hotkey** (`chrome.commands`) toggles sharing the current tab — fastest path.

### Visual identification of shared tabs
- **Primary: per-tab toolbar badge** `chrome.action.setBadgeText({tabId})` in a
  distinct color — extension's own icon, CSP-immune, survives navigation.
- **Secondary (default-on, toggle): native Tab Group** "⚡ agent" via
  `chrome.tabGroups` — marks tabs in the strip; drag a tab OUT = revoke; dragging
  IN does NOT grant (eject + require popup/hotkey). Needs `tabGroups` permission.
- Per-invoke activity flash stays; turns **red** on a denied invoke.

### Protocol additions (PROTOCOL.md §6 + constants ERR)
New error codes: `NOT_SHARED`, `ORIGIN_DRIFT`, `ORIGIN_DENIED`, `CAP_NOT_GRANTED`.
Wire the existing `event` channel for `permission_revoked` / `tab_removed`. Add a
PROTOCOL section specifying consent *semantics* (filter vs deny per tool) so hosts
& conformance can't drift; conformance asserts unshared tabs never appear in
`list_tabs` and `get_active_tab` on an unshared tab returns `NOT_SHARED` without
leaking the title.

### B v1 vs v2
- **v1:** `none` + `tabs` (share active tab, stickyOrigin), per-tab badge, hotkey,
  `list_tabs` filtering, denylist, revoke-all, new error codes. Works in today's
  single-instance topology.
- **v2:** `all` (non-sticky, re-confirmed each session), per-tab `caps` (read-only
  tier), TTL/expiry, tab-group marking, global status view.

---

## Feature A — multi-browser, no manual ports

### Forced topology
Native messaging is 1:1 (one host process per extension, host reaches only its
own extension). So aggregation MUST live above the hosts. `chrome.tabs.Tab.id`
collides across instances → a namespace is required.

### Phase 1 — discovery file (no hub) — cheap win, ship early
Each host binds an **ephemeral port** (`listen(0)`) instead of a fixed one and
writes `{ instanceId, label, port, token }` to `~/.tabduct/instances.json` (0600).
Popup shows the per-instance URL+token; the user never types a port. Agents that
accept a *list* of MCP servers (Claude Code, Kilo, OpenCode) consume it.
Limitation: N endpoints, no cross-instance calls, new browsers opened after the
agent starts aren't picked up mid-session.

### Phase 2 — on-demand hub — one stable endpoint
- **Hub:** a capability-free mode of the same binary (`tabduct hub`, auto-spawned
  `detached` by the first host; **self-exits after ~60s with zero backends** →
  not ambient). Runs the MCP server (north) + a backend listener. Pure
  router/aggregator; touches no browser.
- **Backends:** per-instance hosts bind **no TCP port**; they dial the hub over a
  **named pipe (Windows) / AF_UNIX socket (POSIX)** under the user profile
  (dir 0700) and register `{ instanceId, label, protocolVersion, capabilities }`.
- **Endpoint & token (stable):** hub binds `127.0.0.1:12310/mcp`; long-lived
  `T_agent` in a 0600 key file (minted at `register`/first run); every popup shows
  the identical URL+token. `T_backend` (same file) authenticates backends on the
  socket. `tabduct rekey` rotates. **Agent config written once, never changes.**
- **Tab handles:** opaque `"<instanceId>:<tabId>"` strings; single-instance
  degenerates to a bare int (back-compat). New tools `list_instances`,
  `set_instance_label`. Ambiguity → `AMBIGUOUS_INSTANCE` (never guess the instance).
  Bump `protocolVersion` (breaking `tabId` → tabRef change; version is 0/unstable).
- **Failover (free):** no instance owns the endpoint. A browser closes → its
  backend drops, its tabs vanish from `list_tabs`, calls to them → `INSTANCE_GONE`;
  other instances and the agent's MCP connection are untouched. Hub crash (rare,
  tiny) → next host respawns it in ~1s; same URL/token → client reconnects.
- Hub must **stream** large replies (screenshots/HTML), not buffer; parallelize
  `list_tabs` fan-out with per-backend timeouts.

### New error codes for A
`AMBIGUOUS_INSTANCE`, `INSTANCE_GONE`.

---

## How A + B compose
Orthogonal layers: **A multiplexes** (hub routes by composite id, knows nothing
about consent); **B authorizes at the edge** (each extension enforces consent for
its own tabs). Agent sees the **union of per-instance consented tabs**. Plugging
a fresh browser into the shared endpoint exposes **zero** tabs until its popup
grants — multi-instance becomes a safety feature, not a risk. Blast radius of a
leaked token shrinks from "all tabs" to "currently shared tabs" (granular,
origin-aware, expiring) — A's stable token is offset by B's granular consent.

## Sequencing
1. **B v1** (extension-only, today's topology) — highest value, lowest risk.
2. **A Phase 1** (auto-port + discovery file) — kills manual ports.
3. **A Phase 2** (hub) — when single-endpoint / cross-instance demand is real.
4. **B v2** — `all` tier, caps/read-only, TTL, tab-group, status.
