// Tabduct extension — background service worker.
//
// Owns: the native-messaging connection + lifecycle (open/close/ping), the
// invoke chokepoint with per-tab CONSENT enforcement (Feature B), shared-tab
// badges, the share hotkey, and popup messaging. See PROTOCOL.md + consent.js.

import { HANDLERS, withCallDeadline, thawIfFrozen, thawTraceOf, releaseThaw, detachCdpTab, detachAllCdp, startCdpConsole, stopCdpConsole, stopAllCdpConsole, reconcileCdpForce, cdpConsoleTabs, cdpUserCancelled } from "./handlers/index.js";
import * as CONSENT from "./consent.js";
import { GroupMask, groupAction } from "./groupsync.js";
import { WAKE_TOOLS, QUIET_TOOLS, wake as wakeTab, release as releaseTab } from "./wake.js";

const HOST_NAME = "com.tabduct.host";
const DEFAULT_PORT = 0; // 0 = ephemeral: the host picks a free port (no manual port config)
const HUB_PORT = 12311; // the shared hub's fixed endpoint (must match hosts' constants)
const PROTOCOL_VERSION = 0; // MUST match protocol/tools.schema.json
// Must outlast the host's own wait for the hub to come up (~13.5 s on a cold start), or Start
// reports a timeout while the hub is still coming up fine.
const OPEN_TIMEOUT_MS = 20000;
// What this build can do beyond the base protocol. Sent in `open`; the host refuses calls that
// need a feature an older extension build doesn't have (instead of silently running them
// elsewhere — e.g. a frameId ignored by a build that predates frames).
const FEATURES = ["frames", "pinned-docs", "cdp-input", "wait-text", "quiet"];
const EXT_VERSION = chrome.runtime.getManifest().version;

// Is a shared hub already listening on this machine? (any HTTP response = up; connection
// refused = down). Used to auto-join a new instance to an already-running hub.
async function hubReachable() {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 700);
  try {
    await fetch(`http://127.0.0.1:${HUB_PORT}/mcp`, { method: "GET", signal: c.signal });
    c.abort(); // any HTTP response means a hub is listening — close the (possibly streamed) body
    return true;
  } catch { return false; } finally { clearTimeout(t); }
}

/** @type {chrome.runtime.Port | null} */
let hostPort = null;
const pending = new Map();

// ---------------------------------------------------------------------------
// Persisted connection state (popup source of truth + restart recovery)

async function setState(patch) {
  const cur = (await chrome.storage.session.get("tabduct")).tabduct ?? {};
  const next = { ...cur, ...patch };
  await chrome.storage.session.set({ tabduct: next });
  chrome.runtime.sendMessage({ evt: "status", ...next }).catch(() => {});
  updateContextMenu(); // connection state changed → show/hide the right-click item
  return next;
}
async function getConnState() { return (await chrome.storage.session.get("tabduct")).tabduct ?? { state: "disconnected" }; }

// Stable per-instance identity + token (both persist in storage.local so the
// agent's pasted endpoint+token survive reconnects), plus a user label.
// 4 random lowercase letters, e.g. "kqtz" — appended to the default label so
// several browsers under the hub are distinguishable without manual naming.
function labelSuffix() {
  const a = new Uint8Array(4); crypto.getRandomValues(a);
  return Array.from(a, (b) => String.fromCharCode(97 + (b % 26))).join("");
}
async function getIdentity() {
  const g = await chrome.storage.local.get(["instanceId", "instanceLabel", "token"]);
  const patch = {};
  let instanceId = g.instanceId, token = g.token, label = g.instanceLabel;
  if (!instanceId) { instanceId = crypto.randomUUID(); patch.instanceId = instanceId; }
  if (!token) { token = crypto.randomUUID(); patch.token = token; }
  if (!label) { label = `Chrome-${labelSuffix()}`; patch.instanceLabel = label; } // auto default when unset
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  return { instanceId, label, token };
}

// ---------------------------------------------------------------------------
// Native messaging connection + lifecycle

let connecting = null, connGen = 0;
function connect(port = DEFAULT_PORT) {
  if (hostPort) return getConnState();
  if (connecting) return connecting; // sync guard set BEFORE any await → no double-spawn race
  const gen = ++connGen; // a Disconnect during this connect bumps connGen and invalidates us
  connecting = (async () => {
    chrome.storage.session.set({ userStopped: false }).catch(() => {}); // a (re)connect clears the explicit-stop intent
    const { instanceId, label, token } = await getIdentity();
    // Always an ephemeral port: agents only ever see the hub (the per-instance direct port is an
    // implementation detail the hub reads from the discovery file), so remembering one only
    // risked reusing a port that had since become busy or reserved (a permanent Start failure).
    const usePort = port;
    await setState({ state: "connecting", port: usePort, token, error: null });
    let thisPort;
    try { thisPort = chrome.runtime.connectNative(HOST_NAME); hostPort = thisPort; }
    catch (e) { await setState({ state: "error", error: String(e) }); return getConnState(); }

    // Everything below is bound to THIS port: a late event from a port we already replaced
    // (quick Stop → Start) must neither tear down the new connection nor be answered on it.
    thisPort.onMessage.addListener((m) => { if (hostPort === thisPort) onHostMessage(m); });
    thisPort.onDisconnect.addListener(async () => {
      const err = chrome.runtime.lastError;
      if (hostPort !== thisPort) return;
      hostPort = null; rejectAllPending("native host disconnected");
      await detachAllCdp(); // port dropped → drop any held debugger sessions (PART 4)
      await setState({ state: err ? "error" : "disconnected", error: err ? err.message : null });
      scheduleBadges(); // port dropped → red icons
    });

    try {
      // Hub is the ONLY agent-facing endpoint — always request it (the toggle is gone).
      const res = await request("open", { port: usePort, token, protocolVersion: PROTOCOL_VERSION, instanceId, label, hub: true, extensionVersion: EXT_VERSION, features: FEATURES }, OPEN_TIMEOUT_MS);
      if (gen !== connGen) { // user hit Disconnect while we were handshaking → honor it
        try { thisPort.disconnect(); } catch {} if (hostPort === thisPort) hostPort = null; rejectAllPending("disconnected during connect");
        await setState({ state: "disconnected", error: null }); scheduleBadges(); return getConnState();
      }
      // The shared hub is REQUIRED. If it didn't come up, surface a LOUD error instead of
      // silently exposing the per-instance direct port (which used to confuse everyone).
      if (!(res?.hub && res.endpoint)) throw new Error("Couldn't start the shared hub — see ~/.tabduct/hub.log");
      await setState({ state: "connected", port: res.port ?? usePort, error: null, hub: true, endpoint: res.endpoint, token: res.token });
      chrome.storage.local.set({ everConnected: true }).catch(() => {}); // retires the one-time first-run "Set up with your AI" button
      try { await chrome.action.setBadgeBackgroundColor({ color: "#2ecc71" }); chrome.action.setBadgeTextColor?.({ color: "#2ecc71" }); } catch {}
      lastBadge = new Map();
      await refreshBadges();
    } catch (e) {
      try { thisPort.disconnect(); } catch {}
      if (hostPort === thisPort) hostPort = null;
      await setState({ state: "error", error: e?.message ?? String(e) });
      scheduleBadges(); // failed connect → red icons
    }
    return getConnState();
  })();
  return connecting.finally(() => { connecting = null; });
}

