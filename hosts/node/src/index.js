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
import { openSync, readFileSync } from "node:fs";
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
  if (await hubReachable()) return true;
  const hubPath = resolve(dirname(fileURLToPath(import.meta.url)), "hub.js");
  let logFd = "ignore"; try { logFd = openSync(resolve(baseDir(), "hub.log"), "a", 0o600); } catch {}
  try {
    if (process.platform === "win32") {
      // `detached` alone does NOT break out of Chrome's job object; `start /B` does.
      const logPath = resolve(baseDir(), "hub.log");
      spawn(process.env.ComSpec || "cmd.exe", ["/c", `start "" /B "${process.execPath}" "${hubPath}" 2>>"${logPath}"`], { detached: true, windowsHide: true, stdio: "ignore" }).unref?.();
    } else {
      spawn(process.execPath, [hubPath], { detached: true, stdio: ["ignore", "ignore", logFd] }).unref?.();
    }
  } catch {}
  for (let i = 0; i < 30; i++) { if (await hubReachable()) return true; await new Promise((r) => setTimeout(r, 150)); } // bounded ~4.5s
  return false;
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
        // Discovery is how the hub finds this instance (hub.js calls readAll()).
        // A silent failure here would make `hub mode` look "connected" while the
        // browser never appears behind the stable endpoint — so log loudly, and
        // remember the failure to block hub token disclosure below.
        let discoveryOk = true;
        try {
          writeEntry({ instanceId: currentInstance, label: payload?.label || "Chrome", port: bound, token, pid: process.pid, updatedAt: Date.now() });
        } catch (e) {
          discoveryOk = false;
          process.stderr.write(`[tabduct] discovery write failed: ${e.message}\n`);
        }
        // Hub mode: the host still binds direct (so the hub can proxy it) + also
        // ensures a hub is running. Only disclose the stable endpoint+token once we
        // CONFIRM the port is OUR hub (hub.json pid alive + mcpPort matches) — never
        // hand tAgent to a possibly-foreign process squatting on HUB_PORT.
        let extra = {};
        if (payload?.hub) {
          if (!discoveryOk) {
            // No discovery entry → the hub can never route to us. Don't disclose
            // tAgent; surface the failure so the user doesn't see "connected".
            extra = { hub: true, hubReady: false, hubError: "discovery write failed; this instance will not appear in the hub until it is fixed (see stderr)" };
          } else {
            try {
              const { tAgent } = ensureSecrets();
              const up = await ensureHub();
              if (up && hubVerified()) extra = { hub: true, endpoint: `http://127.0.0.1:${HUB_PORT}/mcp`, token: tAgent, hubReady: true };
              else extra = { hub: true, hubReady: false }; // reachable but not verifiably ours → no token disclosure
            } catch (e) {
              process.stderr.write(`[tabduct] hub start failed: ${e.message}\n`);
              extra = { hub: true, hubReady: false };
            }
          }
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
