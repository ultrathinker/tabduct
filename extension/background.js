// Tabduct extension — background service worker.
//
// Owns: the native-messaging connection + lifecycle (open/close/ping), the
// invoke chokepoint with per-tab CONSENT enforcement (Feature B), shared-tab
// badges, the share hotkey, and popup messaging. See PROTOCOL.md + consent.js.

import { HANDLERS } from "./handlers/index.js";
import * as CONSENT from "./consent.js";

const HOST_NAME = "com.tabduct.host";
const DEFAULT_PORT = 0; // 0 = ephemeral: the host picks a free port (no manual port config)
const PROTOCOL_VERSION = 0; // MUST match protocol/tools.schema.json
const OPEN_TIMEOUT_MS = 8000;

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
    const { instanceId, label, token } = await getIdentity();
    let usePort = port;
    if (usePort === 0) { const { lastPort } = await chrome.storage.local.get("lastPort"); usePort = lastPort || 0; } // reuse last bound port
    await setState({ state: "connecting", port: usePort, token, error: null });
    try { hostPort = chrome.runtime.connectNative(HOST_NAME); }
    catch (e) { await setState({ state: "error", error: String(e) }); return getConnState(); }

    hostPort.onMessage.addListener(onHostMessage);
    hostPort.onDisconnect.addListener(async () => {
      const err = chrome.runtime.lastError;
      hostPort = null; rejectAllPending("native host disconnected");
      await setState({ state: err ? "error" : "disconnected", error: err ? err.message : null });
      scheduleBadges(); // port dropped → red icons
    });

    try {
      const { useHub } = await chrome.storage.local.get("useHub");
      const res = await request("open", { port: usePort, token, protocolVersion: PROTOCOL_VERSION, instanceId, label, hub: useHub !== false }, OPEN_TIMEOUT_MS); // hub on by default (stable endpoint+token)
      if (gen !== connGen) { // user hit Disconnect while we were handshaking → honor it
        try { hostPort?.disconnect(); } catch {} hostPort = null; rejectAllPending("disconnected during connect");
        await setState({ state: "disconnected", error: null }); scheduleBadges(); return getConnState();
      }
      await chrome.storage.local.set({ lastPort: res?.port ?? usePort });
      // Hub mode: show the ONE stable hub endpoint+token; else the per-instance one.
      const patch = { state: "connected", port: res?.port ?? usePort, error: null };
      if (res?.hub && res.endpoint) { patch.hub = true; patch.endpoint = res.endpoint; patch.token = res.token; }
      else { patch.hub = false; patch.endpoint = null; }
      await setState(patch);
      try { await chrome.action.setBadgeBackgroundColor({ color: "#2ecc71" }); chrome.action.setBadgeTextColor?.({ color: "#2ecc71" }); } catch {}
      lastBadge = new Map();
      await refreshBadges();
    } catch (e) {
      try { hostPort?.disconnect(); } catch {}
      hostPort = null;
      await setState({ state: "error", error: e?.message ?? String(e) });
      scheduleBadges(); // failed connect → red icons
    }
    return getConnState();
  })();
  return connecting.finally(() => { connecting = null; });
}

// Re-attach after a service-worker eviction/revival (onStartup does NOT fire for that).
async function ensureConnected() {
  const s = await getConnState();
  if (s.state === "connected" && !hostPort && !connecting) await connect(0).catch(() => {});
}

async function disconnect() {
  connGen++; // invalidate any in-flight connect so it can't flip us back to "connected"
  if (hostPort) { try { await request("close", {}, 3000); } catch {} try { hostPort.disconnect(); } catch {} hostPort = null; }
  rejectAllPending("disconnected by user");
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

function reply(id, ok, payload) {
  if (!hostPort) return;
  hostPort.postMessage(ok ? { replyTo: id, ok: true, result: payload } : { replyTo: id, ok: false, error: payload });
}

// ---------------------------------------------------------------------------
// Consent chokepoint

async function resolveActiveTabId() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id;
}

