# Roadmap

Sequenced work. **MVP** = the smallest thing that works end-to-end with one
agent on one browser. Everything under "Post-MVP" is committed, not optional —
it's deferred only so the MVP can prove the core loop first.

## MVP (make the core loop real)

- [ ] Wire `@modelcontextprotocol/sdk` into `hosts/node/src/mcp-server.js` via the
      low-level `Server` (explicit `tools/list` / `tools/call`) so catalog JSON
      Schema is served verbatim (no Zod hand-translation).
- [ ] `register` templates an absolute node path into `run_host.*`; implement
      `doctor` (stat manifest, resolve launcher, probe `node --version`).
- [ ] Generate real icon PNGs (done: placeholders) and run `gen-key.js`.
- [ ] End-to-end smoke: Claude Code `--mcp-config` → `127.0.0.1:12310/mcp` with
      bearer token; drive `list_tabs` + `execute_script` + `screenshot`.

## Headline features — chosen design in [DESIGN-consent-and-multibrowser.md](DESIGN-consent-and-multibrowser.md)

Two principal capabilities, designed (synthesis of two independent reviews),
**sequenced B-first**:

- [ ] **B — per-tab consent** (default-deny; tiers none/tabs/all; origin
      stickiness + denylist; per-tab badge + tab-group; hotkey; revoke-all;
      enforced at the extension `handleInvoke` chokepoint). *v1 = extension-only,
      works in today's topology → build first.*
- [ ] **A — multi-browser, no manual ports.** Phase 1: auto-port + discovery
      file (kills manual ports). Phase 2: on-demand **hub** (one stable
      endpoint+token, backends dial in, failover-free, self-exits when idle) +
      composite tab handles `instanceId:tabId` + `list_instances`.

## Post-MVP — committed (from the Fable + Kilo reviews)

These were deliberately deferred from the first pass; implement once the MVP
loop is proven.

- [ ] **`chrome.userScripts` for `execute_script`** — the only CSP-proof eval on
      strict sites. Requires `minimum_chrome_version` 116 → 135, the
      `userScripts` permission, and surfacing the "Allow user scripts" toggle in
      the popup + `doctor`. This is the keystone tool's real fix. (ARCHITECTURE.md
      "execute_script & page CSP".)
- [ ] **Capability handshake** — on `open`, exchange
      `{ protocolVersion, capabilities: [tool names] }`; the host advertises only
      tools the extension actually implements instead of failing late with
      `UNKNOWN_TOOL`.
- [ ] **Pagination / cursor for large reads** — `get_page_content` currently
      truncates client-side with no "next chunk"; add a cursor so an agent can
      fetch the rest.
- [ ] **ext→host `event` channel usage** — extension proactively notifies the
      host of `tab_removed`, `permission_revoked`, focus changes (envelope
      already defined in PROTOCOL.md §5; wire real emitters + host handling).
- [ ] **`register --browser`** — Chromium/Edge/Brave dirs & registry keys, plus
      `unregister` (base Chrome + Windows/mac/Linux paths land in the MVP fixes).
- [ ] **Screenshot/large-reply sizing policy** — default screenshots to jpeg+
      quality or downscale so replies stay well within limits; document the
      overflow failure mode.
- [ ] **`messages.schema.json`** — a shared enum of wire message names imported by
      `protocol/`, conformance, and the extension so vocabulary drift (the bug the
      reviewers caught) cannot recur.
- [x] **Conformance harness** — `protocol/conformance/run.mjs` (host-language-
      neutral; `-- <cmd>` runs any host) + `messages.schema.json` (shared wire-name
      enum) + `run-hub.mjs`. `npm test` runs consent + host + hub conformance in
      CI (GitHub Actions, Linux/macOS/Windows). Shared vectors still TODO.
- [ ] **Prompt-injection UX** — flash the toolbar icon on every `invoke`; optional
      per-tool allow/deny tiers (a "read-only / no-eval" mode using
      `list_tabs`/`get_page_content`/screenshots only).

## Later / maybe

- [ ] Python host (`hosts/python`) against the conformance suite.
- [ ] .NET host (`hosts/dotnet`) against the conformance suite.
- [ ] Firefox support (MV3 differences: `background.scripts`, `browser.*`,
      `allowed_extensions` NM manifest) — currently Chromium-only; scope the docs
      accordingly until then.
