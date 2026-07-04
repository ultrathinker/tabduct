#!/usr/bin/env node
// Tabduct HUB conformance — no Chrome. Spawns 2 fake instances (real Node hosts
// + a fake extension over stdio) into an ISOLATED TABDUCT_DIR + test hub port,
// spawns the hub, and drives the hub's MCP endpoint. Asserts aggregation,
// composite routing, ambiguity, result rewriting, failover, and auth.

import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, "../..");
const HOST = resolve(REPO, "hosts/node/src/index.js");
const HUB = resolve(REPO, "hosts/node/src/hub.js");
const DIR = mkdtempSync(join(tmpdir(), "tabduct-hub-"));
const HUB_PORT = 12800 + Math.floor((Date.now() % 900));
const ENV = { ...process.env, TABDUCT_DIR: DIR, TABDUCT_HUB_PORT: String(HUB_PORT), TABDUCT_HUB_IDLE_MS: "2500" };
const BIG = "QUpE".repeat(600000); // ~2.4 MB base64 → exercises large-reply traversal through the hub

let fails = 0, done = false;
const procs = [];
const guard = setTimeout(() => { console.error("HUB CONFORMANCE TIMEOUT (40s)"); finish(1); }, 40_000); guard.unref();
const ok = (c, m) => { if (!c) { console.error("  FAIL:", m); fails++; } else console.log("  ok:", m); };
function finish(code) { if (done) return; done = true; clearTimeout(guard); for (const p of procs) { try { p.kill(); } catch {} } process.exit(code); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake instance = real host + a fake extension answering invokes over stdio.
function startInstance(instanceId) {
  const proc = spawn(process.execPath, [HOST], { stdio: ["pipe", "pipe", "inherit"], env: ENV }); procs.push(proc);
  const send = (o) => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length, 0); proc.stdin.write(Buffer.concat([h, b])); };
  let buf = Buffer.alloc(0), need = -1; const pend = new Map();
  proc.stdout.on("data", (c) => { buf = Buffer.concat([buf, c]); for (;;) { if (need === -1) { if (buf.length < 4) return; need = buf.readUInt32LE(0); buf = buf.subarray(4); } if (buf.length < need) return; const m = JSON.parse(buf.subarray(0, need).toString()); buf = buf.subarray(need); need = -1; if (m.replyTo) { const r = pend.get(m.replyTo); if (r) { pend.delete(m.replyTo); r(m); } } else if (m.type === "invoke") answer(m); } });
  const answer = (m) => {
    const t = m.payload.tool, ok = (result) => send({ replyTo: m.id, ok: true, result });
    if (t === "list_tabs") ok({ tabs: [{ id: 1, title: `tab-${instanceId}`, url: "https://example.com", active: true }] });
    else if (t === "get_active_tab") ok({ id: 7, title: `active-${instanceId}`, url: "https://example.com", active: true });
    else if (t === "navigate") ok({ id: 9, title: "nav", url: m.payload.args?.url, active: true });
    else if (t === "screenshot") ok({ mimeType: "image/png", dataUrl: `data:image/png;base64,${BIG}` });
    else send({ replyTo: m.id, ok: false, error: { code: "TAB_NOT_FOUND", message: "no" } });
  };
  const hostReq = (type, payload) => new Promise((res) => { const id = randomUUID(); pend.set(id, res); send({ type, id, payload }); });
  return { proc, instanceId, kill: () => { try { proc.kill(); } catch {} }, open: () => hostReq("open", { port: 0, token: `tok-${instanceId}-${randomUUID()}`, protocolVersion: 0, instanceId, label: `L-${instanceId}` }) };
}

function rpc(body, { sessionId, token } = {}) {
  return new Promise((resolve) => {
    const p = Buffer.from(JSON.stringify(body));
    const headers = { "content-type": "application/json", "accept": "application/json, text/event-stream", "content-length": p.length };
    if (token) headers.authorization = `Bearer ${token}`;
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const req = http.request({ host: "127.0.0.1", port: HUB_PORT, path: "/mcp", method: "POST", headers }, (r) => {
      let d = ""; r.on("data", (x) => (d += x)); r.on("end", () => { let j; if ((r.headers["content-type"] || "").includes("text/event-stream")) { const l = d.split("\n").filter((x) => x.startsWith("data:")).pop(); j = l ? JSON.parse(l.slice(5).trim()) : undefined; } else if (d) { try { j = JSON.parse(d); } catch {} } resolve({ status: r.statusCode, sessionId: r.headers["mcp-session-id"], json: j }); });
    });
    req.on("error", () => resolve({ status: "REFUSED" })); req.end(p);
  });
}
const toolResult = (r) => { try { return JSON.parse(r.json?.result?.content?.[0]?.text); } catch { return null; } };
const call = (name, args, sid, token) => rpc({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method: "tools/call", params: { name, arguments: args } }, { sessionId: sid, token });