// Decide whether a tab-targeting/create tool may run; handle sticky-origin revoke.
async function gate(tool, args) {
  const state = await CONSENT.getState();
  // Destination guard for tools carrying a target URL: only http(s), never a
  // denylisted/allow-list-blocked origin (and don't disclose which). Blocks file:/data:/javascript:.
  if ((tool === "navigate" || tool === "open_tab") && args?.url) {
    let scheme = null; try { scheme = new URL(args.url).protocol; } catch {}
    if (scheme !== "http:" && scheme !== "https:") return { allow: false, code: "INVALID_ARGS", message: "only http(s) destinations are allowed" };
    if (CONSENT.originBlocked(state, CONSENT.hostOf(args.url))) return { allow: false, code: "ORIGIN_DENIED", message: "destination not allowed by consent policy" };
  }

  if (CONSENT.CREATE.has(tool)) return { ...CONSENT.evaluate(state, { tool }) };

  let tabId = typeof args?.tabId === "number" ? args.tabId : await resolveActiveTabId();
  if (tabId == null) return { allow: false, code: "TAB_NOT_FOUND", message: "no active tab" };
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return { allow: false, code: "TAB_NOT_FOUND", message: `tab ${tabId} not found` }; }
  const host = CONSENT.hostOf(tab.url);
  const needCap = (tool === "screenshot" && args?.activate) ? "execute" : undefined; // activating steals focus → treat as write
  const d = CONSENT.evaluate(state, { tool, tabId, host, now: Date.now(), needCap });
  if (d.revoke) { await CONSENT.unshareTab(tabId); emitEvent({ kind: "permission_revoked", tabId, reason: d.code }); scheduleBadges(); }
  return { ...d, tabId, host }; // resolved ONCE — the handler reuses this exact tab + authorized host (no TOCTOU re-resolve)
}

async function handleInvoke(msg) {
  const { id, payload } = msg;
  const tool = payload?.tool;
  const args = payload?.args ?? {};
  // Defense-in-depth: a direct host must only ever see a numeric tabId (composite
  // "inst:n" ids are resolved by the hub and never reach here).
  if (args.tabId != null && typeof args.tabId !== "number") { reply(id, false, { code: "INVALID_ARGS", message: "tabId must be a number" }); return; }
  try {
    // Enumerate tools: run + FILTER to shared tabs (never leak unshared titles/URLs).
    // Owned HERE (not in HANDLERS) so there is exactly one filtered path.
    if (CONSENT.ENUMERATE.has(tool)) {
      const state = await CONSENT.getState();
      const { label } = await getIdentity(); // surface the human label as a field, so the agent names this browser even in direct (non-hub) mode
      const withLabel = (t) => ({ ...tabInfo(t), instanceLabel: label });
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

    const decision = await gate(tool, args);
    if (!decision.allow) { reply(id, false, { code: decision.code, message: decision.message }); flashDenied(decision.tabId); return; }

    // Reuse the exact tab the gate authorized (prevents active-tab TOCTOU).
    const callArgs = decision.tabId == null ? args : { ...args, tabId: decision.tabId };
    // TOCTOU defense-in-depth: re-check the authorized origin IN-PAGE for script
    // injection tools — a tab can self-navigate in the ~ms window between gate and
    // executeScript. _authHost is internal and stripped before reaching the wire.
    if (tool === "get_page_content" || tool === "execute_script") callArgs._authHost = decision.host ?? null;
    const result = await handler(callArgs);
    // open_tab auto-share is OPT-IN (off by default): only re-share the new tab
    // when the user explicitly disabled the "don't auto-share opened tabs" guard.
    if (tool === "open_tab" && result?.id != null) {
      const { noAutoShareOpened } = await chrome.storage.local.get("noAutoShareOpened");
      if (noAutoShareOpened === false) await CONSENT.autoShareCreated(result);
    }
    scheduleBadges();
    reply(id, true, result);
  } catch (e) {
    reply(id, false, { code: e?.code || "SCRIPT_ERROR", message: e?.message ?? String(e) });
  }
}

function tabInfo(t) { return { id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId, status: t.status }; }

// ---------------------------------------------------------------------------
// Shared-tab badges + denied flash

let badgeTimer = null;
let lastBadge = new Map(); // tabId -> shared? (diff to avoid redundant setBadgeText)
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
chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CTX_SHARE || tab?.id == null) return;
  const st = await CONSENT.getState();
  if (st.tier === "all") return; // safety: menu shouldn't exist in this mode
  if (st.allow?.[String(tab.id)]) await CONSENT.unshareTab(tab.id); else await CONSENT.shareTab(tab.id);
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
    applyTabGroup(sharedIds, all).catch(() => {});
  } catch {}
}

// Exact-correlation mask for the group<->sharing sync listener: when WE
// programmatically move a tab in/out of a group, we record its id here so the
// listener consumes that one event instead of mistaking it for a user gesture.
// Precise per-tab (no blanket time window) → user drags are never masked; a
// safety timeout drops an id if its event never arrives (e.g. tab closed).
const pendingGroupMoves = new Set();
function markGroupMoves(ids) {
  for (const id of ids) { pendingGroupMoves.add(id); setTimeout(() => pendingGroupMoves.delete(id), 2000); }
}

