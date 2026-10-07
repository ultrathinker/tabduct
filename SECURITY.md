# Security Policy

Tabduct hands an AI agent a pipe into your real, logged-in browser tabs, so its
security posture is the whole point. This document is honest about both the
guarantees and the limits.

## Reporting a vulnerability

Please **do not open a public issue** for security bugs. Email
**universeissilent42@gmail.com** with details and, if possible, a reproduction.
You'll get an acknowledgement as soon as reasonably possible. Coordinated
disclosure is appreciated.

## Supported versions

Pre-1.0: only the latest `main` is supported. Pin a commit if you need stability.

## Design & trust model

- **Local only.** The host binds `127.0.0.1`. There are no outbound calls, no
  server, and no telemetry — nothing ever leaves your machine.
- **Token-authenticated.** Binding localhost is *not* access control (every local
  process shares it). On Start the extension mints a random bearer token; the
  host requires `Authorization: Bearer <token>` on every request, rejects requests
  carrying an `Origin` header, and pins the `Host` header (DNS-rebinding defense).
- **Default-deny consent, enforced in the extension.** The extension is the sole
  path to the browser; hosts are dumb relays that never authorize. Nothing is
  reachable unless you explicitly share it (per-tab or "Everything").
- **Trust boundary = same OS user.** Anything running under your OS account is
  trusted, consistent with a localhost tool.

## Consent controls (in the popup)

- **Origin filter** — *Block* mode (listed sites never shared) or *Allow* mode
  (only listed sites can ever be shared). Overrides every sharing mode, and also
  applies to **frames inside a shared tab**: a blocked site embedded as an iframe
  (say, a payment widget in a shop) stays out of reach even though the page around
  it is shared.
- **Lock shared tabs to their domain** (default on) — a shared tab that navigates
  to another site is paused: calls are refused and the tab is hidden from the agent
  (the share is kept and resumes when the tab returns). It is applied live, to tabs
  that are already shared too. It locks the *tab*: iframes on the shared page
  (embedded forms, often from another domain) stay reachable, subject to the origin filter.
- **Read-only** — the agent may read/screenshot but not click, type, navigate, run
  scripts, or open/close tabs.
- **Auto-expire** — un-shares tabs after a chosen time (live, like the lock).
- **Full access preset** — a convenience over the flags above (lock off, read-only
  off, no expiry, CDP eval on). It never changes the origin list, its mode or the frame rule.
  Switching the lock off (by hand or with this preset) wakes tabs that were paused on a
  *related* site (a sub-domain of where they were shared) and releases the ones you took to an
  unrelated site. **Safe defaults** turns the lock back on and the CDP options off; it leaves
  read-only and the expiry time as you set them.
- **Don't auto-share tabs the agent opens** (default on).

## Known limitations (by design)

- **Prompt injection.** Page content the agent reads is *untrusted input* — a
  hostile page can try to steer the agent (e.g. "open your email and paste the
  code"). The origin filter, read-only mode, and lock-to-domain limit the blast
  radius, but treat a steered agent as a real threat.
- **`execute_script` runs arbitrary JS** in shared tabs (MAIN world). It's the
  keystone capability and also the most powerful — use read-only or Allow mode if
  you don't want it, and see the Chrome Web Store note below.
- **CDP mode & the `debugger` permission.** To bypass a page's CSP for arbitrary
  `execute_script` (and to capture the full console incl. uncaught errors), Tabduct
  can use the Chrome DevTools Protocol. Chrome does **not** allow `debugger` as an
  optional/runtime permission, so it is declared as a **required** permission — the
  install prompt therefore warns that the extension can debug the browser, even
  though CDP is **off by default**. Nothing attaches until you enable *Allow CDP
  eval* in the popup; it is refused under read-only; Chrome shows a "this tab is
  being debugged" banner whenever CDP is actually in use, and a red header chip
  marks the persistent developer-mode variants (*Always use CDP* / *Capture full
  console via CDP*).
- **Hub trust is same-OS-user.** The hub aggregates whatever registers under
  `~/.tabduct`; a process running as you could register a fake "browser" (prompt
  injection vector) — and the token is only withheld from a port squatter because
  the host verifies the hub's `hub.json` pid+port before disclosing it.
- **TOCTOU.** Every page tool probes the document, judges it, and acts on that
  exact document by its `documentId`; a page that self-navigates in between makes the
  action fail instead of landing on another origin. The CDP eval path does the same with
  the browser's own bookkeeping: it asks the browser for the top frame's JavaScript context
  (and the real origin of its document), judges that origin in the extension, and evaluates
  *inside that context* (`uniqueContextId`) - a context dies with its document, so a
  navigation in between makes the call fail (`ORIGIN_DRIFT`). Nothing about your rules is
  sent into the page, and nothing a page can overwrite takes part in the decision. A document
  is judged by its own origin (`self.origin`, which for an `about:blank` popup is the origin it
  inherited - `location.origin` would say `null`), the origin of its URL and the host of its URL.
- **Trusted input** (`type`/`click` with `trusted`, `press_key`) is browser-level: it
  goes to whatever has focus, or to the element under the pointer. Right before the events
  are sent, over the same debugger session, the browser's frame tree is read again: the top
  document must still pass the pin and the origin filter, and *no* frame of the page - visible
  or not - may belong to a filtered-out site; a key sequence re-checks that the page did not
  navigate between presses. What cannot be excluded is a page that moves focus within the few
  milliseconds between that look and the event. With a `frameId` and no selector the named
  frame must hold the keyboard focus. Paste shortcuts (Ctrl/Cmd+V, Shift+Insert) are refused:
  they would read your clipboard (use `type`); Ctrl/Cmd+C and Ctrl/Cmd+X are not refused (a terminal needs Ctrl+C) but copy to your clipboard when something is selected.
  It needs *Allow CDP eval* and is refused in read-only.
- **Screenshots capture pixels.** A screenshot is refused while the page shows a visible
  frame of a filtered-out site; the page is checked before AND after the capture and the
  image is dropped if it changed in between (a frame shown and hidden again entirely inside
  the capture cannot be seen from here). A hidden (0×0) frame is not in the picture.
- **What an agent learns from a redirect.** `navigate` that ends on a page the caller may not
  see (a filtered-out site, or another origin than the lock pins the tab to) answers without
  that page's address and title.
- **Not on the Chrome Web Store.** Manifest V3 forbids runtime arbitrary code, so
  `execute_script` can't ship as-is to the store; the required `debugger` permission
  adds further review friction. Install unpacked / from source.

## What Tabduct never does

No network egress, no analytics, no reading of unshared tabs (not even their
titles), no bundled remote code.
