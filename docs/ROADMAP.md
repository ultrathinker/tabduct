# Roadmap

Sequenced work. **MVP** = the smallest thing that works end-to-end with one
agent on one browser. Everything under "Post-MVP" is committed, not optional —
it's deferred only so the MVP can prove the core loop first.

## MVP (make the core loop real)

- [x] Wire `@modelcontextprotocol/sdk` into `hosts/node/src/mcp-server.js` via the
      low-level `Server` (explicit `tools/list` / `tools/call`) so catalog JSON
      Schema is served verbatim (no Zod hand-translation).
- [x] `register` templates an absolute node path into `run_host.*`; implement
      `doctor` (stat manifest, resolve launcher, probe `node --version`).
- [~] Generate real icon PNGs (done: placeholders) and run `gen-key.js`.
- [x] End-to-end smoke: Claude Code `--mcp-config` → the hub endpoint
      `127.0.0.1:12311/mcp` (originally the direct port 12310) with bearer token; drive `list_tabs` + `execute_script` + `screenshot`.

## Headline features — chosen design in [DESIGN-consent-and-multibrowser.md](DESIGN-consent-and-multibrowser.md)

Two principal capabilities, designed (synthesis of two independent reviews),
**sequenced B-first**:

- [x] **B — per-tab consent** (default-deny; tiers none/tabs/all; origin
      stickiness + denylist; per-tab badge + tab-group; hotkey; revoke-all;
      enforced at the extension `handleInvoke` chokepoint). *v1 = extension-only,
      works in today's topology → build first.*
- [x] **A — multi-browser, no manual ports.** Phase 1: auto-port + discovery
      file (kills manual ports). Phase 2: on-demand **hub** (one stable
      endpoint+token, backends dial in, failover-free, self-exits when idle) +
      composite tab handles `instanceId:tabId` + `list_instances`.
      *(Note: the hub is currently Node-host only — see [`README.md`](../README.md).)*

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
- [x] **Frames** — `frameId` on the page tools + `list_frames`; `get_dom_snapshot` outlines
      visible frames. Consent: frame origin through the origin filter, documentId pinning.
      Still open: **CDP inside child frames** (`Target.setAutoAttach` + per-frame sessions),
      for `execute_script` in a frame whose own CSP blocks eval, and console/network capture
      of cross-origin frames.
- [~] **Capability handshake** — done as a version/feature handshake: `open` carries
      `extensionVersion` and `features`, and a call that needs a feature the loaded
      extension lacks (frames, trusted input) is refused with `EXTENSION_OUTDATED`
      instead of being run somewhere else. Still open: advertising only the tools the
      extension implements (the tool list itself is static).
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
- [ ] **`messages.schema.json` (wire it in)** — the file exists as a reference list
      of wire message names, but is **not yet imported/enforced** by `protocol/`,
      conformance, or the extension, so vocabulary drift (the bug the reviewers
      caught) is not yet mechanically prevented. Import + assert against it to close this.
- [x] **Conformance harness** — `protocol/conformance/run.mjs` (host-language-
      neutral; `-- <cmd>` runs any host) + `run-hub.mjs`. `npm test` runs the consent, store,
      handler, wake, gate and host tests plus host and hub conformance in CI (GitHub
      Actions, Linux/macOS/Windows; Python and .NET host jobs). `npm run test:e2e` and
      `npm run test:e2e-wake` are opt-in runs in a real Chrome. Shared vectors still TODO.
- [x] **Prompt-injection UX / consent tiers** — shipped: a global **read-only** mode
      (no click/type/nav/eval), the **origin filter** (block/allow), **lock-to-domain**
      with sticky-revoke, **don't-auto-share**, auto-expire, and a denied-invoke
      toolbar flash. (A flash on *every* invoke, not just denied, remains optional.)

## Later / maybe

- [~] Python host (`hosts/python`) — official `mcp` SDK, per-OS `register`; direct mode only: it
      predates the hub, the version/feature handshake and `relabel`, so the current extension
      cannot use it. Needs the hub-era contract ported.
- [~] .NET host (`hosts/dotnet`) — `ModelContextProtocol` SDK, per-OS `register`; same limitation.
- [ ] Firefox support (MV3 differences: `background.scripts`, `browser.*`,
      `allowed_extensions` NM manifest) — currently Chromium-only; scope the docs
      accordingly until then.
