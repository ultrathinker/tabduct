#!/usr/bin/env node
// Tabduct HUB — one stable MCP endpoint aggregating all live instances.
//
// Reverse-proxy design: the hub is an MCP CLIENT to each direct host (found via
// discovery, authed with that host's own token) and exposes ONE MCP server
// facade (auth = the stable tAgent). It rewrites tab ids to composite
// "<instanceId>:<tabId>" and routes calls to the right instance. Hosts are
// unchanged; consent stays enforced in each extension. Self-exits when idle.

import { writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpHttpServer } from "./mcp-server.js";
import { readAll } from "./discovery.js";
import { ensureSecrets, baseDir } from "./secrets.js";
import { loadCatalog } from "./tools.js";
import { HUB_PORT, ERR, INVOKE_TIMEOUT_MS } from "./constants.js";

const CATALOG = loadCatalog();
const IDLE_EXIT_MS = Number(process.env.TABDUCT_HUB_IDLE_MS) || 60_000;
const POLL_MS = 3_000;
const CALL_TIMEOUT_MS = INVOKE_TIMEOUT_MS + 3_000; // slightly above the instance's own invoke timeout
// Read-only tools are safe to re-issue after a lost transport; everything else may
// have already taken effect, so we don't retry it (avoids double open/close/navigate).
// NOTE: list_network_requests is intentionally NOT here — with clear:true it is
// destructive (a retry after a lost reply would return an already-cleared buffer,
// silently dropping the captured data). get_network_request is a pure read.
const IDEMPOTENT_TOOLS = new Set(["list_tabs", "get_active_tab", "get_page_content", "screenshot", "get_network_request"]);

const textResult = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
const errResult = (code, msg) => ({ isError: true, content: [{ type: "text", text: `${code}: ${msg}` }] });
const codeErr = (code, msg) => Object.assign(new Error(msg), { code });
const parseText = (res) => { try { return JSON.parse(res?.content?.[0]?.text); } catch { return null; } };

// Agent-facing catalog: composite tabId + optional instanceId + list_instances.
function deriveCatalog() {
  const tabRef = { oneOf: [{ type: "integer" }, { type: "string", pattern: "^.+:\\d+$" }], description: 'tabId, or composite "<instanceId>:<tabId>" (from list_tabs)' };
  const tools = CATALOG.tools.map((t) => {
    const s = JSON.parse(JSON.stringify(t.inputSchema || { type: "object", properties: {} }));
    s.properties = s.properties || {};
    if ("tabId" in s.properties) s.properties.tabId = tabRef;
    s.properties.instanceId = { type: "string", description: "Target instance (list_instances); needed when >1 instance and no composite tabId." };
    return { name: t.name, description: `${t.description} [hub]`, inputSchema: s };
  });
  tools.push({ name: "list_instances", description: "List connected browser instances.", inputSchema: { type: "object", properties: {}, additionalProperties: false } });
  return tools;
}

class Hub {
  constructor() {
    this.clients = new Map(); // instanceId -> MCP Client
    this.meta = new Map();    // instanceId -> { label }
    this.server = new McpHttpServer((srv) => this._register(srv));
    this._idle = null; this._poll = null; this.tAgent = null;
  }

  async start() {
    this.tAgent = ensureSecrets().tAgent;
    await this.server.start(HUB_PORT, this.tAgent); // bind = singleton mutex; a 2nd hub throws here
    writeFileSync(resolve(baseDir(), "hub.json"), JSON.stringify({ mcpPort: HUB_PORT, pid: process.pid }), { encoding: "utf8", mode: 0o600 });
    await this._refresh();
    this._poll = setInterval(() => this._refresh().catch(() => {}), POLL_MS); this._poll.unref?.();
    this._armIdle();
    process.stderr.write(`[hub] listening on 127.0.0.1:${HUB_PORT}/mcp\n`);
  }

  _armIdle() {
    clearTimeout(this._idle);
    this._idle = setTimeout(() => { if (this.clients.size === 0) this._shutdown(); else this._armIdle(); }, IDLE_EXIT_MS);
    this._idle.unref?.();
  }

  async _shutdown() {
    if (readAll().length > 0) { this._armIdle(); return; } // an instance appeared during the idle window — abort
    try { rmSync(resolve(baseDir(), "hub.json"), { force: true }); } catch {}
    try { await this.server.stop(); } catch {}
    for (const c of this.clients.values()) { try { await c.close(); } catch {} }
    process.exit(0);
  }

  async _dropClient(id) { const c = this.clients.get(id); this.clients.delete(id); this.meta.delete(id); if (c) { try { await c.close(); } catch {} } }