// Re-attach after a service-worker eviction/revival, AND auto-join an already-running hub.
async function ensureConnected() {
  if (hostPort || connecting) return;
  const s = await getConnState();
  if (s.state === "connected") { await connect(0).catch(() => {}); return; } // revive after SW eviction
  // Auto-join: if a shared hub is already running (another instance started it) and the
  // user hasn't explicitly Stopped THIS instance THIS session, connect automatically —
  // no Start needed. `userStopped` lives in SESSION storage, so an explicit Stop is sticky
  // across popup reopens / SW eviction, but a full extension reload/disable or a browser
  // restart clears it (a fresh start re-enables auto-join).
  const { userStopped } = await chrome.storage.session.get("userStopped");
  if (!userStopped && (await hubReachable())) await connect(0).catch(() => {});
}

async function disconnect() {
  connGen++; // invalidate any in-flight connect so it can't flip us back to "connected"
  chrome.storage.session.set({ userStopped: true }).catch(() => {}); // explicit Stop → don't auto-rejoin (this session)
  if (hostPort) { try { await request("close", {}, 3000); } catch {} try { hostPort.disconnect(); } catch {} hostPort = null; }
  rejectAllPending("disconnected by user");
  await detachAllCdp(); // release any held debugger sessions (PART 4)
  await setState({ state: "disconnected", error: null });
  scheduleBadges(); // repaint icons → red (not connected)
  return getConnState();
}

function request(type, payload, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!hostPort) return reject(new Error("Native host not connected"));
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`"${type}" timed out`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { hostPort.postMessage({ type, id, payload }); }
    catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
  });
}
function rejectAllPending(reason) { for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); } pending.clear(); }

function emitEvent(payload) { try { hostPort?.postMessage({ type: "event", payload }); } catch {} }

// ---------------------------------------------------------------------------
// Messages FROM the host

async function onHostMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (typeof msg.replyTo === "string") {
    const p = pending.get(msg.replyTo);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(msg.replyTo);
    if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error?.message || msg.error?.code || "request failed"));
    return;
  }
  if (msg.type === "invoke") return handleInvoke(msg);
  if (msg.type === "notice") { const lvl = msg.payload?.level; if (lvl === "warn" || lvl === "error") await setState({ error: msg.payload?.message ?? null }); return; } // info notices aren't errors
}

// Chrome lets us send the host up to 64 MiB, but the host drops anything over 32 MiB without a
// word (it can't even read the replyTo to answer), which the agent then sees as a 20 s TIMEOUT.
// Measure big replies here and answer with a clear error instead.
const MAX_REPLY_BYTES = 30 * 1024 * 1024;
function replyTooLarge(msg) {
  let s; try { s = JSON.stringify(msg); } catch { return false; }
  if (s.length <= 10_000_000) return false; // <= 3 bytes/char < the cap: no need to measure exactly
  return new TextEncoder().encode(s).length > MAX_REPLY_BYTES;
}
function reply(id, ok, payload) {
  if (!hostPort) return;
  let msg = ok ? { replyTo: id, ok: true, result: payload } : { replyTo: id, ok: false, error: payload };
  if (replyTooLarge(msg)) msg = { replyTo: id, ok: false, error: { code: "FRAME_TOO_LARGE", message: "the result is larger than the 30 MiB transport limit; ask for less (maxChars, a selector, a smaller format)" } };
  hostPort.postMessage(msg);
}

// ---------------------------------------------------------------------------
// Consent chokepoint

async function resolveActiveTabId() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id;
}

// Decide whether a tab-targeting/create tool may run; handle sticky-origin revoke.
const pausedNow = new Set(); // tabs we already reported as paused (one event per pause, not per refused call)
async function gate(tool, args) {
  const state = await CONSENT.getState();
  // Destination guard for tools carrying a target URL: only http(s), never a
  // denylisted/allow-list-blocked origin (and don't disclose which). Blocks file:/data:/javascript:.
  // The origin filter is judged only AFTER the call is authorized: asked first, ORIGIN_DENIED vs
  // NOT_SHARED would let a caller with no access probe which sites are on the user's list.
  let destHost, destBlocked = false;
  if ((tool === "navigate" || tool === "open_tab") && args?.url) {
    let scheme = null; try { scheme = new URL(args.url).protocol; } catch {}
    if (scheme !== "http:" && scheme !== "https:") return { allow: false, code: "INVALID_ARGS", message: "only http(s) destinations are allowed" };
    destHost = CONSENT.hostOf(args.url);
    destBlocked = CONSENT.originBlocked(state, destHost);
    if (tool === "open_tab") destHost = undefined; // a NEW tab isn't bound by the lock of an existing one
  }
  const DEST_DENIED = { allow: false, code: "ORIGIN_DENIED", message: "destination not allowed by consent policy" };

  if (CONSENT.CREATE.has(tool)) {
    const d = { ...CONSENT.evaluate(state, { tool }), silent: state.silent };
    return d.allow && destBlocked ? DEST_DENIED : d;
  }

  let tabId = typeof args?.tabId === "number" ? args.tabId : await resolveActiveTabId();
  if (tabId == null) return { allow: false, code: "TAB_NOT_FOUND", message: "no active tab" };
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return { allow: false, code: "TAB_NOT_FOUND", message: `tab ${tabId} not found` }; }
  const host = CONSENT.hostOf(tab.url);
  const needCap = (tool === "screenshot" && args?.activate) ? "execute" : undefined; // activating steals focus → treat as write
  const d = CONSENT.evaluate(state, { tool, tabId, host, now: Date.now(), needCap, destHost });
  if (d.revoke) { await CONSENT.unshareTab(tabId); detachCdpTab(tabId); emitEvent({ kind: "permission_revoked", tabId, reason: d.code }); scheduleBadges(); } // an EXPIRED share
  if (d.allow && destBlocked) return DEST_DENIED; // authorized caller, forbidden destination
  // A tab that left its shared origin is PAUSED, not unshared: refuse the call, stop capturing
  // what it does elsewhere (debugger + buffers), keep the grant so access resumes on return.
  if (d.code === "ORIGIN_DRIFT") {
    detachCdpTab(tabId);
    if (!pausedNow.has(tabId)) { pausedNow.add(tabId); emitEvent({ kind: "permission_paused", tabId, reason: d.code }); scheduleBadges(); chrome.runtime.sendMessage({ evt: "sharing" }).catch(() => {}); }
  } else if (d.allow) pausedNow.delete(tabId);
  // execute_script CDP gating (PART 4): compute the effective engine + whether the
  // auto CSP→CDP fallback is allowed, from the user's CDP settings. Only when base
  // consent already allowed the call — otherwise a consent denial (e.g. read-only)
  // must surface as-is, not be masked by CDP_NOT_PERMITTED. Force/always CDP
  // requires allowCdp AND not read-only; refused BEFORE any debugger attach.
  // The origin the call is PINNED to inside the page: the host the tab was authorized on, when
  // lock-to-domain is on and this is a per-tab share (null = a blank page). Undefined = not
  // pinned (lock off, or the "Everything" tier): the page tools then only apply the origin filter.
  const pin = state.lockToDomain && state.tier === "tabs" ? host : undefined;
  // May the agent bring the window forward for this tab? (the tab's own setting, the default for tabs without one, and
  // Silent mode over all of it.) Explicit requests to take the focus are held to the same rule as the automatic wake.
  const wakeOk = CONSENT.wakeAllowed(state, tabId);
  if (d.allow && !wakeOk && (tool === "activate_tab" || (tool === "screenshot" && args?.activate === true && !tab.active))) {
    return { allow: false, tabId, code: "WAKE_NOT_ALLOWED", message: `bringing this tab to the front is turned off (${state.silent ? "Silent mode is on" : "the user disabled waking for this tab"} in the Tabduct popup): work with the tab where it is, or ask the user` };
  }
  const out = { ...d, tabId, host, pin, wake: wakeOk, thaw: state.allowCdp === true };
  if (tool === "execute_script" && d.allow) {
    const cd = CONSENT.cdpDecision(state, { engine: args?.engine });
    if (!cd.permitted) return { allow: false, code: cd.code, message: "CDP eval is not enabled (enable 'Allow CDP eval' in the popup, or switch engine to auto/scripting)" };
    out._engine = cd.engine; // effective engine the handler must run
    out._allowCdp = state.allowCdp === true; // authorizes the auto CSP→CDP fallback
    out._cdpAlways = state.allowCdp === true && state.cdpAlways === true; // keep the tab attached (force mode)
  }
  // Trusted input (CDP Input.*: click/type with trusted:true, press_key) drives the page through
  // the debugger, so it needs the same opt-in as CDP eval — refused BEFORE any debugger attach,
  // and only for tools that allow it. The handlers re-check `_trusted` (set only here).
  if (d.allow && (tool === "press_key" || ((tool === "type" || tool === "click") && args?.trusted))) {
    const cd = CONSENT.cdpDecision(state, { engine: "cdp" });
    if (!cd.permitted) return { allow: false, code: cd.code, message: "trusted input drives the page through the browser's debugger: turn on 'Allow CDP eval' in the Tabduct popup and turn read-only off" };
    out._trusted = true;
  }
  return out; // resolved ONCE — the handler reuses this exact tab + authorized host (no TOCTOU re-resolve)
}

