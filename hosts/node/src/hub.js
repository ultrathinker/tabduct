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
import { loadCatalog, requiredFeatures } from "./tools.js";
import { HUB_PORT, ERR, INVOKE_TIMEOUT_MS, invokeTimeoutMs } from "./constants.js";

const CATALOG = loadCatalog();
const IDLE_EXIT_MS = Number(process.env.TABDUCT_HUB_IDLE_MS) || 60_000;
const SHUTDOWN_GRACE_MS = 3_000; // hard cap on idle shutdown: exit even if a close() hangs, so we never linger as a port-holding zombie
const POLL_MS = 3_000;
const CALL_TIMEOUT_MS = INVOKE_TIMEOUT_MS + 3_000; // slightly above the instance's own invoke timeout (per call: callBudget)
const callBudget = (tool, args) => invokeTimeoutMs(tool, args) + 3_000;
const CONNECT_TIMEOUT_MS = 5_000; // a host that doesn't answer its MCP handshake this fast is retried on the next poll
const CONTROL_TIMEOUT_MS = 5_000; // popup control calls (snapshot/unshare) are quick + the popup polls every 2.5s; don't hold zombie fan-outs for 23s
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
// `defs` = the tools the connected hosts actually serve (a hub can outlive many `git pull`s, and
// its own copy of the catalog is read once at start-up); falls back to the local catalog while
// no instance is connected.
function deriveCatalog(defs) {
  const tabRef = { oneOf: [{ type: "integer" }, { type: "string", pattern: "^.+:\\d+$" }], description: 'tabId, or composite "<instanceId>:<tabId>" (from list_tabs)' };
  const tools = (defs && defs.length ? defs : CATALOG.tools).map((t) => {
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
    this.meta = new Map();    // instanceId -> { label, fp, extensionVersion, features }
    this.toolDefs = new Map(); // instanceId -> the tools that host serves (tools/list)
    this._refreshing = false;
    this._connecting = new Map(); // instanceId -> in-flight connect promise
    this.server = new McpHttpServer((srv) => this._register(srv), (method, body) => this._control(method, body));
    this._idle = null; this._poll = null; this.tAgent = null; this.tControl = null;
  }

  async start() {
    const secrets = ensureSecrets();
    this.tAgent = secrets.tAgent;
    this.tControl = secrets.tControl;
    await this.server.start(HUB_PORT, this.tAgent, this.tControl); // bind = singleton mutex; a 2nd hub throws here
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
    // Failsafe: NEVER let a hung close() (a dead MCP client / stuck server.close) leave us
    // half-dead — still bound to HUB_PORT but past the point of no return. That zombie state
    // (a listener answering HTTP with a stale/removed hub.json) is exactly what wedges the
    // host's ensureHub and makes Start fail with no recovery. So guarantee the exit: after a
    // short grace, drop hub.json and exit hard regardless — the OS reclaims the port on exit.
    const bail = setTimeout(() => {
      try { rmSync(resolve(baseDir(), "hub.json"), { force: true }); } catch {}
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    bail.unref?.();
    try { await this.server.stop(); } catch {}
    for (const c of this.clients.values()) { try { await c.close(); } catch {} }
    clearTimeout(bail);
    // Remove hub.json LAST — only once the listener is actually down — so we never advertise
    // "no hub here" while still holding the port.
    try { rmSync(resolve(baseDir(), "hub.json"), { force: true }); } catch {}
    process.exit(0);
  }

  // `only`: drop the client only if it is still THE client of that instance (a call that failed on
  // an old client must not tear down the fresh one a concurrent reconnect has installed meanwhile).
  async _dropClient(id, only) {
    const c = this.clients.get(id);
    if (only && c !== only) { try { await only.close(); } catch {} return; }
    this.clients.delete(id); this.meta.delete(id); this.toolDefs.delete(id);
    if (c) { try { await c.close(); } catch {} }
  }

  // What identifies one incarnation of an instance. A host that restarts keeps its instanceId but
  // gets a new port/token/pid: a client built for the old incarnation is dead, and without this
  // check the hub kept it forever (list_tabs silently empty, calls failing as INSTANCE_GONE).
  static fingerprint(e) { return `${e.port}|${e.pid}|${e.token}`; }

  // Open (and validate) an MCP client to one instance. Bounded: a wedged host must not hold a
  // poll cycle (or pile up connections) for the SDK's default 60 s.
  // One connect per instance at a time (the poll and a call that lost its client both reconnect):
  // a second concurrent connect would overwrite the first client and leave it open for ever.
  _connect(e) {
    let p = this._connecting.get(e.instanceId);
    if (!p) { p = this._connectNew(e).finally(() => this._connecting.delete(e.instanceId)); this._connecting.set(e.instanceId, p); }
    return p;
  }
  async _connectNew(e) {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${e.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${e.token}` } } });
    const client = new Client({ name: "tabduct-hub", version: "0.0.1" }, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      const { tools } = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS }); // shape check — drop impostor discovery entries
      if (!tools?.some((t) => t.name === "execute_script")) throw new Error("not a Tabduct instance");
      this.clients.set(e.instanceId, client);
      this.meta.set(e.instanceId, { label: e.label, fp: Hub.fingerprint(e), extensionVersion: e.extensionVersion ?? null, features: Array.isArray(e.features) ? e.features : [] });
      this.toolDefs.set(e.instanceId, tools);
    } catch (err) { try { await client.close(); } catch {} throw err; }
    return client;
  }

  // Reconcile MCP clients with the live discovery registry. Never overlaps itself: a slow
  // connect used to let the next 3 s tick start a second connect to the same instance, leaking
  // the loser's client.
  async _refresh() {
    if (this._refreshing) return;
    this._refreshing = true;
    try {
      const live = readAll();
      const ids = new Set(live.map((e) => e.instanceId));
      for (const [id] of [...this.clients]) if (!ids.has(id)) await this._dropClient(id);
      for (const e of live) {
        const m = this.meta.get(e.instanceId);
        if (this.clients.has(e.instanceId) && m && m.fp !== Hub.fingerprint(e)) await this._dropClient(e.instanceId); // host restarted under the same id
        if (!this.clients.has(e.instanceId)) { try { await this._connect(e); } catch { /* not ready/impostor; retried next poll */ } }
        else if (m) { m.label = e.label; m.extensionVersion = e.extensionVersion ?? null; m.features = Array.isArray(e.features) ? e.features : m.features; } // a rename / reload shows up without reconnecting
      }
      if (this.clients.size > 0) this._armIdle();
    } finally { this._refreshing = false; }
  }

  _withTimeout(p, ms = CALL_TIMEOUT_MS) {
    let t; const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(codeErr(ERR.TIMEOUT, "instance call timed out")), ms); });
    return Promise.race([p.finally(() => clearTimeout(t)), timeout]);
  }

  async _callInstance(instanceId, name, args) {
    if (!this.clients.has(instanceId)) return errResult(ERR.INSTANCE_GONE, `instance ${instanceId} not connected`);
    const budget = callBudget(name, args);
    const client = this.clients.get(instanceId);
    try {
      return this._rewrite(instanceId, await this._withTimeout(client.callTool({ name, arguments: args }), budget));
    } catch (e) {
      if (e.code === ERR.TIMEOUT) return errResult(ERR.TIMEOUT, e.message);
      // session lost / instance wedged / TCP reset → drop the client.
      await this._dropClient(instanceId, client);
      // Only retry READ-ONLY tools: a lost transport after a mutating call may mean
      // the call already ran (only the reply was lost), so re-issuing open_tab /
      // close_tab / navigate / activate_tab / execute_script would double the effect.
      if (!IDEMPOTENT_TOOLS.has(name)) return errResult(ERR.INSTANCE_GONE, `instance ${instanceId} connection lost mid-call; "${name}" not retried (non-idempotent)`);
      const entry = readAll().find((x) => x.instanceId === instanceId);
      if (entry) { try { const c = await this._connect(entry); return this._rewrite(instanceId, await this._withTimeout(c.callTool({ name, arguments: args }), budget)); } catch {} }
      return errResult(ERR.INSTANCE_GONE, `instance ${instanceId} is gone`);
    }
  }

  _register(srv) {
    srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: deriveCatalog([...new Map([...this.toolDefs.values()].flat().map((t) => [t.name, t])).values()]) }));
    srv.setRequestHandler(CallToolRequestSchema, async (req) => this._route(req.params.name, req.params.arguments || {}));
  }

  async _route(name, args) {
    try {
      // Internal `_td/*` ops (sharing snapshot/unshare) are reachable ONLY via the
      // /control channel — never the agent-facing MCP path. Refuse them here so an
      // agent holding tAgent can't snapshot or unshare across browsers.
      if (typeof name === "string" && name.startsWith("_td/")) return errResult(ERR.UNKNOWN_TOOL, `Unknown tool: ${name}`);
      if (name === "list_instances") return textResult({ instances: [...this.meta].map(([instanceId, m]) => ({ instanceId, label: m.label, extensionVersion: m.extensionVersion ?? null, features: m.features ?? [] })) });
      if (name === "list_tabs") return await this._listTabsFanout(args);
      const { instanceId, forward } = this._resolveTarget(args);
      // The host in front of an instance may be an older build (it outlives a `git pull` just like
      // the hub does): such a host doesn't gate, and its extension would run a call that needs a
      // newer feature somewhere else (a frameId ignored -> the top page). The discovery entry says
      // which features that instance has, so refuse here as well.
      const m = this.meta.get(instanceId);
      if (m) {
        const have = new Set(m.features ?? []);
        const missing = [...requiredFeatures(name, forward)].filter((f) => !have.has(f));
        if (missing.length) return errResult(ERR.EXTENSION_OUTDATED, `the Tabduct host or extension behind instance ${instanceId} (${m.extensionVersion ? `extension v${m.extensionVersion}` : "a build that predates version reporting"}) doesn't support: ${missing.join(", ")}. Nothing was run. Ask the user to restart the Tabduct host and reload the extension at chrome://extensions (Tabduct -> reload).`);
      }
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
      else {
        const who = [...this.clients.keys()].map((id) => `${this.meta.get(id)?.label ?? "?"} = ${id}`).join("; ");
        throw codeErr(ERR.AMBIGUOUS_INSTANCE, `${this.clients.size} browsers are connected, so say which one: pass instanceId, or use the composite tabId "<instanceId>:<tabId>" exactly as list_tabs returns it (${who})`);
      }
    }
    const { instanceId: _d, ...forward } = args;
    return { instanceId, forward };
  }

  // Live discovery entries the hub holds no client for (a connect that failed, a client just
  // dropped): they exist and may well hold grants, so they must show up as "unavailable", never
  // vanish from an answer or from a "revoke all".
  _unconnected() {
    let live; try { live = readAll(); } catch { return []; }
    return live.filter((e) => !this.clients.has(e.instanceId)).map((e) => ({ instanceId: e.instanceId, label: e.label }));
  }

  async _listTabsFanout(args) {
    const { instanceId, ...rest } = args; // never forward instanceId to an instance
    const targets = instanceId ? (this.clients.has(instanceId) ? [instanceId] : []) : [...this.clients.keys()];
    if (instanceId && targets.length === 0) return errResult(ERR.INSTANCE_GONE, `instance ${instanceId} not connected`);
    const out = [], unavailable = [];
    if (!instanceId) for (const u of this._unconnected()) unavailable.push({ instanceId: u.instanceId, label: u.label, error: "not connected to the hub (retrying)" });
    await Promise.all(targets.map(async (id) => {
      const label = this.meta.get(id)?.label;
      // _callInstance drops a dead client and (list_tabs is idempotent) reconnects once. One
      // instance failing must not sink the fan-out, but it must not vanish silently either: an
      // empty answer reads as "nothing shared", which is a different (and wrong) statement.
      const res = await this._callInstance(id, "list_tabs", rest);
      const o = res?.isError ? null : parseText(res);
      if (o?.tabs) out.push(...o.tabs);
      else unavailable.push({ instanceId: id, label, error: String(res?.content?.[0]?.text ?? "no reply").slice(0, 200) });
    }));
    return textResult(unavailable.length ? { tabs: out, unavailable, note: "some browsers did not answer; their tabs are missing from this list (they are not necessarily unshared)" } : { tabs: out });
  }

  // /control handler (popup-driven, tControl-authed, NOT the agent path).
  //  GET  → { instances: [{ instanceId, label, tier, sharedCount, tabs, activeTabId }] }
  //  POST → { op: "unshare", instanceId, tabId } | { op: "stopAll", instanceId }
  // Tab ids stay per-instance numeric (the popup pairs them with instanceId — no
  // composite rewrite here). One instance failing never sinks the whole snapshot.
  async _control(method, body) {
    if (method === "GET") {
      const instances = [];
      for (const u of this._unconnected()) instances.push({ instanceId: u.instanceId, label: u.label ?? null, tier: "unknown", sharedCount: 0, tabs: [], unavailable: true });
      await Promise.all([...this.clients.keys()].map(async (id) => {
        const label = this.meta.get(id)?.label ?? null;
        try {
          const raw = await this._withTimeout(this.clients.get(id).callTool({ name: "_td/snapshot", arguments: {} }), CONTROL_TIMEOUT_MS);
          const snap = raw?.isError ? null : parseText(raw);
          // isError / unparsable = an instance that doesn't implement `_td/snapshot`
          // (a non-Node host, or a pre-feature build) → mark unknown, don't imply "nothing shared".
          if (!snap) instances.push({ instanceId: id, label, tier: "unknown", sharedCount: 0, tabs: [], unavailable: true });
          else instances.push({ instanceId: id, label, tier: snap.tier ?? "none", sharedCount: snap.sharedCount ?? 0, tabs: Array.isArray(snap.tabs) ? snap.tabs : [], activeTabId: snap.activeTabId ?? null });
        } catch { instances.push({ instanceId: id, label, tier: "unknown", sharedCount: 0, tabs: [], unavailable: true }); }
      }));
      return { status: 200, json: { instances } };
    }
    if (method === "POST") {
      const { op, instanceId, tabId, exceptInstanceId } = body || {};
      // Fan-out op: clear sharing on every instance except the caller (which clears itself locally).
      if (op === "revokeAll") {
        // Report what really happened: claiming success while another browser kept sharing is
        // the one outcome this button must never produce.
        const failed = [];
        const names = new Map();
        await this._refresh().catch(() => {}); // pick up an instance that appeared (or failed to connect) since the last poll
        await Promise.all([...this.clients.keys()].filter((id) => id !== exceptInstanceId).map(async (id) => {
          names.set(id, this.meta.get(id)?.label ?? id);
          try {
            const r = await this._withTimeout(this.clients.get(id).callTool({ name: "_td/revoke_all", arguments: {} }), CONTROL_TIMEOUT_MS);
            if (r?.isError) failed.push(id);
          } catch { failed.push(id); }
        }));
        // A live browser the hub could not reach still holds its grants: that is not a success.
        for (const u of this._unconnected()) if (u.instanceId !== exceptInstanceId) { failed.push(u.instanceId); names.set(u.instanceId, u.label ?? u.instanceId); }
        if (failed.length) return { status: 502, json: { ok: false, error: `could not confirm in: ${failed.map((id) => names.get(id) ?? id).join(", ")}`, failed } };
        return { status: 200, json: { ok: true } };
      }
      if (!instanceId || !this.clients.has(instanceId)) return { status: 404, json: { error: "instance not connected" } };
      try {
        let r;
        if (op === "unshare") {
          if (!Number.isInteger(tabId)) return { status: 400, json: { error: "tabId must be an integer" } };
          r = await this._withTimeout(this.clients.get(instanceId).callTool({ name: "_td/unshare", arguments: { tabId } }), CONTROL_TIMEOUT_MS);
        } else if (op === "stopAll") {
          r = await this._withTimeout(this.clients.get(instanceId).callTool({ name: "_td/set_tier", arguments: { tier: "none" } }), CONTROL_TIMEOUT_MS);
        } else return { status: 400, json: { error: "unknown op" } };
        // The extension answers a failed op with isError, not by throwing: don't tell the popup it worked.
        if (r?.isError) return { status: 502, json: { error: String(r?.content?.[0]?.text ?? "the browser refused the request").slice(0, 200) } };
        return { status: 200, json: { ok: true } };
      } catch (e) { return { status: 502, json: { error: e?.message || "control call failed" } }; }
    }
    return { status: 405, json: { error: "method not allowed" } };
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
