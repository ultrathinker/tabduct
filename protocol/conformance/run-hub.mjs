#!/usr/bin/env node
// Tabduct HUB conformance — no Chrome. Spawns 2 fake instances (real Node hosts
// + a fake extension over stdio) into an ISOLATED TABDUCT_DIR + test hub port,
// spawns the hub, and drives the hub's MCP endpoint. Asserts aggregation,
// composite routing, ambiguity, result rewriting, failover, and auth.

import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, "../..");
const HOST = resolve(REPO, "hosts/node/src/index.js");
const HUB = resolve(REPO, "hosts/node/src/hub.js");
// Isolated by construction: the caller's TABDUCT_DIR / TABDUCT_HUB_PORT win (so a test run can be
// pinned to a scratch folder and a reserved port); otherwise a fresh temp dir and a random test port.
const DIR = process.env.TABDUCT_DIR || mkdtempSync(join(tmpdir(), "tabduct-hub-"));
const HUB_PORT = Number(process.env.TABDUCT_HUB_PORT) || 12800 + Math.floor((Date.now() % 900));
if (HUB_PORT === 12311 || resolve(DIR) === resolve(homedir(), ".tabduct")) { console.error("REFUSING to run hub conformance against the live hub (port 12311 / ~/.tabduct)"); process.exit(1); }
const ENV = { ...process.env, TABDUCT_DIR: DIR, TABDUCT_HUB_PORT: String(HUB_PORT), TABDUCT_HUB_IDLE_MS: "2500" };
const BIG = "QUpE".repeat(600000); // ~2.4 MB base64 → exercises large-reply traversal through the hub