async function handleInvoke(msg) {
  const { id, payload } = msg;
  const tool = payload?.tool;
  // `_`-prefixed args are internal (set below from the consent gate: _pin,
  // _engine, …) — never accept them from the wire, where an agent could forge one.
  const args = Object.fromEntries(Object.entries(payload?.args ?? {}).filter(([k]) => !k.startsWith("_")));
  // Internal `_td/*` control ops arrive only via the hub's /control channel (never
  // the agent). They are USER sharing actions (snapshot / unshare / stop-all), so they
  // bypass the per-tool consent gate — they can only REDUCE what's shared, never grant.
  if (typeof tool === "string" && tool.startsWith("_td/")) return handleControlInvoke(id, tool, args);
  // Defense-in-depth: a direct host must only ever see a numeric tabId (composite
  // "inst:n" ids are resolved by the hub and never reach here).
  if (args.tabId != null && typeof args.tabId !== "number") { reply(id, false, { code: "INVALID_ARGS", message: "tabId must be a number" }); return; }
  try {
    // Enumerate tools: run + FILTER to shared tabs (never leak unshared titles/URLs).
    // Owned HERE (not in HANDLERS) so there is exactly one filtered path.
    if (CONSENT.ENUMERATE.has(tool)) {
      const state = await CONSENT.getState();
      const { label } = await getIdentity(); // surface the human label as a field, so the agent names this browser even in direct (non-hub) mode
      const withLabel = (t) => ({ ...tabInfo(t), ...(CONSENT.wakeAllowed(state, t.id) ? {} : { wakeAllowed: false }), instanceLabel: label });
      const q = (tool === "list_tabs" && args?.currentWindowOnly) ? { lastFocusedWindow: true } : {};
      const all = await chrome.tabs.query(q);
      const visible = CONSENT.visibleTabIds(state, all, Date.now());
      if (tool === "get_active_tab") {
        const [act] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!act || !visible.some((t) => t.id === act.id)) { reply(id, false, { code: "NOT_SHARED", message: "the active tab is not shared" }); flashDenied(act?.id); return; }
        reply(id, true, withLabel(act));
      } else {
        reply(id, true, { tabs: visible.map(withLabel), instanceLabel: label });
      }
      return;
    }

    const handler = HANDLERS[tool];
    if (!handler) { reply(id, false, { code: "UNKNOWN_TOOL", message: `Unknown tool: ${tool}` }); return; }

    // `quiet`: the caller asks that its user's window is NEVER raised for this call (scheduled checks while the
    // user plays or presents). A screenshot of a background tab that asks to be activated contradicts that.
    const quiet = args.quiet === true && QUIET_TOOLS.has(tool);
    if (quiet && args.activate === true) { reply(id, false, { code: "INVALID_ARGS", message: "quiet and activate contradict each other: activating a tab raises the window" }); return; }

    const decision = await gate(tool, args);
    if (!decision.allow) { reply(id, false, { code: decision.code, message: decision.message }); flashDenied(decision.tabId); return; }

    // Reuse the exact tab the gate authorized (prevents active-tab TOCTOU).
    let callArgs = decision.tabId == null ? args : { ...args, tabId: decision.tabId };
    // Silent mode: a new ACTIVE tab takes the window's focus, so the tab opens in the background instead.
    const silentOpen = tool === "open_tab" && decision.silent === true && callArgs.active !== false;
    if (silentOpen) callArgs = { ...callArgs, active: false };
    // The pin (see gate) rides along to EVERY tool, not a hand-kept list: a tool someone adds
    // later can't silently lose lock-to-domain by being left out. Handlers that act inside a
    // page probe the document and judge it against it (handlers/index.js, pinFrame). `_pin` is
    // internal: stripped from wire args above and never returned.
    if (decision.pin !== undefined) callArgs._pin = decision.pin;
    // execute_script engine/CDP flags (PART 4): passed internal-only from the gate.
    if (decision._trusted) callArgs._trusted = true;
    if (tool === "execute_script") {
      if (decision._engine != null) callArgs._engine = decision._engine;
      if (decision._allowCdp != null) callArgs._allowCdp = decision._allowCdp;
      if (decision._cdpAlways != null) callArgs._cdpAlways = decision._cdpAlways;
    }
    // A frozen page answers nothing: thaw it first, silently (no window involved). Only after the gate said yes.
    // The debugger stays on the thawed tab until the call is over (released in `finally`): a page the debugger lets go of freezes again.
    const t0 = Date.now();
    const inPage = QUIET_TOOLS.has(tool) && decision.tabId != null;
    const thaw = decision.thaw && inPage ? await thawIfFrozen(decision.tabId) : null;
    // Still frozen after the silent thaw (or it was not allowed)? A frozen page answers nothing. If nothing may bring
    // the window forward (a quiet call, waking turned off for the tab, Silent mode), say so at once instead of
    // waiting out the deadline; otherwise the window is brought forward below and Chrome thaws the page itself.
    const frozen = inPage && thaw !== "thawed" && thaw !== "not-frozen" && await isFrozenTab(decision.tabId);
    const mayRaise = decision.wake === true && !quiet && decision.tabId != null;
    if (frozen && !mayRaise) { reply(id, false, { code: "TAB_FROZEN", message: frozenMessage({ quiet, wakeOk: decision.wake === true, thawAllowed: decision.thaw === true, thaw, trace: thawTraceOf(decision.tabId) }) }); releaseThaw(decision.tabId); return; }
    // A hidden window/tab (minimized, covered, background) is brought forward for the call when the tab allows it
    // and the caller did not ask for quiet; wake.js puts it back afterwards. A frozen page is always brought forward.
    const woken = mayRaise && (WAKE_TOOLS.has(tool) || frozen) ? await wakeTab(decision.tabId, { force: frozen }) : null;
    let result;
    try { result = await withCallDeadline(tool, callArgs, handler(callArgs), Date.now() - t0); }
    catch (e) {
      // The page did not answer: most likely it is waiting for the user (a "Leave site?" prompt, an alert).
      // Bring the window forward and leave it there so the user can see and answer it.
      if (e?.stuck) e.message += await freezeNote(decision.tabId, thaw, decision.thaw);
      if (e?.stuck && quiet) e.message += " (quiet: the window was not raised)";
      else if (e?.stuck && !decision.wake) e.message += " (the window was not raised: waking is turned off for this tab, or Silent mode is on)";
      else if (e?.stuck && decision.tabId != null) { try { releaseTab(await wakeTab(decision.tabId, { keep: true })); } catch {} }
      throw e;
    }
    finally { releaseTab(woken); if (decision.tabId != null) releaseThaw(decision.tabId); }
    // open_tab auto-share is OPT-IN (off by default): only re-share the new tab
    // when the user explicitly disabled the "don't auto-share opened tabs" guard.
    if (tool === "open_tab" && result?.id != null) {
      const { noAutoShareOpened } = await chrome.storage.local.get("noAutoShareOpened");
      if (noAutoShareOpened === false) await CONSENT.autoShareCreated(result);
    }
    scheduleBadges();
    reply(id, true, silentOpen && result && typeof result === "object" ? { ...result, note: "Silent mode is on: the tab was opened in the background" } : result);
  } catch (e) {
    reply(id, false, { code: e?.code || "SCRIPT_ERROR", message: e?.message ?? String(e) });
  }
}

