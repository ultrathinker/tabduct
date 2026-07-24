#!/usr/bin/env node
// Tabduct Node host — entry point.
//
// Boots native messaging, wires the bridge + MCP server, and handles the
// request/reply lifecycle (open/close/ping). Requests are SERIALIZED so an
// open/close race can't tear down a still-starting server. See PROTOCOL.md.

import { NativeMessaging } from "./native-messaging.js";
import { Bridge } from "./bridge.js";
import { McpHttpServer } from "./mcp-server.js";
import { registerTools } from "./tools.js";
import { writeEntry, removeEntry } from "./discovery.js";
import { ensureSecrets, baseDir } from "./secrets.js";
import { PROTOCOL_VERSION, DEFAULT_PORT, HUB_PORT, STOP_GRACE_MS, ERR } from "./constants.js";
import { spawn } from "node:child_process";
import { openSync, readFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const nm = new NativeMessaging();
const bridge = new Bridge(nm);
const server = new McpHttpServer((s) => registerTools(s, bridge));
let currentInstance = null;

// Liveness by actually probing the port (pid alone lies on pid-reuse).
function hubReachable() {
  return new Promise((res) => {
    const req = http.request({ host: "127.0.0.1", port: HUB_PORT, path: "/mcp", method: "GET", timeout: 500 }, (r) => { r.resume(); res(true); });
    req.on("error", () => res(false));
    req.on("timeout", () => { req.destroy(); res(false); });
    req.end();
  });
}
// hubReachable() returns true for ANY process on HUB_PORT (a port probe only), so a
// same-user squatter could harvest tAgent. Before disclosing it, confirm the listener
// is OUR hub: hub.json (written by hub.js after bind) must exist, record a LIVE pid,
// and its mcpPort must equal HUB_PORT. (pid-reuse is bounded: we never disclose on a
// dead pid, and a foreign process can't match our hub.json's pid+port pair.)
function hubVerified() {
  try {
    const json = JSON.parse(readFileSync(resolve(baseDir(), "hub.json"), "utf8"));
    if (json?.mcpPort !== HUB_PORT || !Number.isInteger(json.pid)) return false;
    process.kill(json.pid, 0); // throws if pid is dead → not our (current) hub
    return true;
  } catch { return false; }
}
async function ensureHub() {
  // Self-healing. The old check `if (await hubReachable()) return true` trusted ANY listener
  // on HUB_PORT, so an orphaned/half-dead hub (or one that dropped its hub.json mid-shutdown
  // but still held the port) answered HTTP, we skipped the respawn, and then — correctly —
  // refused to disclose the token to an unverified listener. Result: Start stuck forever with
  // an empty hub.log and no recovery. Now we only ever accept a hub we can VERIFY is ours
  // (reachable + live hub.json on our port), and otherwise bring our own hub up — spawning as
  // soon as the port is actually free (a stray finally releasing it heals within one Start).
  const hubPath = resolve(dirname(fileURLToPath(import.meta.url)), "hub.js");
  const logPath = resolve(baseDir(), "hub.log");
  let spawned = false, loggedStray = false;
  // Spawn the hub DETACHED with its own stdio -> hub.log so any startup failure is
  // diagnosable. (The previous Windows path wrapped this in `cmd /c start /B ... 2>>log`,
  // where the redirect bound to `start` rather than the hub — hub.log stayed empty and
  // failures were invisible. A plain detached spawn works cross-platform and captures the
  // hub's own output; the hub self-exits when idle so it doesn't linger.)
  for (let i = 0; i < 90; i++) { // bounded ~13.5s (node + MCP SDK cold start)
    const reachable = await hubReachable();
    if (reachable && hubVerified()) return true; // our hub is up and confirmed ours
    if (!reachable && !spawned) {
      let logFd = "ignore"; try { logFd = openSync(logPath, "a", 0o600); } catch {}
      try {
        appendFileSync(logPath, `[host ${process.pid}] ensureHub: spawning ${process.execPath} ${hubPath}\n`);
        const child = spawn(process.execPath, [hubPath], { detached: true, windowsHide: true, stdio: ["ignore", logFd, logFd] });
        child.on("error", (e) => { try { appendFileSync(logPath, `[host] hub spawn error: ${e.message}\n`); } catch {} });
        child.unref?.();
        spawned = true;
      } catch (e) {
        try { appendFileSync(logPath, `[host] ensureHub failed: ${e.message}\n`); } catch {}
      }
    } else if (reachable && !spawned && !loggedStray) {
      // Something answers on HUB_PORT but isn't our verified hub — a stray we can't take the
      // port from. Log it (so hub.log isn't silent) and wait for it to clear so we can respawn.
      try { appendFileSync(logPath, `[host ${process.pid}] ensureHub: port ${HUB_PORT} answered but is not our verified hub — waiting for it to clear\n`); } catch {}
      loggedStray = true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  try { appendFileSync(logPath, `[host ${process.pid}] ensureHub: our hub NOT verified after wait (port ${HUB_PORT} may be held by a stray process)\n`); } catch {}
  return false;
}

// Call the hub's non-MCP /control endpoint (tControl-authed) on the extension's
// behalf — so the popup never talks to the hub directly (Origin stays fully rejected).
function hubControl(method, body) {
  return new Promise((resolve, reject) => {
    // Only hand tControl to a listener we've CONFIRMED is our hub (hub.json pid alive +
    // port matches) — same discipline as the tAgent disclosure path; don't leak it to a
    // same-user squatter pre-bound to HUB_PORT.
    if (!hubVerified()) { reject(Object.assign(new Error("hub not verified"), { code: ERR.INTERNAL })); return; }
    let tControl; try { tControl = ensureSecrets().tControl; } catch (e) { reject(e); return; }
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: "127.0.0.1", port: HUB_PORT, path: "/control", method,
      timeout: 6000,
      headers: { Authorization: `Bearer ${tControl}`, ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) },
    }, (r) => {
      const chunks = []; r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null; try { json = text ? JSON.parse(text) : {}; } catch {}
        if (r.statusCode >= 200 && r.statusCode < 300) resolve(json ?? {});
        else reject(Object.assign(new Error(json?.error || `control ${r.statusCode}`), { code: ERR.INTERNAL }));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("control request timed out")); });
    if (data) req.write(data);
    req.end();
  });
}

