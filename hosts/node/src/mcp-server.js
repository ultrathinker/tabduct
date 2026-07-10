// Tabduct Node host — MCP streamable-HTTP server (the "north" edge).
//
// HTTP server on 127.0.0.1:<port>/mcp using @modelcontextprotocol/sdk.
// Auth + origin/host checks (PROTOCOL.md §6) gate every request. One MCP session
// = one { server, transport }; sessions are cleaned on close/error and on stop().

import { createServer } from "node:http";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { BIND_HOST, MCP_PATH, MCP_REQUEST_MAX_BYTES, STOP_GRACE_MS, allowedHosts } from "./constants.js";

// Constant-length token compare (hash both sides → no length leak, no empty-token match).
function tokenEqual(a, b) {
  return timingSafeEqual(createHash("sha256").update(String(a ?? "")).digest(),
                         createHash("sha256").update(String(b ?? "")).digest());
}

class BodyTooLarge extends Error { constructor() { super("body too large"); this.code = "BODY_TOO_LARGE"; } }

function readJsonBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    const cleanup = () => { req.off("data", onData); req.off("end", onEnd); req.off("error", onErr); };
    const onData = (c) => {
      bytes += c.length;
      if (bytes > max) { cleanup(); req.destroy(); reject(new BodyTooLarge()); return; }
      chunks.push(c);
    };
    const onEnd = () => { cleanup(); try { const s = Buffer.concat(chunks).toString("utf8"); resolve(s ? JSON.parse(s) : undefined); } catch (e) { reject(e); } };
    const onErr = (e) => { cleanup(); reject(e); };
    req.on("data", onData); req.on("end", onEnd); req.on("error", onErr);
  });
}

export class McpHttpServer {
  /**
   * @param {(server:object)=>void} register  registers tools on a fresh MCP Server (direct: bridge tools; hub: router).
   * @param {(method:string, body:any)=>Promise<{status?:number, json?:any}>} [control]
   *   Optional handler for the non-MCP /control endpoint. Provided ONLY by the hub
   *   (instance hosts pass nothing → /control is 404). Authenticated with a separate
   *   `controlToken` (never the agent's token), so /control is invisible to the agent.
   */
  constructor(register, control) {
    this._register = register;
    this._control = typeof control === "function" ? control : null;
    this._http = null;
    this._token = null;
    this._controlToken = null;
    this._port = null;
    this._hosts = null;
    this.isRunning = false;
    this._starting = false;
    this._sessions = new Map(); // sessionId -> { server, transport, seen }
    this._reaper = null;
  }

  _reapIdle() {
    const now = Date.now();
    for (const [sid, e] of this._sessions) {
      if (e.activeStream) continue; // a live GET/SSE stream isn't idle (seen only refreshes on new requests)
      if (now - (e.seen || 0) > 10 * 60 * 1000) { // reap sessions idle > 10 min (clients rarely DELETE)
        try { e.server.close(); } catch {}
        try { e.transport.close(); } catch {}
        this._sessions.delete(sid);
      }
    }
  }

