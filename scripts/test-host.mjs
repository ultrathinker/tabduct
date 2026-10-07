#!/usr/bin/env node
// Tests of the Node host's extension-facing behaviour, with a fake extension over stdio, in an
// ISOLATED TABDUCT_DIR (never ~/.tabduct): what `open` records (version + features), the
// "your extension is older than the code on disk" notice, feature gating of calls, relabel,
// per-tool timeout budgets and the version compare.

import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { cmpVersion } from "../hosts/node/src/tools.js";
import { invokeTimeoutMs } from "../hosts/node/src/constants.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = resolve(REPO, "hosts/node/src/index.js");
const DISK = JSON.parse(readFileSync(resolve(REPO, "extension/manifest.json"), "utf8")).version;
const DIR = process.env.TABDUCT_DIR || mkdtempSync(join(tmpdir(), "tabduct-host-"));
if (resolve(DIR) === resolve(homedir(), ".tabduct")) { console.error("REFUSING to run against the real ~/.tabduct"); process.exit(1); }

let fails = 0;
const ok = (c, m) => { if (!c) { console.error("  FAIL:", m); fails++; } else console.log("  ok:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startHost(env = {}) {
  const proc = spawn(process.execPath, [HOST], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, TABDUCT_DIR: DIR, ...env } });
  const send = (o) => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length, 0); proc.stdin.write(Buffer.concat([h, b])); };
  let buf = Buffer.alloc(0), need = -1; const pend = new Map(); const notices = []; const invokes = [];
  proc.stdout.on("data", (c) => {
    buf = Buffer.concat([buf, c]);
    for (;;) {
      if (need === -1) { if (buf.length < 4) return; need = buf.readUInt32LE(0); buf = buf.subarray(4); }
      if (buf.length < need) return;
      const m = JSON.parse(buf.subarray(0, need).toString()); buf = buf.subarray(need); need = -1;
      if (m.replyTo) { const r = pend.get(m.replyTo); if (r) { pend.delete(m.replyTo); r(m); } }
      else if (m.type === "notice") notices.push(m.payload);
      else if (m.type === "invoke") { invokes.push(m.payload); send({ replyTo: m.id, ok: true, result: { frames: [], echoed: m.payload.tool } }); }
    }
  });
  const req = (type, payload) => new Promise((res) => { const id = randomUUID(); pend.set(id, res); send({ type, id, payload }); });
  return { proc, req, notices, invokes, kill: () => { try { proc.kill(); } catch {} } };
}