async function isFrozenTab(tabId) { try { return (await chrome.tabs.get(tabId)).frozen === true; } catch { return false; } }

// TAB_FROZEN: the page is frozen by Chrome, could not be thawed silently, and nothing may bring the window forward.
function frozenMessage({ quiet, wakeOk, thawAllowed, thaw, trace }) {
  const tried = thawAllowed ? `The silent thaw ended: ${thaw ?? "not tried"}${trace ? ` (${trace})` : ""}.` : "A silent thaw needs 'Allow CDP eval' in the Tabduct popup.";
  const next = wakeOk && quiet ? "Repeat the call without quiet:true to wake it (the browser window is brought forward), or leave it."
    : "The user has turned waking off for this tab (or Silent mode is on): ask them to open the tab or to allow waking in the Tabduct popup.";
  return `this tab is frozen by Chrome (hidden for a long time) and does not answer. ${tried} ${next}`.trim();
}

// What a hung call can tell its caller about freezing: Chrome freezes a long-hidden page, and a frozen page answers nothing.
async function freezeNote(tabId, thaw, thawAllowed) {
  let frozen = false;
  try { frozen = tabId != null && (await chrome.tabs.get(tabId)).frozen === true; } catch {}
  if (frozen && thaw === "not-frozen") thaw = null; // it froze again after the check
  const how = thaw && thaw !== "not-frozen" && thawTraceOf(tabId) ? ` (${thawTraceOf(tabId)})` : ""; // what each way of thawing did
  if (frozen) return ` Chrome has frozen this tab (hidden for a long time)${thawAllowed ? `; the silent thaw ended: ${thaw ?? "not tried"}${how}` : "; the silent thaw needs 'Allow CDP eval' in the extension, otherwise a call without quiet raises the window to wake it"}.`;
  if (thaw && thaw !== "not-frozen") return ` The tab had been frozen by Chrome; the silent thaw ended: ${thaw}${how}.`;
  return "";
}

// Cross-instance control ops (hub /control → this instance). Read-only snapshot or
// an unshare that only shrinks sharing; broadcast "sharing" so a local popup refreshes.
async function handleControlInvoke(id, tool, args) {
  try {
    if (tool === "_td/snapshot") {
      const s = await sharingStatus();
      // In "all" tier every tab is implicitly shared; send no per-tab list (the popup
      // shows a single "Sharing all tabs" row from `tier`), just the count.
      reply(id, true, { tier: s.tier, sharedCount: s.sharedCount, tabs: s.tier === "all" ? [] : s.tabs, activeTabId: s.activeTabId, label: s.label, silent: s.silent });
      return;
    }
    if (tool === "_td/unshare") {
      if (typeof args?.tabId === "number") { await CONSENT.unshareTab(args.tabId); scheduleBadges(); chrome.runtime.sendMessage({ evt: "sharing" }).catch(() => {}); }
      reply(id, true, { ok: true });
      return;
    }
    // The popup of ANOTHER browser flips a tab's "may be woken" switch or Silent mode here. Unlike the ops above these can
    // also switch things ON: they only decide whether an agent may raise the window, never what it may read or do.
    if (tool === "_td/set_wake") {
      if (typeof args?.tabId !== "number" || typeof args?.on !== "boolean") { reply(id, false, { code: "INVALID_ARGS", message: "_td/set_wake needs a numeric tabId and a boolean on" }); return; }
      await CONSENT.setTabWake(args.tabId, args.on);
      chrome.runtime.sendMessage({ evt: "sharing" }).catch(() => {});
      reply(id, true, { ok: true });
      return;
    }
    if (tool === "_td/set_silent") {
      if (typeof args?.on !== "boolean") { reply(id, false, { code: "INVALID_ARGS", message: "_td/set_silent needs a boolean on" }); return; }
      await CONSENT.setShareOptions({ silentMode: args.on });
      scheduleBadges(); chrome.runtime.sendMessage({ evt: "sharing" }).catch(() => {});
      reply(id, true, { ok: true });
      return;
    }
    if (tool === "_td/set_tier") {
      // Cross-instance control may only STOP sharing — accept "none" ONLY, so this can
      // never RAISE the tier (e.g. to "all") bypassing the consent gate. Keeps the
      // "_td/* only ever reduce" invariant true by construction, not by caller luck.
      if (args?.tier !== "none") { reply(id, false, { code: "INVALID_ARGS", message: "_td/set_tier accepts only 'none'" }); return; }
      await CONSENT.setTier("none"); await cleanupTabGroups();
      updateContextMenu(); scheduleBadges();
      chrome.runtime.sendMessage({ evt: "sharing" }).catch(() => {});
      reply(id, true, { ok: true });
      return;
    }
    if (tool === "_td/disconnect") {
      // "Stop for all browsers" from another browser: same as pressing Stop here (sticky until Start).
      // Answer first: the reply travels over the very port that is about to close.
      reply(id, true, { ok: true });
      setTimeout(() => { disconnect().catch(() => {}); }, 150);
      return;
    }
    if (tool === "_td/revoke_all") {
      await CONSENT.setTier("none"); await cleanupTabGroups(); // setTier("none") already clears the allow map
      updateContextMenu(); scheduleBadges();
      chrome.runtime.sendMessage({ evt: "sharing" }).catch(() => {});
      reply(id, true, { ok: true });
      return;
    }
    reply(id, false, { code: "UNKNOWN_TOOL", message: `Unknown control op: ${tool}` });
  } catch (e) {
    reply(id, false, { code: e?.code || "INTERNAL", message: e?.message ?? String(e) });
  }
}

function tabInfo(t) { return { id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId, status: t.status, ...(t.frozen === true ? { frozen: true } : {}) }; }

// ---------------------------------------------------------------------------
// Shared-tab badges + denied flash

let badgeTimer = null;
let lastBadge = new Map(); // tabId -> shared? (diff to avoid redundant setBadgeText)
let lastSilent = null; // Silent mode as last painted on the toolbar icon
function scheduleBadges() { clearTimeout(badgeTimer); badgeTimer = setTimeout(refreshBadges, 150); }

