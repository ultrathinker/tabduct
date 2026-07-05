# Contributing to Tabduct

Thanks for your interest! Tabduct is small and contract-driven — the goal is that
every line stays auditable.

## Dev setup

Requires **Node ≥ 18** and Chrome/Chromium/Edge/Brave.

```bash
git clone https://github.com/ultrathinker/tabduct.git && cd tabduct
npm install
npm run register            # install the native-messaging manifest for your OS/browser
# chrome://extensions → Developer mode → Load unpacked → ./extension
# click the Tabduct icon → Start
```

Diagnose the host with `npm run doctor`.

## Tests

```bash
npm test        # consent unit tests + host conformance + hub conformance (pure JS, no browser)
```

All three suites must stay green. If you change consent logic, add a case to
`scripts/test-consent.mjs`; if you change the wire protocol, update
`protocol/PROTOCOL.md` and `protocol/conformance/`.

## Architecture in one breath

Two contracts, one extension, many hosts:

- **North (agent ↔ host):** MCP over HTTP — standard, nothing custom.
- **South (host ↔ extension):** the Tabduct wire protocol, specified in
  [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md).
- **The extension** (`extension/`) is the fixed point and the security boundary
  (`extension/consent.js`). Every host is a thin relay.

A **new host language** needs no permission from anyone — implement
`protocol/PROTOCOL.md` and pass `protocol/conformance/`.

## Code style

- 2-space indent, LF endings, UTF-8 (`.editorconfig` / `.gitattributes` enforce it).
- Match the surrounding style: dense, commented at the **why** level, not the what.
- No new runtime dependencies in the reference host without a strong reason (it's
  intentionally zero-native-deps).
- Security-sensitive changes (anything in `consent.js`, the gate, or the hub) must
  keep `evaluate()`/`visibleTabIds()` pure and unit-tested.

## Pull requests

1. Branch from `main`.
2. Keep the change focused; update docs/tests alongside code.
3. Run `npm test` and syntax-check touched JS (`node --check <file>`).
4. Describe the change and, for behavior changes, why it's safe.

## Reporting security issues

Do **not** file a public issue — see [`SECURITY.md`](SECURITY.md).
