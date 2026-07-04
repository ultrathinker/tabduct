# Conformance

Language-neutral checks every Tabduct host must pass. The goal: prove a host
speaks the wire protocol (PROTOCOL.md) correctly *without* needing a real
browser. **This doc must stay word-for-word consistent with PROTOCOL.md's
message vocabulary** (`open`/`close`/`ping`/`invoke`, request→reply with
`id`/`replyTo`). Drift here is a first-order defect for a contracts-first repo.

## Approach

A **fake extension** harness drives the host over stdio (§1 framing) and asserts:

1. **Framing** — send `ping` (request with `id`), expect a length-prefixed reply
   with matching `replyTo` and `result.pong === true`. Then send a malformed
   length header → assert the host logs and **exits non-zero** (a length-prefixed
   stream is not resyncable; clean death is the contract, not fake recovery).
2. **Handshake / lifecycle** — `open { port, token, protocolVersion }` →
   reply `{ ok:true, result:{ port, protocolVersion } }`, host bound on
   `127.0.0.1:port`. Wrong `protocolVersion` → `{ ok:false, error.code:"VERSION_MISMATCH" }`.
   Second `open` while running → error, no crash. Busy port → `open` reply
   `{ ok:false, error }`, not a hang. `close` → `{ ok:true }`, port freed.
3. **Auth** — MCP request without `Authorization: Bearer <token>` → 401; with a
   bad token → 401; with the right token → 200. A request carrying an `Origin`
   header → rejected. A request whose `Host` header ≠ `127.0.0.1:<port>` → rejected.
4. **Tool round-trip** — with the server up (and token), `tools/list` matches
   `../tools.schema.json`; `tools/call list_tabs` → host emits an `invoke` on
   stdio → fake extension replies `{ replyTo, ok:true, result }` → host returns
   it as the MCP result.
5. **Timeout** — host `invoke`s, fake extension stays silent → host returns an
   MCP error (`TIMEOUT`) within the configured window.
6. **Outbound cap** — an `invoke` whose serialized frame would exceed 1 MB →
   host fails the call with `FRAME_TOO_LARGE` instead of writing to stdout.
7. **Shutdown** — close the host's stdin → host stops the server and exits 0.

## Layout (planned)

```
conformance/
├── vectors/          # canonical framed-message fixtures (bytes in/out)
├── run.mjs           # reference runner (spawns a host binary, drives stdio+HTTP)
└── README.md
```

`run.mjs` takes a host launch command as argv, so the same suite validates the
Node, Python, and .NET hosts identically:

```bash
node run.mjs -- node ../../hosts/node/src/index.js
node run.mjs -- python ../../hosts/python/tabduct_host/__main__.py
node run.mjs -- dotnet run --project ../../hosts/dotnet
```

`run.mjs` (host conformance) and `run-hub.mjs` (hub conformance) are implemented
and run in CI via `npm test`. Shared vectors are a future addition.
