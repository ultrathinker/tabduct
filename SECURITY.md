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
  process shares it). On Connect the extension mints a random bearer token; the
  host requires `Authorization: Bearer <token>` on every request, rejects requests
  carrying an `Origin` header, and pins the `Host` header (DNS-rebinding defense).
- **Default-deny consent, enforced in the extension.** The extension is the sole
  path to the browser; hosts are dumb relays that never authorize. Nothing is
  reachable unless you explicitly share it (per-tab or "Everything").
- **Trust boundary = same OS user.** Anything running under your OS account is
  trusted, consistent with a localhost tool.

## Consent controls (in the popup)

- **Origin filter** — *Block* mode (listed sites never shared) or *Allow* mode
  (only listed sites can ever be shared). Overrides every sharing mode.
- **Lock shared tabs to their domain** (default on) — a shared tab that navigates
  away loses access.
- **Read-only** — the agent may read/screenshot but not click, type, navigate, run
  scripts, or open/close tabs.
- **Auto-expire** — un-shares everything after a chosen time.
- **Don't auto-share tabs the agent opens** (default on).

## Known limitations (by design)

- **Prompt injection.** Page content the agent reads is *untrusted input* — a
  hostile page can try to steer the agent (e.g. "open your email and paste the
  code"). The origin filter, read-only mode, and lock-to-domain limit the blast
  radius, but treat a steered agent as a real threat.
- **`execute_script` runs arbitrary JS** in shared tabs (MAIN world). It's the
  keystone capability and also the most powerful — use read-only or Allow mode if
  you don't want it, and see the Chrome Web Store note below.
- **Hub trust is same-OS-user.** The hub aggregates whatever registers under
  `~/.tabduct`; a process running as you could register a fake "browser" (prompt
  injection vector) — and the token is only withheld from a port squatter because
  the host verifies the hub's `hub.json` pid+port before disclosing it.
- **TOCTOU window.** A shared page that self-navigates in the sub-second between
  authorization and script execution is caught by an in-page origin re-check; for
  free-navigation (`anyOrigin`) grants this can rarely fail safe as `ORIGIN_DRIFT`.
- **Not on the Chrome Web Store.** Manifest V3 forbids runtime arbitrary code, so
  `execute_script` can't ship as-is to the store — install unpacked / from source.

## What Tabduct never does

No network egress, no analytics, no reading of unshared tabs (not even their
titles), no bundled remote code.
