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

- [~] **CSP on strict sites** — largely addressed: CSP-safe injected-function tools
      (`click`/`type`/`wait_for`/`get_dom_snapshot`/read/console) work everywhere, and
      an opt-in **CDP mode** (`debugger`) bypasses CSP for arbitrary `execute_script`
      + full console capture. Still open: **`chrome.userScripts`** as the banner-free
      eval (requires `minimum_chrome_version` 116 → 135, the `userScripts` permission,
      an "Allow user scripts" toggle; `engine:auto` should then prefer it over CDP).
      (ARCHITECTURE.md "execute_script & page CSP".)
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
- [x] **`register --browser`** — Chromium/Edge/Brave dirs & registry keys + `unregister`,
      across Windows/macOS/Linux. Done.
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
- [x] **Prompt-injection UX / consent tiers** — shipped: a global **read-only** mode
      (no click/type/nav/eval), the **origin filter** (block/allow), **lock-to-domain**
      with sticky-revoke, **don't-auto-share**, auto-expire, and a denied-invoke
      toolbar flash. (A flash on *every* invoke, not just denied, remains optional.)

## Later / maybe

- [ ] Python host (`hosts/python`) against the conformance suite.
- [ ] .NET host (`hosts/dotnet`) against the conformance suite.
- [ ] Firefox support (MV3 differences: `background.scripts`, `browser.*`,
      `allowed_extensions` NM manifest) — currently Chromium-only; scope the docs
      accordingly until then.