  // PROTOCOL.md §6 gatekeeper. Returns null if OK, else [status, message].
  _reject(req) {
    if (req.headers.origin) return [403, "origin not permitted"]; // no non-browser MCP client sends Origin
    if (!this._hosts.has(req.headers.host || "")) return [403, "bad host header — use 127.0.0.1"];
    const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || "");
    if (!m || !tokenEqual(m[1], this._token)) return [401, "unauthorized"];
    return null;
  }

  async _newSession() {
    const server = new Server({ name: "tabduct", version: "0.0.1" }, { capabilities: { tools: {} } });
    this._register(server);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => this._sessions.set(sid, { server, transport, seen: Date.now() }),
    });
    const cleanup = () => { if (transport.sessionId) this._sessions.delete(transport.sessionId); };
    transport.onclose = cleanup;
    transport.onerror = cleanup;
    await server.connect(transport); // await: don't depend on undocumented microtask ordering
    return transport;
  }

  // Non-MCP control channel (hub only). Same anti-DNS-rebinding guards as /mcp
  // (no Origin, pinned Host) but a SEPARATE bearer (controlToken) — so the agent's
  // token can't reach it. GET → status snapshot; POST {op,...} → an unshare action.
  async _onControl(req, res) {
    try {
      if (req.headers.origin) { res.writeHead(403).end("origin not permitted"); return; }
      if (!this._hosts.has(req.headers.host || "")) { res.writeHead(403).end("bad host header — use 127.0.0.1"); return; }
      const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || "");
      if (!this._controlToken || !m || !tokenEqual(m[1], this._controlToken)) { res.writeHead(401).end("unauthorized"); return; }
      let body;
      if (req.method === "POST") {
        try { body = await readJsonBody(req, MCP_REQUEST_MAX_BYTES); }
        catch (e) { res.writeHead(e.code === "BODY_TOO_LARGE" ? 413 : 400).end(e.code === "BODY_TOO_LARGE" ? "payload too large" : "bad json"); return; }
      } else if (req.method !== "GET") { res.writeHead(405).end("method not allowed"); return; }
      const out = await this._control(req.method, body);
      res.writeHead(out?.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(out?.json ?? {}));
    } catch (e) {
      process.stderr.write(`[tabduct] control error: ${e.message}\n`);
      if (!res.headersSent) res.writeHead(500).end("internal error");
      else if (!res.writableEnded) res.end();
    }
  }

  async _onRequest(req, res) {
    try {
      let pathname; try { pathname = new URL(req.url, "http://x").pathname; } catch { pathname = req.url; }
      if (this._control && pathname === "/control") { await this._onControl(req, res); return; }

      const bad = this._reject(req);
      if (bad) { res.writeHead(bad[0]).end(bad[1]); return; }

      if (pathname !== MCP_PATH) { res.writeHead(404).end("not found"); return; }

      const sid = req.headers["mcp-session-id"];
      const entry = sid ? this._sessions.get(sid) : undefined;
      let transport = entry?.transport;
      if (entry) entry.seen = Date.now(); // touch for idle-reap

      if (req.method === "POST") {
        let body;
        try { body = await readJsonBody(req, MCP_REQUEST_MAX_BYTES); }
        catch (e) { res.writeHead(e.code === "BODY_TOO_LARGE" ? 413 : 400).end(e.code === "BODY_TOO_LARGE" ? "payload too large" : "bad json"); return; }
        if (!transport) {
          if (!isInitializeRequest(body)) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session; initialize first" }, id: null })); return; }
          transport = await this._newSession();
          try { await transport.handleRequest(req, res, body); }
          catch (e) { try { await transport.close(); } catch {} throw e; } // don't leak a transport whose init failed
          return;
        }
        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        if (!transport) { res.writeHead(400).end("missing or unknown session"); return; }
        // A GET opens a long-lived SSE stream that won't issue new requests (so it
        // never refreshes `seen`); exempt it from idle-reaping until the stream ends.
        if (req.method === "GET" && entry) { entry.activeStream = true; res.on("close", () => { entry.activeStream = false; }); }
        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405).end("method not allowed");
    } catch (e) {
      process.stderr.write(`[tabduct] request error: ${e.message}\n`);
      if (!res.headersSent) res.writeHead(500).end("internal error");
      else if (!res.writableEnded) res.end();
    }
  }

  async start(port, token, controlToken) {
    if (this.isRunning || this._starting) throw new Error("Server already running");
    this._starting = true;
    this._token = token;
    this._controlToken = controlToken ?? null;
    try {
      this._http = createServer((req, res) => this._onRequest(req, res));
      this._http.on("error", (e) => process.stderr.write(`[tabduct] http error: ${e.message}\n`));
      await new Promise((resolve, reject) => {
        const onErr = (e) => reject(e);
        this._http.once("error", onErr);
        this._http.listen(port, BIND_HOST, () => { this._http.off("error", onErr); resolve(); });
      });
      this._port = this._http.address().port; // real bound port (supports ephemeral :0)
      this._hosts = allowedHosts(this._port);
      this.isRunning = true;
      this._reaper = setInterval(() => this._reapIdle(), 60_000); this._reaper.unref?.();
      return this._port;
    } catch (e) {
      try { this._http?.close(); } catch {}
      this._http = null; this._token = null; this._controlToken = null; this._port = null; this._hosts = null;
      throw e;
    } finally {
      this._starting = false;
    }
  }

  async stop() {
    if (this._reaper) { clearInterval(this._reaper); this._reaper = null; }
    for (const { server, transport } of this._sessions.values()) {
      try { await server.close(); } catch {}
      try { await transport.close(); } catch {}
    }
    this._sessions.clear();
    if (this._http) {
      const closed = new Promise((r) => this._http.close(r));
      const t = setTimeout(() => { try { this._http?.closeAllConnections?.(); } catch {} }, STOP_GRACE_MS);
      t.unref?.();
      await closed;
      clearTimeout(t);
      this._http = null;
    }
    this._token = null; this._controlToken = null; this._port = null; this._hosts = null; this.isRunning = false;
  }
}