let fails = 0, done = false;
const procs = [];
const guard = setTimeout(() => { console.error("HUB CONFORMANCE TIMEOUT (75s)"); finish(1); }, 75_000); guard.unref();
const ok = (c, m) => { if (!c) { console.error("  FAIL:", m); fails++; } else console.log("  ok:", m); };
function finish(code) { if (done) return; done = true; clearTimeout(guard); for (const p of procs) { try { p.kill(); } catch {} } process.exit(code); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake instance = real host + a fake extension answering invokes over stdio.
function startInstance(instanceId, gen = "", extra = {}) {
  const invokes = [];
  const proc = spawn(process.execPath, [HOST], { stdio: ["pipe", "pipe", "inherit"], env: ENV }); procs.push(proc);
  const send = (o) => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length, 0); proc.stdin.write(Buffer.concat([h, b])); };
  let buf = Buffer.alloc(0), need = -1; const pend = new Map();
  proc.stdout.on("data", (c) => { buf = Buffer.concat([buf, c]); for (;;) { if (need === -1) { if (buf.length < 4) return; need = buf.readUInt32LE(0); buf = buf.subarray(4); } if (buf.length < need) return; const m = JSON.parse(buf.subarray(0, need).toString()); buf = buf.subarray(need); need = -1; if (m.replyTo) { const r = pend.get(m.replyTo); if (r) { pend.delete(m.replyTo); r(m); } } else if (m.type === "invoke") answer(m); } });
  const answer = (m) => {
    const t = m.payload.tool, ok = (result) => send({ replyTo: m.id, ok: true, result });
    invokes.push(t);
    if (t === "list_tabs") ok({ tabs: [{ id: 1, title: `tab-${instanceId}${gen}`, url: "https://example.com", active: true }] });
    else if (t === "_td/revoke_all") { if (instanceId === "B") send({ replyTo: m.id, ok: false, error: { code: "INTERNAL", message: "boom" } }); else ok({ ok: true }); }
    else if (t === "_td/set_tier") ok({ ok: true });
    else if (t === "get_active_tab") ok({ id: 7, title: `active-${instanceId}`, url: "https://example.com", active: true });
    else if (t === "navigate") ok({ id: 9, title: "nav", url: m.payload.args?.url, active: true });
    else if (t === "screenshot") ok({ mimeType: "image/png", dataUrl: `data:image/png;base64,${BIG}` });
    else send({ replyTo: m.id, ok: false, error: { code: "TAB_NOT_FOUND", message: "no" } });
  };
  const hostReq = (type, payload) => new Promise((res) => { const id = randomUUID(); pend.set(id, res); send({ type, id, payload }); });
  return { proc, instanceId, invokes, kill: () => { try { proc.kill(); } catch {} }, open: () => hostReq("open", { port: 0, token: `tok-${instanceId}-${randomUUID()}`, protocolVersion: 0, instanceId, label: `L-${instanceId}`, ...extra }) };
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
function control(body, tControl, method = "POST") {
  return new Promise((resolve) => {
    const p = Buffer.from(method === "GET" ? "" : JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port: HUB_PORT, path: "/control", method, headers: { "content-type": "application/json", "content-length": p.length, authorization: `Bearer ${tControl}` } }, (r) => {
      let d = ""; r.on("data", (x) => (d += x)); r.on("end", () => { let j; try { j = JSON.parse(d); } catch {} resolve({ status: r.statusCode, json: j }); });
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

  // the hub tells the agent which extension build each browser runs
  ok(insts.instances.every((i) => "extensionVersion" in i && Array.isArray(i.features)), "list_instances reports each browser's extension version + features");

  // an unknown session id gets 404 (the MCP spec's cue to re-initialize), not 400
  ok((await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { sessionId: "no-such-session", token: tAgent })).status === 404, "unknown session id → 404 (client re-initializes)");

  // ...but an `initialize` that still carries a stale session id opens a new session (a client that
  // re-initializes without resetting its header must not be stuck on 404)
  const reinit = await rpc({ jsonrpc: "2.0", id: 4, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }, { sessionId: "no-such-session", token: tAgent });
  ok(reinit.status === 200 && !!reinit.sessionId && reinit.sessionId !== "no-such-session", `initialize with a stale session id → a new session (got ${reinit.status})`);

  // a host that restarts under the SAME instanceId (Stop → Start) gets a new port/token; the hub
  // must drop the dead client and reconnect instead of serving an empty list_tabs forever
  A.kill();
  const A2 = startInstance("A", "2"); ok((await A2.open()).ok, "instance A restarted under the same id");
  const lt2 = toolResult(await call("list_tabs", {}, sid, tAgent));
  ok((lt2?.tabs || []).some((t) => t.id === "A:1" && t.title === "tab-A2"), `restarted instance is served at once (got ${JSON.stringify((lt2?.tabs || []).map((t) => t.title))})`);
  await sleep(3500); // and the periodic reconcile keeps it connected
  const lt3 = toolResult(await call("list_tabs", {}, sid, tAgent));
  ok((lt3?.tabs || []).some((t) => t.title === "tab-A2"), "still served after the next poll");

  // the hub refuses a call that needs a feature the TARGET instance's build lacks, instead of
  // forwarding it to a host/extension that would run it somewhere else (frameId ignored -> top page).
  // A's fake extension reported no features (an old build); C's reports them.
  const C = startInstance("C", "", { extensionVersion: "1.6.0", features: ["frames", "pinned-docs", "cdp-input"] });
  ok((await C.open()).ok, "a third instance reporting its extension features is up");
  await sleep(3600); // the hub's poll connects it
  const outdated = await call("list_frames", { instanceId: "A" }, sid, tAgent);
  ok(outdated.json?.result?.isError && /EXTENSION_OUTDATED/.test(outdated.json.result.content[0].text) && !A2.invokes.includes("list_frames"), "an instance without the 'frames' feature: list_frames → EXTENSION_OUTDATED and nothing reached its extension");
  const outdated2 = await call("get_page_content", { instanceId: "A", tabId: 1, frameId: 3 }, sid, tAgent);
  ok(outdated2.json?.result?.isError && /EXTENSION_OUTDATED/.test(outdated2.json.result.content[0].text) && !A2.invokes.includes("get_page_content"), "...and so is a frameId on an ordinary tool");
  const plain = await call("get_page_content", { instanceId: "A", tabId: 1, frameId: 0 }, sid, tAgent);
  ok(plain.json?.result?.isError && !/EXTENSION_OUTDATED/.test(plain.json.result.content[0].text) && A2.invokes.includes("get_page_content"), "frameId 0 (the page itself) needs no feature: it is forwarded");
  const fine = await call("list_frames", { instanceId: "C" }, sid, tAgent);
  ok(!/EXTENSION_OUTDATED/.test(fine.json?.result?.content?.[0]?.text || "") && C.invokes.includes("list_frames"), "an instance that reports the feature gets the call");
  const instsC = toolResult(await call("list_instances", {}, sid, tAgent));
  ok(instsC.instances.find((i) => i.instanceId === "C")?.extensionVersion === "1.6.0", "list_instances shows the reported extension version");

  // /control answers 502 when the browser refuses (it used to say ok)
  const tControl0 = JSON.parse(readFileSync(resolve(DIR, "control"), "utf8")).tControl;
  const uns = await control({ op: "unshare", instanceId: "A", tabId: 1 }, tControl0);
  ok(uns.status === 502, `/control unshare that the browser refuses → 502 (got ${uns.status})`);
  const stop = await control({ op: "stopAll", instanceId: "A" }, tControl0);
  ok(stop.status === 200 && stop.json?.ok === true, "/control stopAll that succeeds → 200");
  C.kill();
  await sleep(300);

  // revokeAll reports a browser that failed to clear (B's fake extension errors on _td/revoke_all)
  const tControl = JSON.parse(readFileSync(resolve(DIR, "control"), "utf8")).tControl;
  const rv = await control({ op: "revokeAll", exceptInstanceId: "nobody" }, tControl);
  ok(rv.status === 502 && rv.json?.ok === false && JSON.stringify(rv.json?.failed) === JSON.stringify(["B"]), `revokeAll with a browser that fails → 502 naming it (got ${rv.status} ${JSON.stringify(rv.json)})`);
  const rv2 = await control({ op: "revokeAll", exceptInstanceId: "B" }, tControl);
  ok(rv2.status === 200 && rv2.json?.ok === true, "revokeAll succeeds when every other browser cleared");

  // a browser that is alive (discovery entry, live pid) but that the hub cannot reach must be
  // named as unavailable, and "revoke all" must not claim success for it
  const holder = spawn(process.execPath, ["-e", "setTimeout(()=>{},120000)"], { stdio: "ignore" }); procs.push(holder);
  mkdirSync(resolve(DIR, "instances"), { recursive: true });
  writeFileSync(resolve(DIR, "instances", "Z.json"), JSON.stringify({ instanceId: "Z", label: "L-Z", port: 1, token: "x", pid: holder.pid, updatedAt: Date.now() }));
  const ltZ = toolResult(await call("list_tabs", {}, sid, tAgent));
  ok((ltZ?.unavailable || []).some((u) => u.instanceId === "Z") && (ltZ.tabs || []).some((t) => t.id === "A:1"), `list_tabs names the live-but-unreachable browser and still lists the rest (got ${JSON.stringify(ltZ?.unavailable)})`);
  const snap = await control({}, tControl, "GET");
  ok((snap.json?.instances || []).some((i) => i.instanceId === "Z" && i.tier === "unknown" && i.unavailable === true), "the popup snapshot lists it as unavailable");
  const rvZ = await control({ op: "revokeAll", exceptInstanceId: "B" }, tControl);
  ok(rvZ.status === 502 && JSON.stringify(rvZ.json?.failed) === JSON.stringify(["Z"]), `revokeAll does not report success while it could not reach a live browser (got ${rvZ.status} ${JSON.stringify(rvZ.json)})`);
  holder.kill(); await sleep(400); // the pid is gone: the entry is dead and no longer counts
  const rvZ2 = await control({ op: "revokeAll", exceptInstanceId: "B" }, tControl);
  ok(rvZ2.status === 200 && rvZ2.json?.ok === true, "...and once that browser's process is gone, revokeAll succeeds again");

  // a browser that dies mid-poll is reported in list_tabs (not silently missing); the rest still answer
  B.kill();
  await sleep(500);
  const ltPartial = toolResult(await call("list_tabs", {}, sid, tAgent));
  ok(Array.isArray(ltPartial?.unavailable) && ltPartial.unavailable.some((u) => u.instanceId === "B") && (ltPartial.tabs || []).some((t) => t.id === "A:1"), `list_tabs names the browser that didn't answer and still lists the rest (got ${JSON.stringify(ltPartial)})`);

  // mid-flight failover: call to the dead instance → INSTANCE_GONE (reconnect fails; not a 20s timeout)
  const gone = await call("get_active_tab", { instanceId: "B" }, sid, tAgent);
  ok(gone.json?.result?.isError && /INSTANCE_GONE/.test(gone.json.result.content[0].text), "call to a just-killed instance → INSTANCE_GONE");

  await sleep(4000); // let the 3s poll reconcile
  const insts2 = toolResult(await call("list_instances", {}, sid, tAgent));
  ok(insts2?.instances?.length === 1 && insts2.instances[0].instanceId === "A", "after poll → 1 instance");

  // self-exit when the registry empties
  A2.kill();
  await sleep(6000);
  ok(!existsSync(resolve(DIR, "hub.json")), "hub self-exits + removes hub.json when empty");

  console.log(fails ? `\nHUB CONFORMANCE FAILED (${fails})` : "\nHUB CONFORMANCE PASSED");
  finish(fails ? 1 : 0);
})().catch((e) => { console.error("HUB ERROR:", e); finish(1); });