// Right-click-on-a-tab menu item. Shown ONLY when connected AND not in
// "Everything" mode (per-tab sharing is meaningless when all tabs are shared).
const CTX_SHARE = "tabduct-share-tab";
async function updateContextMenu() {
  if (!chrome.contextMenus) return;
  try {
    const connected = (await getConnState()).state === "connected";
    const tier = (await CONSENT.getState()).tier;
    await chrome.contextMenus.removeAll();
    if (connected && tier !== "all") {
      // "tab" (tab strip) is flaky on some Chrome builds — it doesn't always render even when create() succeeds.
      // "page" (right-click on the page itself) renders reliably everywhere. Register both.
      chrome.contextMenus.create({ id: CTX_SHARE, title: "⚡ Tabduct: share / unshare this tab", contexts: ["tab", "page"] });
    }
  } catch {}
}
// One share/unshare toggle for the popup button, the hotkey and the context menu. A PAUSED tab
// (grant alive, tab on another site) reads as "not shared" everywhere in the UI, so toggling it
// shares it again on the site it is on now instead of silently ending the dormant grant.
async function toggleShareTab(id) {
  const st = await CONSENT.getState();
  const tab = await chrome.tabs.get(id);
  const paused = CONSENT.pausedTabIds(st, [tab], Date.now()).length > 0;
  if (st.allow?.[String(id)] && !paused) await CONSENT.unshareTab(id); else await CONSENT.shareTab(id);
}
chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CTX_SHARE || tab?.id == null) return;
  const st = await CONSENT.getState();
  if (st.tier === "all") return; // safety: menu shouldn't exist in this mode
  await toggleShareTab(tab.id);
  scheduleBadges();
  chrome.runtime.sendMessage({ evt: "sharing" }).catch(() => {});
});

// Shared indicator = a small dark-green LED dot (lighter outline) drawn onto the
// toolbar icon per tab (the badge API can't size the dot or add a stroke).
const DOT = {
  green: { fill: "#1fa452", stroke: "#5fd98a" }, // current tab is shared
  red: { fill: "#cf3b3b", stroke: "#f0908c" },    // not connected yet
};
let baseBitmaps = null;
async function loadBase() {
  if (baseBitmaps) return baseBitmaps;
  const load = async (s) => createImageBitmap(await (await fetch(chrome.runtime.getURL(`icons/${s}.png`))).blob());
  baseBitmaps = { 16: await load(16), 32: await load(32) };
  return baseBitmaps;
}
function iconWithDot(size, bmp, fill, stroke) {
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext("2d");
  ctx.drawImage(bmp, 0, 0, size, size);
  const r = Math.max(2, Math.round(size * 0.13)), m = Math.round(size * 0.09);
  const cx = size - r - m, cy = size - r - m;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = fill; ctx.fill();
  ctx.lineWidth = Math.max(1, Math.round(size * 0.05)); ctx.strokeStyle = stroke; ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}
// kind: "red" (not connected) | "green" (connected + tab shared) | "plain" (connected, tab not shared)
async function setTabIcon(tabId, kind) {
  try {
    if (kind === "plain") { await chrome.action.setIcon({ tabId, path: { 16: "icons/16.png", 32: "icons/32.png" } }); return; }
    const b = await loadBase(), col = DOT[kind];
    await chrome.action.setIcon({ tabId, imageData: { 16: iconWithDot(16, b[16], col.fill, col.stroke), 32: iconWithDot(32, b[32], col.fill, col.stroke) } });
  } catch {}
}

async function refreshBadges() {
  try {
    const connected = (await getConnState()).state === "connected";
    const st = await CONSENT.getState();
    const all = await chrome.tabs.query({});
    const visible = new Set(connected ? CONSENT.visibleTabIds(st, all, Date.now()).map((t) => t.id) : []);
    const next = new Map(); const sharedIds = new Set();
    for (const t of all) {
      let kind;
      if (!connected) kind = "red"; // not connected → red dot on every tab
      else {
        const shared = st.tier === "all" ? !CONSENT.originBlocked(st, CONSENT.hostOf(t.url)) : visible.has(t.id);
        if (shared) sharedIds.add(t.id);
        kind = shared ? "green" : "plain";
      }
      next.set(t.id, kind);
      if (lastBadge.get(t.id) !== kind) await setTabIcon(t.id, kind);
    }
    lastBadge = next;
    // Silent mode: a reminder on the toolbar icon (the switch itself is in the popup).
    if (lastSilent !== st.silent) {
      lastSilent = st.silent;
      try {
        await chrome.action.setBadgeText({ text: st.silent ? "mute" : "" });
        if (st.silent) { await chrome.action.setBadgeBackgroundColor({ color: "#6b7280" }); chrome.action.setBadgeTextColor?.({ color: "#ffffff" }); }
        await chrome.action.setTitle({ title: st.silent ? "Tabduct - Silent mode is on: agents will not bring any window forward" : "Tabduct" });
      } catch {}
    }
    applyTabGroup(sharedIds, all).catch(() => {});
    reconcileCdpConsole(sharedIds).catch(() => {}); // best-effort; never blocks badges
  } catch {}
}

// CDP console capture reconcile (PART 6): attach capture to shared tabs while
// cdpConsole is on + connected, and stop it everywhere otherwise. Console/Log
// events only arrive while the debugger is attached with Runtime/Log enabled, so
// we attach proactively here (not lazily per get_console_logs). Best-effort:
// every start/stop is guarded in handlers, so this never throws into badges.
// Serialized (a promise-chain mutex) so overlapping runs — the debounced
// scheduleBadges plus the direct `await refreshBadges()` in connect/hotkey — can't
// interleave a start with a concurrent stop and leave a tab in cdpConsoleTabs
// while actually detached. Each queued run reconciles against its own snapshot;
// the latest wins, and reconcile is idempotent, so state converges.
let cdpReconciling = Promise.resolve();
function reconcileCdpConsole(sharedTabIds) {
  cdpReconciling = cdpReconciling.then(() => _reconcileCdp(sharedTabIds)).catch(() => {});
  return cdpReconciling;
}
async function _reconcileCdp(sharedTabIds) {
  const st = await CONSENT.getState();
  const connected = (await getConnState()).state === "connected";
  // Console capture: attach to shared tabs while on, stop everywhere otherwise.
  if (st.allowCdp && st.cdpConsole && connected) {
    for (const tabId of sharedTabIds) if (!cdpConsoleTabs.has(tabId)) await startCdpConsole(tabId);
    for (const tabId of [...cdpConsoleTabs]) if (!sharedTabIds.has(tabId)) await stopCdpConsole(tabId);
  } else {
    await stopAllCdpConsole();
  }
  // Force-hold (cdpAlways) eval sessions: release any not (force-mode && still shared)
  // so unshare/revoke/disabling cdpAlways promptly drops the debugger + its banner.
  await reconcileCdpForce(sharedTabIds, st.allowCdp && st.cdpAlways && connected);
}

// Exact-correlation mask for the group<->sharing sync listener: when WE
// programmatically move a tab in/out of a group, we record each expected event here so the
// listener consumes it instead of mistaking it for a user gesture. A counter per tab (two
// overlapping moves of one tab raise two events), expiring after 2 s if an event never
// arrives (e.g. the tab closed). See groupsync.js.
const groupMask = new GroupMask(2000);
function markGroupMoves(ids) { groupMask.mark(ids); }

// applyTabGroup and cleanupTabGroups both move tabs in and out of groups; run strictly one at a
// time, or two overlapping runs move the same tab twice (and the second event looks like a user
// dragging the tab out).
let groupQueue = Promise.resolve();
function inGroupQueue(fn) { const r = groupQueue.then(fn); groupQueue = r.then(() => {}, () => {}); return r; }