// Optional: mark shared tabs with a native "⚡" tab group (opt-in; may rearrange tabs).
async function applyTabGroup(sharedIds, allTabs) {
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
    const byWin = new Map();
    for (const t of allTabs) if (sharedIds.has(t.id) && !inOurs.has(t.id)) { if (!byWin.has(t.windowId)) byWin.set(t.windowId, []); byWin.get(t.windowId).push(t.id); }
    if (!leftover.length && !byWin.size) return; // steady state → touch nothing
    if (leftover.length) { markGroupMoves(leftover); await chrome.tabs.ungroup(leftover); }
    const gids = new Set(tdGroups);
    for (const ids of byWin.values()) {
      markGroupMoves(ids);
      const gid = await chrome.tabs.group({ tabIds: ids });
      await chrome.tabGroups.update(gid, { title: "⚡", color: "purple" });
      gids.add(gid);
    }
    await chrome.storage.local.set({ tdGroups: [...gids] });
  } catch {}
}

// Ungroup every tab still in a group WE created, and forget them. Used on
// reload/update (orphaned groups) and when the feature is turned off / revoke-all.
async function cleanupTabGroups() {
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

let flashTimer = null;
function flashDenied(tabId) {
  try {
    const t = typeof tabId === "number" ? { tabId } : {}; // scope the ✕ to the denied tab (not a global flash on every icon)
    chrome.action.setBadgeTextColor?.({ color: "#ffffff", ...t });
    chrome.action.setBadgeBackgroundColor({ color: "#dc2626", ...t });
    chrome.action.setBadgeText({ text: "✕", ...t });
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { chrome.action.setBadgeText({ text: "", ...t }); refreshBadges(); }, 900); // refreshBadges repaints the correct state (no blind green reset)
  } catch {}
}

// ---------------------------------------------------------------------------
// Sharing status for the popup

async function sharingStatus() {
  const st = await CONSENT.getState();
  const all = await chrome.tabs.query({});
  const shared = CONSENT.visibleTabIds(st, all, Date.now()).map((t) => ({ id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl }));
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const { useTabGroup, noAutoShareOpened } = await chrome.storage.local.get(["useTabGroup", "noAutoShareOpened"]);
  const { label } = await getIdentity(); // ensures + returns the auto default label
  const allShared = st.tier === "all" ? all.filter((t) => !CONSENT.originBlocked(st, CONSENT.hostOf(t.url))).length : shared.length;
  return { tier: st.tier, denyOrigins: st.denyOrigins, originMode: st.originMode, sharedCount: allShared, tabs: shared, activeTabId: active?.id, label, useTabGroup: useTabGroup !== false, readOnly: st.readOnly, ttlMs: st.ttlMs, lockToDomain: st.lockToDomain, noAutoShareOpened: noAutoShareOpened !== false };
}

// ---------------------------------------------------------------------------
// Listeners: hotkey, tab lifecycle, navigation

chrome.commands?.onCommand.addListener(async (cmd) => {
  ensureConnected();
  if (cmd !== "toggle-share-tab") return;
  const id = await resolveActiveTabId(); if (id == null) return;
  const st = await CONSENT.getState();
  if (st.allow?.[String(id)]) await CONSENT.unshareTab(id); else await CONSENT.shareTab(id);
  await refreshBadges();
  chrome.runtime.sendMessage({ evt: "sharing" }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const st = await CONSENT.getState();
  if (st.allow?.[String(tabId)]) { await CONSENT.unshareTab(tabId); emitEvent({ kind: "tab_removed", tabId }); }
});

chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === "complete") scheduleBadges(); });

// Two-way sync between our "⚡" group and sharing (only user gestures — our own
// moves are masked by groupSync). Into our group → share; out of it (ungrouped OR
// moved to any non-our group) → unshare.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.groupId === undefined) return; // not a group-membership change
  if (pendingGroupMoves.has(tabId)) { pendingGroupMoves.delete(tabId); return; } // our own programmatic move — consume, don't act
  const { useTabGroup, tdGroups = [] } = await chrome.storage.local.get(["useTabGroup", "tdGroups"]);
  if (useTabGroup === false) return;
  const st = await CONSENT.getState();
  if (st.tier !== "tabs") return; // per-tab mode only
  const inOurGroup = info.groupId >= 0 && tdGroups.includes(info.groupId);
  const shared = !!st.allow?.[String(tabId)];
  if (inOurGroup && !shared) {
    if (CONSENT.originBlocked(st, CONSENT.hostOf(tab?.url))) return; // blocked (deny/allow) can't be shared
    await CONSENT.shareTab(tabId); // dragged INTO our ⚡ group
  } else if (!inOurGroup && shared) {
    await CONSENT.unshareTab(tabId); // dragged OUT of our ⚡ group (ungrouped or into another group)
  } else return;
  scheduleBadges();
  chrome.runtime.sendMessage({ evt: "sharing" }).catch(() => {});
});

