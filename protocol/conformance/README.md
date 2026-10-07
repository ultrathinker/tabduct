# Conformance

Language-neutral checks every Tabduct host must pass. The goal: prove a host
speaks the wire protocol (PROTOCOL.md) correctly *without* needing a real
browser. **This doc must stay word-for-word consistent with PROTOCOL.md's
message vocabulary** (`open`/`close`/`ping`/`invoke`, request→reply with
`id`/`replyTo`). Drift here is a first-order defect for a contracts-first repo.

## Approach

A **fake extension** harness drives the host over stdio (§1 framing) and asserts.
**Automated today** (`run.mjs`, in CI via `npm test`):

1. **Handshake / lifecycle** — `open { port, token, protocolVersion }` → reply
   `{ ok:true, result:{ port, protocolVersion } }` with an ephemeral port bound on
   `127.0.0.1`; the discovery entry is written (in an isolated state dir) and removed on
   `close`; a second `open` is rejected; a wrong `protocolVersion` → `VERSION_MISMATCH`;
   after `close` the port is closed.
2. **Auth** — wrong token → 401; a request carrying an `Origin` → 403; a bad `Host` → 403.
3. **Tool round-trip** — `tools/list` equals `../tools.schema.json`; `tools/call list_tabs`
   makes the host emit an `invoke`, the fake extension's reply comes back as the MCP result;
   a `screenshot` becomes an MCP image; an extension error becomes an MCP `isError`.
4. **Schema bounds** — numeric bounds from the catalog are enforced by the host
   (`screenshot{quality:1000}` → `INVALID_ARGS`).
5. **Feature gating** — against an extension that opened without `features`, a call using
   `frameId` (≠ 0) or `list_frames` is answered `EXTENSION_OUTDATED` and **not forwarded**;
   `frameId: 0` is forwarded.
6. **Sessions** — an unknown `Mcp-Session-Id` → HTTP 404.

**Not automated yet** (specified in PROTOCOL.md; a host must still implement them):
`ping`, a malformed length header being fatal (exit non-zero), a busy port failing `open`,
the invoke `TIMEOUT` window, the 1 MB outbound cap (`FRAME_TOO_LARGE`), shutdown on stdin
EOF, and the `peers*` / `relabel` requests. `scripts/test-host.mjs` covers the Node host's
`relabel`, version notice, feature recording and hub watchdog.

`run-hub.mjs` covers the hub: aggregation, composite ids, ambiguity, result rewriting,
failover, a restarted instance under the same id, partial `list_tabs` (`unavailable`),
honest `revokeAll`, the 404 on unknown sessions, a 2.4 MB reply through the hub, and
self-exit.

Both runners always use an isolated state dir (`TABDUCT_DIR`, else a fresh temp dir) and
refuse to touch the real `~/.tabduct` or the live hub port.

## Layout

```
conformance/
├── run.mjs           # host conformance runner (spawns a host binary, drives stdio+HTTP)
├── run-hub.mjs       # hub conformance runner
├── vectors/          # canonical framed-message fixtures (bytes in/out) — future
└── README.md
```

`run.mjs` takes a host launch command as argv. It is written against the Node host; the
Python and .NET hosts predate the hub, feature gating and `relabel` (they work only in
direct mode, which the current extension no longer uses — see their READMEs), so checks 4–6
are skipped for them (the runner prints `skip` unless the host command is `node`):

```bash
node run.mjs -- node ../../hosts/node/src/index.js
node run.mjs -- python ../../hosts/python/tabduct_host/__main__.py
# .NET: build first and run the built dll (never `dotnet run` — it prints build
# output onto stdout and corrupts the native-messaging frame stream)
dotnet build ../../hosts/dotnet && node run.mjs -- dotnet ../../hosts/dotnet/bin/Debug/net10.0/Tabduct.Host.dll
```

`run.mjs` (host conformance) and `run-hub.mjs` (hub conformance) are implemented
and run in CI via `npm test`. Shared vectors are a future addition.