async function setUserUngrouped(tabId, on) {
  try {
    const { tdUngrouped = [] } = await chrome.storage.session.get("tdUngrouped");
    const set = new Set(tdUngrouped);
    if (on) set.add(tabId); else if (!set.delete(tabId)) return;
    await chrome.storage.session.set({ tdUngrouped: [...set] });
  } catch {}
}

// Optional: mark shared tabs with a native "⚡" tab group (opt-in; may rearrange tabs).
function applyTabGroup(sharedIds, allTabs) { return inGroupQueue(() => _applyTabGroup(sharedIds, allTabs)); }
async function _applyTabGroup(sharedIds, allTabs) {
  if (!chrome.tabGroups) return;
  const { useTabGroup } = await chrome.storage.local.get("useTabGroup");
  if (useTabGroup === false) return; // ON by default (only skip when explicitly turned off)
  const st = await CONSENT.getState();
  if (st.tier === "all") return; // don't collapse the whole window into one group
  try {
    // Manage ONLY groups we created (tracked ids) — never touch a user's own "⚡" group.
    const { tdGroups = [] } = await chrome.storage.local.get("tdGroups"); // local → survives reload/update
    const ours = new Set(tdGroups);
    const inOurs = new Set(allTabs.filter((t) => ours.has(t.groupId)).map((t) => t.id));
    const leftover = [...inOurs].filter((id) => !sharedIds.has(id)); // in our group but no longer shared
    // Tabs the USER pulled out of the group (with "unshare on leave" off they stay shared) keep the
    // place the user gave them: don't herd them back in at the next badge refresh.
    const { tdUngrouped = [] } = await chrome.storage.session.get("tdUngrouped");
    const userOut = new Set(tdUngrouped.filter((id) => sharedIds.has(id))); // a tab that stopped being shared forgets its spot
    if (userOut.size !== tdUngrouped.length) await chrome.storage.session.set({ tdUngrouped: [...userOut] });
    const ownGroupOfWin = new Map(); // windowId -> an existing group of ours in that window (join it, don't open a second one)
    for (const t of allTabs) if (ours.has(t.groupId) && !ownGroupOfWin.has(t.windowId)) ownGroupOfWin.set(t.windowId, t.groupId);
    const byWin = new Map();
    for (const t of allTabs) if (sharedIds.has(t.id) && !inOurs.has(t.id) && !userOut.has(t.id)) { if (!byWin.has(t.windowId)) byWin.set(t.windowId, []); byWin.get(t.windowId).push(t.id); }
    if (!leftover.length && !byWin.size) return; // steady state → touch nothing
    if (leftover.length) { markGroupMoves(leftover); await chrome.tabs.ungroup(leftover); }
    const gids = new Set(tdGroups);
    for (const [winId, ids] of byWin) {
      markGroupMoves(ids);
      const existing = ownGroupOfWin.get(winId);
      if (existing !== undefined) { try { await chrome.tabs.group({ groupId: existing, tabIds: ids }); continue; } catch { /* the group vanished: open a new one */ } }
      const gid = await chrome.tabs.group({ tabIds: ids });
      gids.add(gid);
      await chrome.storage.local.set({ tdGroups: [...gids] }); // remember the group before its first events are judged
      await chrome.tabGroups.update(gid, { title: "⚡", color: "purple" });
    }
    await chrome.storage.local.set({ tdGroups: [...gids] });
  } catch {}
}

// Ungroup every tab still in a group WE created, and forget them. Used on
// reload/update (orphaned groups) and when the feature is turned off / revoke-all.
function cleanupTabGroups() { return inGroupQueue(_cleanupTabGroups); }
async function _cleanupTabGroups() {
  try {
    const { tdGroups = [] } = await chrome.storage.local.get("tdGroups");
    if (tdGroups.length && chrome.tabGroups) {
      const ours = new Set(tdGroups);
      const orphan = (await chrome.tabs.query({})).filter((t) => ours.has(t.groupId)).map((t) => t.id);
      if (orphan.length) { markGroupMoves(orphan); await chrome.tabs.ungroup(orphan); } // mask so this cleanup ungroup doesn't unshare tabs
    }
    await chrome.storage.local.set({ tdGroups: [] });
  } catch {}
}

const flashTimers = new Map(); // one timer PER TAB: a shared one let a second denial cancel the first tab's reset
function flashDenied(tabId) {
  try {
    const t = typeof tabId === "number" ? { tabId } : {}; // scope the ✕ to the denied tab (not a global flash on every icon)
    chrome.action.setBadgeTextColor?.({ color: "#ffffff", ...t });
    chrome.action.setBadgeBackgroundColor({ color: "#dc2626", ...t });
    chrome.action.setBadgeText({ text: "✕", ...t });
    const key = typeof tabId === "number" ? tabId : "all";
    clearTimeout(flashTimers.get(key));
    flashTimers.set(key, setTimeout(() => { flashTimers.delete(key); chrome.action.setBadgeText({ text: "", ...t }); refreshBadges(); }, 900)); // refreshBadges repaints the correct state (no blind green reset)
  } catch {}
}

// ---------------------------------------------------------------------------
// Sharing status for the popup

async function sharingStatus() {
  const st = await CONSENT.getState();
  const all = await chrome.tabs.query({});
  const shared = CONSENT.visibleTabIds(st, all, Date.now()).map((t) => ({ id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl, wake: CONSENT.tabWake(st, t.id) }));
  // Grants that are alive but paused because the tab left its shared origin (lock-to-domain):
  // shown greyed in the popup so a dormant grant is never invisible.
  const paused = CONSENT.pausedTabIds(st, all, Date.now()).map((t) => ({ id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl, sharedHost: st.allow[String(t.id)]?.host ?? null }));
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const { useTabGroup, noAutoShareOpened, unshareOnGroupLeave } = await chrome.storage.local.get(["useTabGroup", "noAutoShareOpened", "unshareOnGroupLeave"]);
  const { label } = await getIdentity(); // ensures + returns the auto default label
  const allShared = st.tier === "all" ? all.filter((t) => !CONSENT.originBlocked(st, CONSENT.hostOf(t.url))).length : shared.length;
  return { tier: st.tier, denyOrigins: st.denyOrigins, originMode: st.originMode, sharedCount: allShared, tabs: shared, paused, activeTabId: active?.id, label, useTabGroup: useTabGroup !== false, unshareOnGroupLeave: unshareOnGroupLeave === true, readOnly: st.readOnly, ttlMs: st.ttlMs, lockToDomain: st.lockToDomain, noAutoShareOpened: noAutoShareOpened !== false, allowCdp: st.allowCdp, cdpAlways: st.cdpAlways, cdpConsole: st.cdpConsole, wakeBrowser: st.wakeBrowser, silent: st.silent, extensionVersion: EXT_VERSION };
}

// Cross-instance view for the popup: ask our host to fetch the hub's /control
// snapshot (all browsers behind the hub + what each shares). `selfId` lets the popup
// mark the current browser "Current" and render it first from its own live status.
async function peersList() {
  let selfId = null; try { selfId = (await getIdentity()).instanceId; } catch {}
  try { const r = await request("peers", {}, 8000); return { selfId, instances: Array.isArray(r?.instances) ? r.instances : [] }; }
  catch { return { selfId, instances: [] }; }
}
async function peersUnshare(instanceId, tabId) {
  try { await request("peerUnshare", { instanceId, tabId }, 8000); } catch {}
  return await peersList();
}
async function peersSetWake(instanceId, tabId, on) {
  try { await request("peerSetWake", { instanceId, tabId, on }, 8000); } catch {}
  return await peersList();
}
async function peersStopAll(instanceId) {
  try { await request("peerStopAll", { instanceId }, 8000); } catch {}
  return await peersList();
}