function rpc(port, token, body, sessionId) {
  return new Promise((resolveP) => {
    const p = Buffer.from(JSON.stringify(body));
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": p.length, authorization: `Bearer ${token}` };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const r = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers }, (res) => {
      let d = ""; res.on("data", (x) => (d += x)); res.on("end", () => { let j; if ((res.headers["content-type"] || "").includes("text/event-stream")) { const l = d.split("\n").filter((x) => x.startsWith("data:")).pop(); j = l ? JSON.parse(l.slice(5).trim()) : undefined; } else if (d) { try { j = JSON.parse(d); } catch {} } resolveP({ status: res.statusCode, sid: res.headers["mcp-session-id"], json: j }); });
    });
    r.on("error", () => resolveP({ status: "REFUSED" })); r.end(p);
  });
}
async function session(port, token) {
  const init = await rpc(port, token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  await rpc(port, token, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sid);
  return { sid: init.sid, call: (name, args) => rpc(port, token, { jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method: "tools/call", params: { name, arguments: args } }, init.sid) };
}
const text = (r) => r.json?.result?.content?.[0]?.text || "";

(async () => {
  const hosts = [];
  try {
    // ---- an OLD extension build: no version, no features ------------------------------------
    const h1 = startHost(); hosts.push(h1);
    const tok1 = "t1-" + randomUUID();
    const o1 = await h1.req("open", { port: 0, token: tok1, protocolVersion: 0, instanceId: "old", label: "Old" });
    ok(o1.ok, "open (old build: no extensionVersion / features) succeeds");
    await sleep(300);
    ok(h1.notices.some((n) => n.level === "warn" && /reload/i.test(n.message) && n.message.includes(`v${DISK}`)), "host warns that the running extension is older than the code on disk (names both versions)");
    const e1 = JSON.parse(readFileSync(resolve(DIR, "instances", "old.json"), "utf8"));
    ok(e1.extensionVersion === null && Array.isArray(e1.features) && e1.features.length === 0, "discovery entry records version null + no features");
    const s1 = await session(o1.result.port, tok1);
    const r1 = await s1.call("get_page_content", { frameId: 2 });
    ok(/^EXTENSION_OUTDATED/.test(text(r1)) && h1.invokes.length === 0, "frameId against an old build → EXTENSION_OUTDATED, nothing reached the extension");
    ok(/reload/i.test(text(r1)), "...and the error says how to fix it");
    const r1b = await s1.call("get_page_content", {});
    ok(!r1b.json?.result?.isError && h1.invokes.length === 1, "plain calls still work on the old build");

    // ---- a CURRENT build ----------------------------------------------------------------------
    const h2 = startHost(); hosts.push(h2);
    const tok2 = "t2-" + randomUUID();
    const o2 = await h2.req("open", { port: 0, token: tok2, protocolVersion: 0, instanceId: "cur", label: "Cur", extensionVersion: DISK, features: ["frames", "pinned-docs"] });
    ok(o2.ok, "open (current build) succeeds");
    await sleep(300);
    ok(h2.notices.length === 0, "no notice when the running build is as new as the code on disk");
    const e2 = JSON.parse(readFileSync(resolve(DIR, "instances", "cur.json"), "utf8"));
    ok(e2.extensionVersion === DISK && e2.features.includes("frames"), "discovery entry records the build's version and features");
    const s2 = await session(o2.result.port, tok2);
    const r2 = await s2.call("list_frames", {});
    ok(!r2.json?.result?.isError && h2.invokes.at(-1)?.tool === "list_frames", "list_frames is forwarded when the build has `frames`");
    const r2b = await s2.call("get_page_content", { frameId: 4 });
    ok(!r2b.json?.result?.isError && h2.invokes.at(-1)?.args?.frameId === 4, "frameId is forwarded when the build has `frames`");

    // ---- relabel (popup rename reaches the hub through the discovery entry) ------------------------
    const rl = await h2.req("relabel", { label: "  Work  " });
    ok(rl.ok, "relabel accepted");
    ok(JSON.parse(readFileSync(resolve(DIR, "instances", "cur.json"), "utf8")).label === "Work", "discovery entry carries the new label");
    ok((await h2.req("relabel", { label: "   " })).ok === false, "an empty label is refused");

    // ---- an old build is only an old build: a version that is a PATCH behind still warns --------------
    const h3 = startHost(); hosts.push(h3);
    const [maj, min, pat] = DISK.split(".").map(Number);
    const behind = `${maj}.${min}.${Math.max(0, pat - 1)}`;
    await h3.req("open", { port: 0, token: "t3-" + randomUUID(), protocolVersion: 0, instanceId: "behind", label: "B", extensionVersion: pat > 0 ? behind : `${maj}.${Math.max(0, min - 1)}.9`, features: ["frames"] });
    await sleep(300);
    ok(h3.notices.length === 1, "a build one patch/minor behind the disk still gets the reload notice");

    // ---- OPUS-12: a hub that dies while the browser stays connected is brought back ----------------------------
    const HPORT = 13600 + Math.floor(Date.now() % 300);
    const h4 = startHost({ TABDUCT_HUB_PORT: String(HPORT), TABDUCT_HUB_IDLE_MS: "2500" }); hosts.push(h4);
    const o4 = await h4.req("open", { port: 0, token: "t4-" + randomUUID(), protocolVersion: 0, instanceId: "watch", label: "W", hub: true, extensionVersion: DISK, features: ["frames"] });
    ok(o4.ok && o4.result?.hub === true && !!o4.result?.endpoint, "open with hub:true brings the hub up and returns its endpoint");
    const hubPid = () => { try { return JSON.parse(readFileSync(resolve(DIR, "hub.json"), "utf8")).pid; } catch { return null; } };
    const pid1 = hubPid();
    ok(Number.isInteger(pid1), "hub.json names the hub process");
    try { process.kill(pid1); } catch {}
    let pid2 = null;
    for (let i = 0; i < 40 && !(pid2 && pid2 !== pid1); i++) { await sleep(1000); pid2 = hubPid(); }
    ok(Number.isInteger(pid2) && pid2 !== pid1, `the host noticed the dead hub and started a new one (pid ${pid1} -> ${pid2})`);
    await h4.req("close", {}); // stops the watchdog; the hub then idles out (TABDUCT_HUB_IDLE_MS) in this isolated dir
    await sleep(500);
    try { if (pid2) process.kill(pid2); } catch {}

    // ---- pure helpers -------------------------------------------------------------------------------------
    ok([cmpVersion("1.5.0", "1.6.0"), cmpVersion("1.6.0", "1.6.0"), cmpVersion("1.10.0", "1.9.9"), cmpVersion(null, "0.0.1")].join() === "-1,0,1,-1", "cmpVersion orders dotted versions numerically (missing = oldest)");
    ok(invokeTimeoutMs("wait_for", { timeoutMs: 25000 }) === 30000 && invokeTimeoutMs("wait_for", {}) === 15000 && invokeTimeoutMs("click", {}) === 20000, "wait_for gets its wait plus overhead; others the generic budget (OPUS-14)");
    ok(invokeTimeoutMs("wait_for", { timeoutMs: 99999 }) === 30000, "...but never more than the 25 s cap + overhead");
  } catch (e) { console.error("  ERROR:", e); fails++; }
  for (const h of hosts) h.kill();
  console.log(fails ? `\nHOST TESTS FAILED (${fails})` : "\nHOST TESTS PASSED");
  process.exit(fails ? 1 : 0);
})();