(async () => {
  const A = startInstance("A"), B = startInstance("B");
  ok((await A.open()).ok && (await B.open()).ok, "two fake instances up + discovery written");

  const hubProc = spawn(process.execPath, [HUB], { stdio: ["ignore", "ignore", "inherit"], env: ENV }); procs.push(hubProc);
  // wait for hub token file + port
  let tAgent = null;
  for (let i = 0; i < 40 && !tAgent; i++) { await sleep(200); if (existsSync(resolve(DIR, "token"))) { try { tAgent = JSON.parse(readFileSync(resolve(DIR, "token"), "utf8")).tAgent; } catch {} } }
  ok(!!tAgent, "hub created stable token");
  // give the hub time to connect its MCP clients to both instances
  await sleep(1500);

  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }, { token: tAgent });
  ok(init.status === 200 && init.sessionId, "hub MCP initialize + session");
  const sid = init.sessionId;
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { sessionId: sid, token: tAgent });

  ok((await rpc({ jsonrpc: "2.0", id: 8, method: "tools/list" }, { sessionId: sid, token: "wrong" })).status === 401, "hub: wrong token → 401");

  const tools = (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { sessionId: sid, token: tAgent })).json?.result?.tools || [];
  ok(tools.some((t) => t.name === "list_instances"), "derived catalog has list_instances");

  const insts = toolResult(await call("list_instances", {}, sid, tAgent));
  ok(insts?.instances?.length === 2, `list_instances shows 2 (got ${insts?.instances?.length})`);

  const lt = toolResult(await call("list_tabs", {}, sid, tAgent));
  const ids = (lt?.tabs || []).map((t) => t.id).sort();
  ok(JSON.stringify(ids) === JSON.stringify(["A:1", "B:1"]), `list_tabs merged + prefixed (got ${JSON.stringify(ids)})`);

  const amb = await call("get_active_tab", {}, sid, tAgent);
  ok(amb.json?.result?.isError && /AMBIGUOUS_INSTANCE/.test(amb.json.result.content[0].text), "no target + 2 instances → AMBIGUOUS_INSTANCE");

  const ga = toolResult(await call("get_active_tab", { instanceId: "A" }, sid, tAgent));
  ok(ga?.id === "A:7", `instanceId routing + result id composited (got ${ga?.id})`);

  const nav = toolResult(await call("navigate", { tabId: "B:1", url: "https://x.com" }, sid, tAgent));
  ok(nav?.id === "B:9", `composite tabId routing (got ${nav?.id})`);

  const shot = await call("screenshot", { instanceId: "A" }, sid, tAgent);
  const img = shot.json?.result?.content?.[0];
  ok(img?.type === "image" && img?.data?.length === BIG.length, `large screenshot (${(BIG.length / 1e6).toFixed(1)}MB) traverses hub intact`);

  const mal = await call("get_page_content", { tabId: "A:" }, sid, tAgent);
  ok(mal.json?.result?.isError && /INVALID_ARGS/.test(mal.json.result.content[0].text), "malformed composite tabId → INVALID_ARGS");

  // mid-flight failover: kill B, call immediately → INSTANCE_GONE (reconnect fails; not a 20s timeout)
  B.kill();
  await sleep(500);
  const gone = await call("get_active_tab", { instanceId: "B" }, sid, tAgent);
  ok(gone.json?.result?.isError && /INSTANCE_GONE/.test(gone.json.result.content[0].text), "call to a just-killed instance → INSTANCE_GONE");

  await sleep(4000); // let the 3s poll reconcile
  const insts2 = toolResult(await call("list_instances", {}, sid, tAgent));
  ok(insts2?.instances?.length === 1 && insts2.instances[0].instanceId === "A", "after poll → 1 instance");

  // self-exit when the registry empties
  A.kill();
  await sleep(6000);
  ok(!existsSync(resolve(DIR, "hub.json")), "hub self-exits + removes hub.json when empty");

  console.log(fails ? `\nHUB CONFORMANCE FAILED (${fails})` : "\nHUB CONFORMANCE PASSED");
  finish(fails ? 1 : 0);
})().catch((e) => { console.error("HUB ERROR:", e); finish(1); });