function reply(id, ok, payload) {
  if (id == null) return;
  try { nm.send(ok ? { replyTo: id, ok: true, result: payload } : { replyTo: id, ok: false, error: payload }); }
  catch (e) { process.stderr.write(`[tabduct] failed to send reply: ${e.message}\n`); }
}

async function handle(msg) {
  const { type, id, payload } = msg ?? {};
  switch (type) {
    case "open": {
      if (payload?.protocolVersion !== PROTOCOL_VERSION) {
        reply(id, false, { code: ERR.VERSION_MISMATCH, message: `host v${PROTOCOL_VERSION}, extension v${payload?.protocolVersion}` });
        return;
      }
      const token = payload?.token;
      if (typeof token !== "string" || token.length < 16) {
        reply(id, false, { code: ERR.INVALID_ARGS, message: "missing or too-short token" });
        return;
      }
      const port = payload?.port ?? DEFAULT_PORT;
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        reply(id, false, { code: ERR.INVALID_ARGS, message: "invalid port" });
        return;
      }
      try {
        const bound = await server.start(port, token);
        currentInstance = (typeof payload?.instanceId === "string" && payload.instanceId) || "default";
        try { writeEntry({ instanceId: currentInstance, label: payload?.label || "Chrome", port: bound, token, pid: process.pid, updatedAt: Date.now() }); } catch {}
        // Hub mode: the host still binds direct (so the hub can proxy it) + also
        // ensures a hub is running. Only disclose the stable endpoint+token once we
        // CONFIRM the port is OUR hub (hub.json pid alive + mcpPort matches) — never
        // hand tAgent to a possibly-foreign process squatting on HUB_PORT.
        let extra = {};
        if (payload?.hub) {
          try {
            const { tAgent } = ensureSecrets();
            const up = await ensureHub();
            if (up && hubVerified()) extra = { hub: true, endpoint: `http://127.0.0.1:${HUB_PORT}/mcp`, token: tAgent, hubReady: true };
            else extra = { hub: true, hubReady: false }; // reachable but not verifiably ours → no token disclosure
          } catch {}
        }
        reply(id, true, { port: bound, protocolVersion: PROTOCOL_VERSION, ...extra });
      } catch (e) {
        reply(id, false, { code: ERR.INTERNAL, message: `open failed: ${e.message}` });
      }
      return;
    }
    case "close":
      try { await server.stop(); if (currentInstance) { removeEntry(currentInstance); currentInstance = null; } reply(id, true, {}); }
      catch (e) { reply(id, false, { code: ERR.INTERNAL, message: `close failed: ${e.message}` }); }
      return;
    case "peers": // popup: list all instances + what each shares (via hub /control)
      try { reply(id, true, await hubControl("GET")); }
      catch (e) { reply(id, false, { code: e.code || ERR.INTERNAL, message: e.message }); }
      return;
    case "peerUnshare": // popup: unshare one tab in another instance
      try { await hubControl("POST", { op: "unshare", instanceId: payload?.instanceId, tabId: payload?.tabId }); reply(id, true, { ok: true }); }
      catch (e) { reply(id, false, { code: e.code || ERR.INTERNAL, message: e.message }); }
      return;
    case "peerStopAll": // popup: turn off Share-Everything in another instance
      try { await hubControl("POST", { op: "stopAll", instanceId: payload?.instanceId }); reply(id, true, { ok: true }); }
      catch (e) { reply(id, false, { code: e.code || ERR.INTERNAL, message: e.message }); }
      return;
    case "peerRevokeAll": // popup "Revoke all sharing": clear every OTHER instance (this one is cleared locally)
      try { await hubControl("POST", { op: "revokeAll", exceptInstanceId: currentInstance }); reply(id, true, { ok: true }); }
      catch (e) { reply(id, false, { code: e.code || ERR.INTERNAL, message: e.message }); }
      return;
    case "ping":
      reply(id, true, { pong: true });
      return;
    default:
      reply(id, false, { code: ERR.INVALID_ARGS, message: `unknown request type: ${type}` });
      return;
  }
}

// Serialize lifecycle requests; replies to our invokes are synchronous and skip the queue.
let queue = Promise.resolve();
nm.onMessage((msg) => {
  if (msg && msg.replyTo) { bridge.handleReply(msg); return; }
  queue = queue.then(() => handle(msg)).catch((e) => process.stderr.write(`[tabduct] handler error: ${e.stack || e}\n`));
});

nm.onEnd(async () => {
  bridge.rejectAll("extension disconnected");
  if (currentInstance) { removeEntry(currentInstance); currentInstance = null; }
  const t = setTimeout(() => process.exit(0), STOP_GRACE_MS); t.unref?.();
  try { await server.stop(); } finally { clearTimeout(t); process.exit(0); }
});

nm.start();