// TTL sweep: expire timed grants (Phase 4). "alarms" permission.
chrome.alarms?.create("tabduct-ttl", { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener(async (a) => {
  if (a.name !== "tabduct-ttl") return;
  await ensureConnected(); // SW may have just been revived by this alarm
  if (await CONSENT.sweepExpired()) { scheduleBadges(); chrome.runtime.sendMessage({ evt: "sharing" }).catch(() => {}); }
});

// On reload/update the session-scoped consent is wiped but browser tab groups
// persist → clean up the "⚡" groups we created last time so they don't linger.
chrome.runtime.onInstalled.addListener(() => { cleanupTabGroups(); });

scheduleBadges(); // paint icons on service-worker start (red until connected)
updateContextMenu(); // reconcile the right-click item with current state on SW start

// One-time migration: hub is now on by default. Clear any previously-stored
// useHub value exactly once so the new default takes effect; later toggles persist.
(async () => {
  try {
    const { hubDefaultMigrated } = await chrome.storage.local.get("hubDefaultMigrated");
    if (hubDefaultMigrated) return;
    await chrome.storage.local.remove("useHub");
    await chrome.storage.local.set({ hubDefaultMigrated: true });
  } catch {}
})();

chrome.runtime.onStartup.addListener(async () => {
  // session consent is wiped on restart but native tab groups persist → drop any
  // leftover "⚡" groups so they don't imply sharing that no longer exists.
  cleanupTabGroups();
  // Reconnect with an ephemeral port (0), never a stale bound port, if we were connected.
  const s = await getConnState();
  if (s.state === "connected") connect(0);
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
      case "setHub": await chrome.storage.local.set({ useHub: !!req.on }); if (hostPort) { await disconnect(); await connect(0); } sendResponse(await getConnState()); break;
      // sharing
      case "sharing.status": sendResponse(await sharingStatus()); break;
      case "sharing.toggleActive": { const id = await resolveActiveTabId(); if (id != null) { const st = await CONSENT.getState(); if (st.allow?.[String(id)]) await CONSENT.unshareTab(id); else await CONSENT.shareTab(id); } scheduleBadges(); sendResponse(await sharingStatus()); break; }
      case "sharing.unshare": await CONSENT.unshareTab(req.tabId); scheduleBadges(); sendResponse(await sharingStatus()); break;
      case "sharing.tier": await CONSENT.setTier(req.tier); if (req.tier !== "tabs") await cleanupTabGroups(); updateContextMenu(); scheduleBadges(); sendResponse(await sharingStatus()); break;
      case "sharing.setOptions": await CONSENT.setShareOptions({ readOnly: req.readOnly, ttlMs: req.ttlMs, lockToDomain: req.lockToDomain, noAutoShareOpened: req.noAutoShareOpened }); sendResponse(await sharingStatus()); break;
      case "sharing.setOriginMode": await chrome.storage.local.set({ originMode: req.mode === "allow" ? "allow" : "block" }); scheduleBadges(); sendResponse(await sharingStatus()); break;
      case "sharing.revokeAll": await CONSENT.revokeAll(); await cleanupTabGroups(); updateContextMenu(); scheduleBadges(); sendResponse(await sharingStatus()); break;
      case "sharing.setDeny": await CONSENT.setDenyOrigins(req.list ?? []); scheduleBadges(); sendResponse(await sharingStatus()); break;
      case "sharing.setLabel": { const v = String(req.label || "").trim().slice(0, 40); await chrome.storage.local.set({ instanceLabel: v || `Chrome-${labelSuffix()}` }); sendResponse(await sharingStatus()); break; }
      case "sharing.setTabGroup": await chrome.storage.local.set({ useTabGroup: !!req.on }); if (!req.on) await cleanupTabGroups(); scheduleBadges(); sendResponse(await sharingStatus()); break;
      case "sharing.activate": try { await chrome.tabs.update(req.tabId, { active: true }); const t = await chrome.tabs.get(req.tabId); await chrome.windows.update(t.windowId, { focused: true }); } catch {} sendResponse(await sharingStatus()); break;
      default: sendResponse({ state: "disconnected" });
    }
  })();
  return true;
});
