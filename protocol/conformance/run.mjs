#!/usr/bin/env node
// Tabduct conformance runner — validates ANY host implementation against the
// wire protocol WITHOUT a browser. It plays the "extension" over stdio and
// drives the MCP HTTP endpoint. Language-neutral: pass the host launch command
// after `--`, e.g.
//   node run.mjs -- node ../../hosts/node/src/index.js
//   node run.mjs -- python ../../hosts/python/tabduct_host/__main__.py
// With no command it defaults to the Node reference host.

import { spawn } from "node:child_process";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, "../..");
const CATALOG = JSON.parse(readFileSync(resolve(REPO, "protocol/tools.schema.json"), "utf8"));

export async function runConformance(hostCmd) {
  const cmd = hostCmd && hostCmd.length ? hostCmd : [process.execPath, resolve(REPO, "hosts/node/src/index.js")];
  const INSTANCE = "conf-" + randomUUID();
  const TOKEN = "conf-" + randomUUID();
  let PORT = 0, fails = 0, done = false;

  const ok = (c, m) => { if (!c) { console.error("  FAIL:", m); fails++; } else console.log("  ok:", m); };
  const host = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
  const guard = setTimeout(() => { console.error("CONFORMANCE TIMEOUT (30s)"); finish(1); }, 30_000); guard.unref();
  function finish(code) { if (done) return; done = true; clearTimeout(guard); try { host.kill(); } catch {} }

  // stdio framing (fake extension)
  const sendToHost = (o) => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length, 0); host.stdin.write(Buffer.concat([h, b])); };
  let buf = Buffer.alloc(0), need = -1, invokeSeen = null; const pend = new Map();
  host.stdout.on("data", (c) => { buf = Buffer.concat([buf, c]); for (;;) { if (need === -1) { if (buf.length < 4) return; need = buf.readUInt32LE(0); buf = buf.subarray(4); } if (buf.length < need) return; const m = JSON.parse(buf.subarray(0, need).toString()); buf = buf.subarray(need); need = -1; if (m.replyTo) { const r = pend.get(m.replyTo); if (r) { pend.delete(m.replyTo); r(m); } } else if (m.type === "invoke") { invokeSeen = m; const t = m.payload.tool; if (t === "list_tabs") sendToHost({ replyTo: m.id, ok: true, result: { tabs: [{ id: 1, title: "Fake", url: "https://example.com", active: true }] } }); else if (t === "screenshot") sendToHost({ replyTo: m.id, ok: true, result: { mimeType: "image/png", dataUrl: "data:image/png;base64,QUJD" } }); else sendToHost({ replyTo: m.id, ok: false, error: { code: "TAB_NOT_FOUND", message: "no" } }); } } });
  const hostReq = (type, payload) => new Promise((res) => { const id = randomUUID(); pend.set(id, res); sendToHost({ type, id, payload }); });

  const rpc = (body, { sessionId, token = TOKEN, origin, hostHeader } = {}) => new Promise((resolve) => {
    const p = Buffer.from(JSON.stringify(body));
    const headers = { "content-type": "application/json", "accept": "application/json, text/event-stream", "content-length": p.length };
    if (token) headers.authorization = `Bearer ${token}`;
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (origin) headers.origin = origin;
    if (hostHeader) headers.host = hostHeader;
    const req = http.request({ host: "127.0.0.1", port: PORT, path: "/mcp", method: "POST", headers, setHost: !hostHeader }, (r) => {
      let d = ""; r.on("data", (x) => (d += x)); r.on("end", () => { let j; if ((r.headers["content-type"] || "").includes("text/event-stream")) { const l = d.split("\n").filter((x) => x.startsWith("data:")).pop(); j = l ? JSON.parse(l.slice(5).trim()) : undefined; } else if (d) { try { j = JSON.parse(d); } catch {} } resolve({ status: r.statusCode, sessionId: r.headers["mcp-session-id"], json: j }); });
    });
    req.on("error", () => resolve({ status: "REFUSED" })); req.end(p);
  });

  try {
    const opened = await hostReq("open", { port: 0, token: TOKEN, protocolVersion: CATALOG.protocolVersion, instanceId: INSTANCE, label: "Conf" });
    ok(opened.ok === true && opened.result?.port > 0, "open handshake + ephemeral port bound");
    PORT = opened.result.port;
    const discFile = resolve(homedir(), ".tabduct", "instances", `${INSTANCE}.json`);
    ok(existsSync(discFile), "discovery entry written (§9a)");
    ok((await hostReq("open", { port: 0, token: TOKEN, protocolVersion: CATALOG.protocolVersion })).ok === false, "second open rejected (already running)");
    ok((await hostReq("open", { port: 0, token: "x".repeat(20), protocolVersion: 999 })).ok === false, "version mismatch rejected");

    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "conf", version: "0" } } });
    ok(init.status === 200 && init.sessionId, "MCP initialize + session");
    const sid = init.sessionId;
    await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { sessionId: sid });

    ok((await rpc({ jsonrpc: "2.0", id: 9, method: "tools/list" }, { sessionId: sid, token: "wrong" })).status === 401, "wrong token → 401");
    ok((await rpc({ jsonrpc: "2.0", id: 9, method: "tools/list" }, { sessionId: sid, origin: "http://evil.example" })).status === 403, "Origin → 403");
    ok((await rpc({ jsonrpc: "2.0", id: 9, method: "tools/list" }, { sessionId: sid, hostHeader: `evil:${PORT}` })).status === 403, "bad Host → 403");

    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { sessionId: sid });
    const names = (list.json?.result?.tools || []).map((t) => t.name).sort();
    ok(JSON.stringify(names) === JSON.stringify(CATALOG.tools.map((t) => t.name).sort()), `tools/list == catalog (${names.length})`);

    const call = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_tabs", arguments: {} } }, { sessionId: sid });
    ok(invokeSeen?.payload?.tool === "list_tabs" && (call.json?.result?.content?.[0]?.text || "").includes("Fake"), "tools/call round-trip via invoke");
    const shot = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "screenshot", arguments: {} } }, { sessionId: sid });
    ok(shot.json?.result?.content?.[0]?.type === "image", "screenshot → MCP image");
    const err = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "navigate", arguments: { url: "https://x" } } }, { sessionId: sid });
    ok(err.json?.result?.isError === true, "extension error → MCP isError");

    ok((await hostReq("close", {})).ok === true, "close acknowledged");
    ok(!existsSync(discFile), "discovery entry removed on close");
    await new Promise((r) => setTimeout(r, 150));
    ok((await rpc({ jsonrpc: "2.0", id: 6, method: "tools/list" }, { sessionId: sid })).status === "REFUSED", "port closed after close");
  } catch (e) { console.error("  ERROR:", e.message); fails++; }

  finish(fails ? 1 : 0);
  console.log(fails ? `\nCONFORMANCE FAILED (${fails})` : "\nCONFORMANCE PASSED");
  return fails ? 1 : 0;
}

// CLI: args after `--` are the host launch command.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--");
  const hostCmd = i >= 0 ? process.argv.slice(i + 1) : null;
  runConformance(hostCmd).then((code) => process.exit(code));
}