// Large screenshots are handed to the viewer tab in memory (NOT chrome.storage, whose
// ~10MB quota a large PNG can exceed). id -> {dataUrl, ...}; the viewer pulls it via the
// "screenshot.get" message and it's deleted on read (or after a 2-min safety timeout).
const pendingShots = new Map();

// Manual screenshot from the popup: capture the active tab's visible area and open the
// viewer page. User-initiated from the extension UI → no per-tab consent gate (the user
// is explicitly asking to capture the tab in front of them).
async function captureToViewer() {
  try {
    // Resolve the user's active tab. When the action popup is open, the popup can be
    // the "last focused window", so fall back to currentWindow, then to any normal
    // window's active tab — otherwise this used to return no tab / capture the wrong one.
    let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || tab.windowId == null) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
      tab = wins.map((w) => w.tabs?.find((t) => t.active)).find(Boolean);
    }
    if (!tab) return { ok: false, error: "no active tab found" };
    // Hard timeout so a wedged capture can NEVER hang the popup silently — it surfaces
    // as a clear error instead of an eternal "Capturing…".
    const result = await Promise.race([
      HANDLERS.screenshot({ tabId: tab.id, format: "png", _manual: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("capture timed out after 8000ms")), 8000)),
    ]);
    const id = String(Date.now());
    // Hand the image to the viewer tab IN MEMORY (chrome.storage.session has a ~10MB
    // quota). The viewer pulls it by id via "screenshot.get" the moment it loads; the SW
    // that just captured is still alive. Auto-expire so a never-opened viewer can't leak.
    pendingShots.set(id, {
      dataUrl: result.dataUrl, mimeType: result.mimeType,
      title: tab.title || "", url: tab.url || "", ts: Number(id),
    });
    setTimeout(() => pendingShots.delete(id), 120000);
    await chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html?k=${id}`) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// ---------------------------------------------------------------------------
// Listeners: hotkey, tab lifecycle, navigation

chrome.commands?.onCommand.addListener(async (cmd) => {
  ensureConnected();
  if (cmd !== "toggle-share-tab") return;
  const id = await resolveActiveTabId(); if (id == null) return;
  await toggleShareTab(id);
  await refreshBadges();
  chrome.runtime.sendMessage({ evt: "sharing" }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  detachCdpTab(tabId); // a held debugger session dies with its tab (PART 4)
  cdpUserCancelled.delete(tabId);
  pausedNow.delete(tabId);
  const st = await CONSENT.getState();
  if (st.allow?.[String(tabId)]) { await CONSENT.unshareTab(tabId); emitEvent({ kind: "tab_removed", tabId }); }
});

// Chrome swapped a tab for another (prerender / instant): same user-visible tab, new id. Carry
// the grant over, or the share silently vanishes.
chrome.tabs.onReplaced?.addListener(async (addedTabId, removedTabId) => {
  detachCdpTab(removedTabId);
  cdpUserCancelled.delete(removedTabId);
  pausedNow.delete(removedTabId);
  if (await CONSENT.replaceTabId(removedTabId, addedTabId)) {
    scheduleBadges();
    chrome.runtime.sendMessage({ evt: "sharing" }).catch(() => {});
  }
});

// DevTools open on a tab (or the user closing the banner) steals the CDP session
// from us — forget the bookkeeping so we don't try to detach an already-gone one. If the USER
// dismissed the "is being debugged" banner, respect it: don't re-attach on the next refresh.
chrome.debugger?.onDetach?.addListener((source, reason) => {
  if (source?.tabId == null) return;
  if (reason === "canceled_by_user") cdpUserCancelled.add(source.tabId);
  detachCdpTab(source.tabId);
});

chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === "complete") scheduleBadges(); });

// Tabs Chrome opened a moment ago: if it drops one into our "⚡" group (a link opened from a
// grouped tab), that is Chrome, not the user sharing it.
const createdAt = new Map();
chrome.tabs.onCreated.addListener((t) => { createdAt.set(t.id, Date.now()); setTimeout(() => createdAt.delete(t.id), 4000); });

// Sync between our "⚡" group and sharing — user gestures only (our own moves are masked).
// Into our group → share. Out of it → unshare ONLY if the user opted in ("Unshare when a tab is
// taken out of the group"): Chrome also emits group changes for moves between windows, closed
// groups and session restore, and none of those should end a share.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.groupId === undefined) return; // not a group-membership change
  if (groupMask.consume(tabId)) return; // our own programmatic move — consume, don't act
  const { useTabGroup, tdGroups = [], unshareOnGroupLeave, noAutoShareOpened } = await chrome.storage.local.get(["useTabGroup", "tdGroups", "unshareOnGroupLeave", "noAutoShareOpened"]);
  const st = await CONSENT.getState();
  const inOur = info.groupId >= 0 && tdGroups.includes(info.groupId);
  if (inOur) await setUserUngrouped(tabId, false); // back into the group: the normal sync owns it again
  const action = groupAction({
    tier: st.tier, useTabGroup,
    inOurGroup: info.groupId >= 0 && tdGroups.includes(info.groupId),
    shared: !!st.allow?.[String(tabId)],
    blocked: CONSENT.originBlocked(st, CONSENT.hostOf(tab?.url)),
    justOpened: createdAt.has(tabId), noAutoShareOpened, unshareOnLeave: unshareOnGroupLeave === true,
  });
  if (action === "share") await CONSENT.shareTab(tabId);
  else if (action === "unshare") { await CONSENT.unshareTab(tabId); await setUserUngrouped(tabId, false); }
  else {
    // Taken out of the group by the user while the share stays on: remember it (see _applyTabGroup).
    if (info.groupId === -1 && st.allow?.[String(tabId)]) await setUserUngrouped(tabId, true);
    return;
  }
  scheduleBadges();
  chrome.runtime.sendMessage({ evt: "sharing" }).catch(() => {});
});

// TTL sweep: expire timed grants (Phase 4). "alarms" permission. Also the heartbeat that keeps
// the Reload mirror fresh. Create the alarm only if missing: every service-worker start used to
// re-create it, pushing its first firing a minute further out.
chrome.alarms?.get("tabduct-ttl").then((a) => { if (!a) chrome.alarms.create("tabduct-ttl", { periodInMinutes: 1 }); }).catch(() => {});
chrome.alarms?.onAlarm.addListener(async (a) => {
  if (a.name !== "tabduct-ttl") return;
  await ensureConnected(); // SW may have just been revived by this alarm
  await CONSENT.touchMirror().catch(() => {});
  if (await CONSENT.sweepExpired()) { scheduleBadges(); chrome.runtime.sendMessage({ evt: "sharing" }).catch(() => {}); }
});

// Extension Reload / update: storage.session (where grants live) is wiped, so bring the shares
// back from the storage.local mirror — only for tabs that still exist on the host they were
// shared on, and only if the mirror is fresh (see restoreGrants). A browser restart is a
// different event (onStartup) and never restores. The ⚡ groups survive a reload and stay valid
// when shares are restored; otherwise clean up the orphans as before.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "update") {
    try {
      const n = await CONSENT.restoreFromMirror(await chrome.tabs.query({}), Date.now());
      if (n) { scheduleBadges(); updateContextMenu(); return; }
    } catch {}
  }
  await cleanupTabGroups();
});

scheduleBadges(); // paint icons on service-worker start (red until connected)
updateContextMenu(); // reconcile the right-click item with current state on SW start

chrome.runtime.onStartup.addListener(async () => {
  // session consent is wiped on restart but native tab groups persist → drop any
  // leftover "⚡" groups so they don't imply sharing that no longer exists; and the mirror must
  // go too, or the next Reload could resurrect shares from a previous browser session.
  // Queued with the other consent mutators (not fire-and-forget): see browserStarted.
  await CONSENT.browserStarted().catch(() => {});
  scheduleBadges(); updateContextMenu();
  cleanupTabGroups();
  // Auto-join an already-running hub (or revive if we were connected). Respects Stop.
  await ensureConnected();
});

// ---------------------------------------------------------------------------
// Popup <-> background

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  (async () => {
    ensureConnected(); // revive the connection if the SW was evicted
    switch (req?.cmd) {
      case "connect": sendResponse(await connect(req.port ?? DEFAULT_PORT)); break;
      case "disconnect": sendResponse(await disconnect()); break;
      case "status": sendResponse(await getConnState()); break;
      // sharing
      case "sharing.status": sendResponse(await sharingStatus()); break;
      case "sharing.toggleActive": { const id = await resolveActiveTabId(); if (id != null) await toggleShareTab(id); scheduleBadges(); sendResponse(await sharingStatus()); break; }
      case "sharing.unshare": await CONSENT.unshareTab(req.tabId); scheduleBadges(); sendResponse(await sharingStatus()); break;
      case "sharing.tier": await CONSENT.setTier(req.tier); if (req.tier !== "tabs") await cleanupTabGroups(); updateContextMenu(); scheduleBadges(); sendResponse(await sharingStatus()); break;
      case "sharing.setOptions": {
        await CONSENT.setShareOptions({ readOnly: req.readOnly, ttlMs: req.ttlMs, lockToDomain: req.lockToDomain, noAutoShareOpened: req.noAutoShareOpened, allowCdp: req.allowCdp, cdpAlways: req.cdpAlways, cdpConsole: req.cdpConsole, unshareOnGroupLeave: req.unshareOnGroupLeave, wakeBrowser: req.wakeBrowser, silentMode: req.silentMode });
        if (req.allowCdp !== undefined || req.cdpConsole !== undefined) cdpUserCancelled.clear(); // a deliberate settings change re-arms capture on tabs whose banner the user dismissed
        // allowCdp OFF = CDP fully off → release every held session immediately.
        // Other CDP-flag changes (cdpAlways/cdpConsole on OR off) are reconciled by
        // scheduleBadges → reconcileCdpConsole/Force against the new settings, so
        // one CDP user is never torn down as collateral and freshly-enabled capture
        // actually starts even on an idle browser.
        if (req.allowCdp === false) await detachAllCdp();
        scheduleBadges();
        sendResponse(await sharingStatus());
        break;
      }
      case "sharing.preset": {
        // One click over the ordinary settings (consent.presetOptions): "full" / "safe". The origin
        // list, its mode and the frame rule are untouched either way.
        const opts = CONSENT.presetOptions(req.name);
        if (opts) {
          await CONSENT.setShareOptions(opts);
          if (opts.allowCdp === false) await detachAllCdp(); // CDP off = release every held session now
          if (opts.allowCdp !== undefined) cdpUserCancelled.clear();
          scheduleBadges();
        }
        sendResponse(await sharingStatus());
        break;
      }
      case "sharing.setWake": await CONSENT.setTabWake(req.tabId, req.on === true); sendResponse(await sharingStatus()); break;
      case "sharing.setSilent": {
        // Silent mode is for every browser behind the hub: set it here, then ask the others. A browser that could not be
        // reached is reported, so the popup does not claim a silence that is not there.
        await CONSENT.setShareOptions({ silentMode: req.on === true });
        scheduleBadges();
        let peersReachable = true, peersError = null;
        try { await request("peerSetSilent", { on: req.on === true }, 8000); } catch (e) { peersReachable = false; peersError = e?.message ?? String(e); }
        chrome.runtime.sendMessage({ evt: "sharing" }).catch(() => {});
        sendResponse({ ...(await sharingStatus()), peersReachable, peersError });
        break;
      }
      case "sharing.setOriginMode": await chrome.storage.local.set({ originMode: req.mode === "allow" ? "allow" : "block" }); scheduleBadges(); sendResponse(await sharingStatus()); break;
      case "sharing.revokeAll": await CONSENT.revokeAll(); await cleanupTabGroups(); updateContextMenu(); scheduleBadges(); sendResponse(await sharingStatus()); break;
      case "sharing.revokeEverywhere": {
        // Clear THIS instance fully (setTier("none") also clears the allow map), then ask
        // every other instance to do the same via the hub. If the hub is unreachable, or ANY other
        // browser failed to clear (the hub now says so instead of reporting success), we report
        // peersReachable:false so the popup keeps warning that other browsers may still share.
        await CONSENT.setTier("none"); await cleanupTabGroups(); updateContextMenu(); scheduleBadges();
        let peersReachable = true, peersError = null;
        try { await request("peerRevokeAll", {}, 8000); } catch (e) { peersReachable = false; peersError = e?.message ?? String(e); }
        chrome.runtime.sendMessage({ evt: "sharing" }).catch(() => {});
        sendResponse({ ...(await sharingStatus()), peersReachable, peersError });
        break;
      }
      case "sharing.setDeny": await CONSENT.setDenyOrigins(req.list ?? []); scheduleBadges(); sendResponse(await sharingStatus()); break;
      case "sharing.setLabel": {
        const v = String(req.label || "").trim().slice(0, 40);
        const label = v || `Chrome-${labelSuffix()}`;
        await chrome.storage.local.set({ instanceLabel: label });
        // The hub reads labels from the discovery entry, which was written at `open`: tell the host,
        // or the agent keeps seeing the old name until the next Start.
        if (hostPort) request("relabel", { label }, 3000).catch(() => {});
        sendResponse(await sharingStatus());
        break;
      }
      case "sharing.setTabGroup": await chrome.storage.local.set({ useTabGroup: !!req.on }); if (!req.on) await cleanupTabGroups(); scheduleBadges(); sendResponse(await sharingStatus()); break;
      case "sharing.activate": try { await chrome.tabs.update(req.tabId, { active: true }); const t = await chrome.tabs.get(req.tabId); await chrome.windows.update(t.windowId, { focused: true }); } catch {} sendResponse(await sharingStatus()); break;
      case "screenshot.capture": sendResponse(await captureToViewer()); break;
      case "screenshot.get": { const v = pendingShots.get(String(req.k)); if (v) pendingShots.delete(String(req.k)); sendResponse(v || null); break; }
      // Cross-instance list (other browsers behind the same hub) + remote unshare.
      case "peers.list": sendResponse(await peersList()); break;
      case "peers.unshare": sendResponse(await peersUnshare(req.instanceId, req.tabId)); break;
      case "peers.setWake": sendResponse(await peersSetWake(req.instanceId, req.tabId, req.on === true)); break;
      case "peers.stopAll": sendResponse(await peersStopAll(req.instanceId)); break;
      case "hub.restart": {
        try { const r = await request("hubRestart", {}, 25000); sendResponse({ ok: true, hubUp: r?.hubUp !== false }); }
        catch (e) { sendResponse({ ok: false, error: e?.message ?? String(e) }); }
        break;
      }
      case "hub.stopEverywhere": {
        // Every other browser is asked first; this one stops only when all of them confirmed.
        try { await request("hubStopEverywhere", {}, 25000); await disconnect(); sendResponse({ ok: true }); }
        catch (e) { sendResponse({ ok: false, error: e?.message ?? String(e) }); }
        break;
      }
      default: sendResponse({ state: "disconnected" });
    }
  })();
  return true;
});