  // Open (and validate) an MCP client to one instance.
  async _connect(e) {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${e.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${e.token}` } } });
    const client = new Client({ name: "tabduct-hub", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);
    const { tools } = await client.listTools(); // shape check — drop impostor discovery entries
    if (!tools?.some((t) => t.name === "execute_script")) { try { await client.close(); } catch {} throw new Error("not a Tabduct instance"); }
    this.clients.set(e.instanceId, client); this.meta.set(e.instanceId, { label: e.label });
    return client;
  }

  // Reconcile MCP clients with the live discovery registry.
  async _refresh() {
    const live = readAll();
    const ids = new Set(live.map((e) => e.instanceId));
    for (const [id] of [...this.clients]) if (!ids.has(id)) await this._dropClient(id);
    for (const e of live) if (!this.clients.has(e.instanceId)) { try { await this._connect(e); } catch { /* not ready/impostor; retried next poll */ } }
    if (this.clients.size > 0) this._armIdle();
  }

  _withTimeout(p) {
    let t; const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(codeErr(ERR.TIMEOUT, "instance call timed out")), CALL_TIMEOUT_MS); });
    return Promise.race([p.finally(() => clearTimeout(t)), timeout]);
  }

  async _callInstance(instanceId, name, args) {
    if (!this.clients.has(instanceId)) return errResult(ERR.INSTANCE_GONE, `instance ${instanceId} not connected`);
    try {
      return this._rewrite(instanceId, await this._withTimeout(this.clients.get(instanceId).callTool({ name, arguments: args })));
    } catch (e) {
      if (e.code === ERR.TIMEOUT) return errResult(ERR.TIMEOUT, e.message);
      // session lost / instance wedged / TCP reset → drop the client.
      await this._dropClient(instanceId);
      // Only retry READ-ONLY tools: a lost transport after a mutating call may mean
      // the call already ran (only the reply was lost), so re-issuing open_tab /
      // close_tab / navigate / activate_tab / execute_script would double the effect.
      if (!IDEMPOTENT_TOOLS.has(name)) return errResult(ERR.INSTANCE_GONE, `instance ${instanceId} connection lost mid-call; "${name}" not retried (non-idempotent)`);
      const entry = readAll().find((x) => x.instanceId === instanceId);
      if (entry) { try { const c = await this._connect(entry); return this._rewrite(instanceId, await this._withTimeout(c.callTool({ name, arguments: args }))); } catch {} }
      return errResult(ERR.INSTANCE_GONE, `instance ${instanceId} is gone`);
    }
  }

  _register(srv) {
    srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: deriveCatalog() }));
    srv.setRequestHandler(CallToolRequestSchema, async (req) => this._route(req.params.name, req.params.arguments || {}));
  }

  async _route(name, args) {
    try {
      if (name === "list_instances") return textResult({ instances: [...this.meta].map(([instanceId, m]) => ({ instanceId, label: m.label })) });
      if (name === "list_tabs") return await this._listTabsFanout(args);
      const { instanceId, forward } = this._resolveTarget(args);
      return await this._callInstance(instanceId, name, forward);
    } catch (e) {
      return errResult(e.code || ERR.INTERNAL, e.message);
    }
  }

  _resolveTarget(args) {
    if (typeof args.tabId === "string") {
      const i = args.tabId.indexOf(":");
      const instanceId = args.tabId.slice(0, i);
      const sfx = args.tabId.slice(i + 1);
      if (i <= 0 || !/^\d+$/.test(sfx)) throw codeErr(ERR.INVALID_ARGS, 'bad composite tabId (expected "<instanceId>:<n>")');
      const n = Number(sfx);
      if (!Number.isSafeInteger(n)) throw codeErr(ERR.INVALID_ARGS, "tabId out of range");
      const { instanceId: _d, tabId: _t, ...rest } = args;
      return { instanceId, forward: { ...rest, tabId: n } };
    }
    let instanceId = args.instanceId;
    if (!instanceId) {
      if (this.clients.size === 1) instanceId = [...this.clients.keys()][0];
      else throw codeErr(ERR.AMBIGUOUS_INSTANCE, `specify instanceId or a composite tabId (${this.clients.size} instances connected)`);
    }
    const { instanceId: _d, ...forward } = args;
    return { instanceId, forward };
  }

  async _listTabsFanout(args) {
    const { instanceId, ...rest } = args; // never forward instanceId to an instance
    const targets = instanceId ? (this.clients.has(instanceId) ? [instanceId] : []) : [...this.clients.keys()];
    if (instanceId && targets.length === 0) return errResult(ERR.INSTANCE_GONE, `instance ${instanceId} not connected`);
    const out = [];
    await Promise.all(targets.map(async (id) => {
      try {
        const o = parseText(await this._withTimeout(this.clients.get(id).callTool({ name: "list_tabs", arguments: rest })));
        const label = this.meta.get(id)?.label;
        if (o?.tabs) for (const t of o.tabs) { t.id = `${id}:${t.id}`; t.instanceId = id; t.instanceLabel = label; out.push(t); }
      } catch { /* one instance failing shouldn't sink the fan-out */ }
    }));
    return textResult({ tabs: out });
  }

  _rewrite(instanceId, res) {
    if (res?.isError || !Array.isArray(res?.content)) return res; // errors / image blocks pass through
    const label = this.meta.get(instanceId)?.label;
    for (const c of res.content) {
      if (c.type !== "text") continue;
      let o; try { o = JSON.parse(c.text); } catch { continue; }
      if (o && typeof o === "object") {
        if (typeof o.id === "number") { o.id = `${instanceId}:${o.id}`; o.instanceId = instanceId; o.instanceLabel = label; }
        if (typeof o.closed === "number") o.closed = `${instanceId}:${o.closed}`;
        if (Array.isArray(o.tabs)) for (const t of o.tabs) if (typeof t.id === "number") { t.id = `${instanceId}:${t.id}`; t.instanceId = instanceId; t.instanceLabel = label; }
        c.text = JSON.stringify(o);
      }
    }
    return res;
  }
}

export async function runHub() { const h = new Hub(); await h.start(); return h; }

if (process.argv[1] && (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1])) {
  runHub().catch((e) => {
    const bindLoss = /EADDRINUSE/.test(e?.message || "");
    process.stderr.write(bindLoss ? "[hub] another hub already owns the port; exiting\n" : `[hub] fatal: ${e.message}\n`);
    process.exit(bindLoss ? 0 : 1); // loser exits 0 (the bind is the singleton mutex)
  });
}
