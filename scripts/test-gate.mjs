#!/usr/bin/env node
// Integration test of the extension's service worker (background.js) against a mock chrome:
// a fake native-messaging port plays the host (answers `open`, sends `invoke`s and reads the
// replies), a scripted page answers the handlers' probe. Covers the consent GATE end to end:
// lock-to-domain pins, drift pauses instead of revoking, the navigate pre-check, forged `_`
// args, oversized replies, tabs.onReplaced, restore after Reload, a late disconnect of an old
// native port, and the group-sync pure logic. No browser needed.

let fails = 0;
const eq = (a, b, m) => { const p = JSON.stringify(a) === JSON.stringify(b); console.log(`${p ? "ok" : "FAIL"}: ${m}${p ? "" : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`); if (!p) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return null; await sleep(5); } };

// The service worker uses the browser's global `crypto`; Node 18 has no such global (19+ does).
globalThis.crypto ??= (await import("node:crypto")).webcrypto;

// ---- mock chrome --------------------------------------------------------------
const ev = () => { const ls = []; return { addListener: (f) => ls.push(f), fire: async (...a) => { for (const f of ls) await f(...a); }, ls }; };
const area = () => { const d = {}; return { d, async get(k) { const ks = typeof k === "string" ? [k] : Array.isArray(k) ? k : Object.keys(k || {}); const o = {}; for (const x of ks) if (x in d) o[x] = JSON.parse(JSON.stringify(d[x])); return o; }, async set(o) { for (const [k, v] of Object.entries(o)) d[k] = JSON.parse(JSON.stringify(v)); }, async remove(k) { for (const x of [].concat(k)) delete d[x]; } }; };
let TABS = [];
let PAGE = {}; // tabId -> probe origin
let FRAMES = {}; // tabId -> extra frames [{frameId, documentId, result}] reported by the allFrames probe
let SHOT = "data:image/png;base64,QUJD";
let ports = [];
const mkPort = () => { const p = { sent: [], onMessage: ev(), onDisconnect: ev(), postMessage(m) { p.sent.push(m); }, disconnect() { p.closed = true; } }; ports.push(p); return p; };
const evs = { onInstalled: ev(), onStartup: ev(), onMessage: ev(), tabsRemoved: ev(), tabsReplaced: ev(), tabsUpdated: ev(), tabsCreated: ev(), alarm: ev() };
const probeOf = (tabId) => { const t = TABS.find((x) => x.id === tabId); const o = PAGE[tabId] ?? (t ? new URL(t.url).origin : "null"); return { url: t?.url ?? "about:blank", origin: o, top: o, ancestors: [], depth: 0, title: "t", width: 800, height: 600 }; };
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: "9.9.9" }), getURL: (p) => `chrome-extension://x/${p}`, lastError: undefined,
    onInstalled: evs.onInstalled, onStartup: evs.onStartup, onMessage: evs.onMessage,
    sendMessage: async () => {}, connectNative: () => mkPort(),
  },
  storage: { session: area(), local: area() },
  tabs: {
    async get(id) { const t = TABS.find((x) => x.id === id); if (!t) throw new Error(`No tab with id: ${id}`); return t; },
    async query(q = {}) { return q.active ? TABS.filter((t) => t.active) : TABS.map((t) => ({ ...t })); },
    async update(id, p) { const t = TABS.find((x) => x.id === id); if (p?.url) { t.url = p.url; t.navigated = true; } return t; },
    captureVisibleTab: async () => SHOT,
    onRemoved: evs.tabsRemoved, onReplaced: evs.tabsReplaced, onUpdated: evs.tabsUpdated, onCreated: evs.tabsCreated,
  },
  scripting: {
    async executeScript(d) {
      if (d.func?.name === "probeFrame") {
        if (d.target.allFrames) return [{ frameId: 0, documentId: "d0", result: probeOf(d.target.tabId) }, ...(FRAMES[d.target.tabId] || [])];
        return [{ frameId: 0, documentId: "d0", result: probeOf(d.target.tabId ?? 1) }];
      }
      return [{ result: "page text" }];
    },
  },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setBadgeTextColor() {}, setIcon: async () => {} },
  alarms: { get: async () => ({}), create() {}, onAlarm: evs.alarm },
  windows: { update: async () => {} },
  permissions: { contains: async () => false, onAdded: ev() },
};
globalThis.fetch = async () => { throw new Error("no network in tests"); }; // hubReachable() → false

await import("../extension/background.js");
const C = await import("../extension/consent.js");
const { GroupMask, groupAction } = await import("../extension/groupsync.js");
const popup = (msg) => new Promise((res) => { evs.onMessage.ls[0](msg, {}, res); });

// ---- connect through a fake host --------------------------------------------------
async function connect() {
  const before = ports.length;
  const p = popup({ cmd: "connect", port: 0 });
  const port = await until(() => ports.length > before && ports.at(-1).sent.find((m) => m.type === "open") && ports.at(-1));
  const open = port.sent.find((m) => m.type === "open");
  await port.onMessage.fire({ replyTo: open.id, ok: true, result: { port: 4242, protocolVersion: 0, hub: true, hubReady: true, endpoint: "http://127.0.0.1:12311/mcp", token: "tok" } });
  const st = await p;
  return { port, open, st };
}
let seq = 0;
async function call(port, tool, args = {}) {
  const id = `i${++seq}`;
  await port.onMessage.fire({ type: "invoke", id, payload: { tool, args } });
  const r = await until(() => port.sent.find((m) => m.replyTo === id));
  return r;
}
const code = (r) => (r?.ok ? "ok" : r?.error?.code);

TABS = [{ id: 1, url: "https://console.aws.amazon.com/home", active: true, windowId: 1, title: "AWS" }];
const { port: P1, open, st } = await connect();
eq(st.state, "connected", "connect: the fake host's reply connects");
eq([open.payload.extensionVersion, open.payload.features, open.payload.hub], ["9.9.9", ["frames", "pinned-docs", "cdp-input"], true], "open carries extensionVersion + features");
eq(open.payload.port, 0, "open asks for an ephemeral port (no lastPort reuse)");

// ---- lock on: pins, drift pauses, navigate pre-check -------------------------------------
await C.setShareOptions({ lockToDomain: true });
await C.shareTab(1);
eq(code(await call(P1, "get_page_content", { tabId: 1 })), "ok", "shared tab on its host: get_page_content works");
TABS[0].url = "https://us-east-1.console.aws.amazon.com/";
let r = await call(P1, "get_page_content", { tabId: 1 });
eq(code(r), "ORIGIN_DRIFT", "lock on, tab moved to another subdomain: ORIGIN_DRIFT");
eq(Object.keys((await C.getState()).allow), ["1"], "...and the share is KEPT (paused, not revoked)");
eq(JSON.parse((await call(P1, "list_tabs")).result.tabs.length), 0, "...the paused tab is hidden from list_tabs");
const status = await popup({ cmd: "sharing.status" });
eq([status.tabs.length, status.paused.map((t) => t.id), status.paused[0]?.sharedHost], [0, [1], "console.aws.amazon.com"], "the popup status lists it as paused");
TABS[0].url = "https://console.aws.amazon.com/back";
eq(code(await call(P1, "get_page_content", { tabId: 1 })), "ok", "back on the shared host: access resumes by itself");
eq((await call(P1, "list_tabs")).result.tabs.length, 1, "...and it is listed again");

// navigate pre-check: the agent can't cut its own access
TABS[0].navigated = false;
eq(code(await call(P1, "navigate", { tabId: 1, url: "https://eu-west-1.console.aws.amazon.com/" })), "ORIGIN_DENIED", "lock on: navigate off the shared host is refused up front");
eq(TABS[0].navigated, false, "...and the tab did not move");
eq(code(await call(P1, "navigate", { tabId: 1, url: "https://console.aws.amazon.com/ec2", waitUntilComplete: false })), "ok", "lock on: navigate within the shared host is fine");

// forged internal args can't change the pin
PAGE[1] = "https://elsewhere.com";
eq(code(await call(P1, "get_page_content", { tabId: 1, _pin: null })), "ORIGIN_DRIFT", "a forged _pin from the wire is dropped; the real pin still applies");
delete PAGE[1];

// ---- lock off: live, no false drift ------------------------------------------------------
await C.setShareOptions({ lockToDomain: false });
TABS[0].url = "https://support.console.aws.amazon.com/";
eq(code(await call(P1, "get_page_content", { tabId: 1 })), "ok", "lock switched OFF after sharing: the cross-host tab works");
eq(code(await call(P1, "navigate", { tabId: 1, url: "https://global.console.aws.amazon.com/", waitUntilComplete: false })), "ok", "lock off: navigate anywhere");
await C.setShareOptions({ originMode: undefined });
await chrome.storage.local.set({ denyOrigins: ["*.bank.com"] });
eq(code(await call(P1, "navigate", { tabId: 1, url: "https://x.bank.com/", waitUntilComplete: false })), "ORIGIN_DENIED", "lock off: the blocked-origins list still wins");
PAGE[1] = "https://x.bank.com";
TABS[0].url = "https://support.console.aws.amazon.com/";
eq(code(await call(P1, "get_page_content", { tabId: 1 })), "ORIGIN_DENIED", "lock off: even if the page itself lands on a blocked site between gate and probe");
delete PAGE[1];
await C.setShareOptions({ lockToDomain: true });
eq((await C.getState()).allow["1"].host, "support.console.aws.amazon.com", "lock back ON re-pins to the tab's current host");
eq(code(await call(P1, "get_page_content", { tabId: 1 })), "ok", "...and it keeps working there");

// ---- trusted input needs the CDP opt-in; refused at the gate before any debugger attach ----------------------------
await C.setShareOptions({ lockToDomain: false, allowCdp: false });
let tr = await call(P1, "press_key", { tabId: 1, key: "Enter" });
eq([code(tr), /Allow CDP eval/.test(tr.error?.message || "")], ["CDP_NOT_PERMITTED", true], "press_key without 'Allow CDP eval': refused at the gate with the way out");
eq(code(await call(P1, "type", { tabId: 1, selector: "#a", text: "x", trusted: true })), "CDP_NOT_PERMITTED", "type trusted without the opt-in: refused");
eq(code(await call(P1, "click", { tabId: 1, selector: "#a", trusted: true })), "CDP_NOT_PERMITTED", "click trusted without the opt-in: refused");
await C.setShareOptions({ allowCdp: true, readOnly: true });
tr = await call(P1, "press_key", { tabId: 1, key: "Enter" });
eq(code(tr), "CAP_NOT_GRANTED", "read-only wins: press_key is a write");
await C.setShareOptions({ readOnly: false });
tr = await call(P1, "press_key", { tabId: 1, key: "Enter" });
eq([code(tr), /Allow CDP eval/.test(tr.error?.message || "")], ["CDP_NOT_PERMITTED", false], "with the opt-in the gate lets it through (this mock has no debugger, so the handler says so itself)");
await C.setShareOptions({ allowCdp: false, lockToDomain: true });

// ---- oversized reply -> a clear error, not a silent drop ----------------------------------------
TABS[0].active = true;
SHOT = "data:image/png;base64," + "A".repeat(31 * 1024 * 1024);
eq(code(await call(P1, "screenshot", { tabId: 1 })), "FRAME_TOO_LARGE", "a >30 MiB reply is answered with FRAME_TOO_LARGE (not dropped by the host)");
SHOT = "data:image/png;base64,QUJD";
eq(code(await call(P1, "screenshot", { tabId: 1 })), "ok", "a normal screenshot still goes through");

// ---- tabs.onReplaced ---------------------------------------------------------------------------
TABS[0].id = 77;
await evs.tabsReplaced.fire(77, 1);
eq(Object.keys((await C.getState()).allow), ["77"], "onReplaced carries the grant to the new tab id");
eq(code(await call(P1, "get_page_content", { tabId: 77 })), "ok", "...and the agent can use the new id");
TABS[0].id = 1;
await evs.tabsReplaced.fire(1, 77);

// ---- restore after extension Reload ---------------------------------------------------------------
const before = JSON.parse(JSON.stringify((await C.getState()).allow));
chrome.storage.session.d = {}; // a Reload wipes storage.session (storage.local survives)
chrome.storage.session.get = async () => ({}); // simplest: session now reads empty until a mutation writes it
{ const s = area(); chrome.storage.session.get = s.get; chrome.storage.session.set = s.set; chrome.storage.session.remove = s.remove; }
eq((await C.getState()).tier, "none", "after a Reload nothing is shared");
await evs.onInstalled.fire({ reason: "install" });
eq((await C.getState()).tier, "none", "a fresh INSTALL never restores");
await evs.onInstalled.fire({ reason: "update" });
const restored = await C.getState();
eq([restored.tier, restored.allow["1"]?.host], ["tabs", before["1"].host], "onInstalled(update) restores the share");
{ const s = area(); chrome.storage.session.get = s.get; chrome.storage.session.set = s.set; chrome.storage.session.remove = s.remove; }
await evs.onStartup.fire();
await evs.onInstalled.fire({ reason: "update" });
eq((await C.getState()).tier, "none", "after a browser restart (onStartup clears the mirror) nothing is restored");

// update applied together with a browser start: whichever event comes first, nothing may stay shared
{
  const wipeSession = () => { const s = area(); chrome.storage.session.get = s.get; chrome.storage.session.set = s.set; chrome.storage.session.remove = s.remove; };
  const shareFresh = async () => { await C.setShareOptions({ lockToDomain: false }); TABS[0].url = "https://console.aws.amazon.com/home"; await C.revokeAll(); await C.shareTab(1); wipeSession(); };
  await shareFresh();
  await evs.onInstalled.fire({ reason: "update" });
  eq((await C.getState()).tier, "tabs", "(setup) the update restored the share");
  await evs.onStartup.fire();
  eq((await C.getState()).tier, "none", "update first, then startup: the startup revokes what the update restored");
  await shareFresh();
  await Promise.all([evs.onStartup.fire(), evs.onInstalled.fire({ reason: "update" })]);
  eq((await C.getState()).tier, "none", "startup and update dispatched together: nothing is shared afterwards");
  await shareFresh();
  await Promise.all([evs.onInstalled.fire({ reason: "update" }), evs.onStartup.fire()]);
  eq((await C.getState()).tier, "none", "...and in the other order too");
  wipeSession();
}

// ---- a late disconnect of a replaced native port must not kill the new connection ---------------
await popup({ cmd: "disconnect" });
const { port: P2 } = await connect();
await P1.onDisconnect.fire(); // the OLD port's disconnect arrives after the new connection exists
const stAfter = await popup({ cmd: "status" });
eq(stAfter.state, "connected", "a late onDisconnect from the old port leaves the new connection alone");
eq(code(await call(P2, "list_tabs")), "ok", "...and the new port still answers invokes");
eq(ports.length >= 2 && P1 !== P2, true, "(two distinct ports were used)");

// ---- the origin filter is judged only AFTER authorization -------------------------------------------
TABS.push({ id: 2, url: "https://shop.com/", active: false, windowId: 1, title: "Shop" });
await chrome.storage.local.set({ denyOrigins: ["*.bank.com"], originMode: "block" });
await C.revokeAll();
eq([code(await call(P2, "open_tab", { url: "https://x.bank.com/" })), code(await call(P2, "open_tab", { url: "https://ok.com/" })), code(await call(P2, "navigate", { tabId: 2, url: "https://x.bank.com/" })), code(await call(P2, "navigate", { tabId: 2, url: "https://ok.com/" }))],
   ["NOT_SHARED", "NOT_SHARED", "NOT_SHARED", "NOT_SHARED"], "nothing shared: a blocked and an ordinary destination are answered alike, so the list can't be probed");
await C.setTier("tabs");
eq(code(await call(P2, "open_tab", { url: "https://x.bank.com/" })), "ORIGIN_DENIED", "sharing on (authorized caller): a blocked destination is refused as ORIGIN_DENIED");
await C.revokeAll();

// ---- forged internal args can't unlock a screenshot of a blocked frame ---------------------------
await C.setShareOptions({ lockToDomain: false });
TABS[0].url = "https://support.console.aws.amazon.com/"; TABS[0].active = true; TABS[1].active = false;
await C.shareTab(1);
FRAMES[1] = [{ frameId: 3, documentId: "d3", result: { url: "https://pay.bank.com/", origin: "https://pay.bank.com", top: "https://support.console.aws.amazon.com", ancestors: [], depth: 1, title: "", width: 300, height: 200 } }];
eq([code(await call(P2, "screenshot", { tabId: 1 })), code(await call(P2, "screenshot", { tabId: 1, _manual: true }))], ["ORIGIN_DENIED", "ORIGIN_DENIED"], "a visible blocked frame refuses the screenshot, and a forged _manual:true from the wire doesn't change that");
delete FRAMES[1];
eq(code(await call(P2, "type", { tabId: 1, selector: "#a", text: "x", trusted: true, _trusted: true })), "CDP_NOT_PERMITTED", "a forged _trusted:true can't switch trusted input on without the opt-in");

// ---- the share button / hotkey / menu on a PAUSED tab re-shares it instead of ending the dormant grant -----
await C.setShareOptions({ lockToDomain: true });
TABS[0].url = "https://support.console.aws.amazon.com/";
await C.revokeAll(); await C.shareTab(1);
TABS[0].url = "https://elsewhere.example/";
eq((await popup({ cmd: "sharing.status" })).paused.map((t) => t.id), [1], "(setup) the tab left its site: paused");
await popup({ cmd: "sharing.toggleActive" });
eq([(await C.getState()).allow["1"]?.host], ["elsewhere.example"], "toggle on a paused tab shares it again on the site it is on now (not unshare)");
await popup({ cmd: "sharing.toggleActive" });
eq(Object.keys((await C.getState()).allow), [], "...and the next toggle, on an active share, unshares");
await C.revokeAll();

// ---- group sync logic -----------------------------------------------------------------------------------
const m = new GroupMask(2000);
m.mark([5], 1000); m.mark([5], 1000);
eq([m.consume(5, 1100), m.consume(5, 1200), m.consume(5, 1300)], [true, true, false], "mask: two overlapping programmatic moves mask two events, the third (user) is not masked");
m.mark([6], 1000);
eq(m.consume(6, 4000), false, "mask: an expected event that never came expires");
const base = { tier: "tabs", useTabGroup: true, inOurGroup: false, shared: true, blocked: false, justOpened: false, noAutoShareOpened: true, unshareOnLeave: false };
eq(groupAction({ ...base }), null, "taking a shared tab out of the group does NOT unshare by default");
eq(groupAction({ ...base, unshareOnLeave: true }), "unshare", "...unless the user opted in");
eq(groupAction({ ...base, inOurGroup: true, shared: false }), "share", "dragging a tab into the group shares it");
eq(groupAction({ ...base, inOurGroup: true, shared: false, blocked: true }), null, "...never a blocked origin");
eq(groupAction({ ...base, inOurGroup: true, shared: false, justOpened: true }), null, "a tab Chrome just opened into the group is not auto-shared");
eq(groupAction({ ...base, inOurGroup: true, shared: false, justOpened: true, noAutoShareOpened: false }), "share", "...unless the user turned that guard off");
eq(groupAction({ ...base, tier: "all", inOurGroup: true, shared: false }), null, "'Everything' mode: group sync is off");

// ---- tab groups: one group per window; a tab the user pulled out stays out ----------------------------
{
  let gseq = 100; const calls = [];
  chrome.tabGroups = { async update() {} };
  chrome.tabs.group = async ({ tabIds, groupId }) => { const gid = groupId ?? ++gseq; calls.push({ tabIds, groupId: groupId ?? null }); for (const id of tabIds) { const t = TABS.find((x) => x.id === id); t.groupId = gid; setTimeout(() => evs.tabsUpdated.fire(id, { groupId: gid }, t), 0); } return gid; };
  chrome.tabs.ungroup = async (ids) => { for (const id of [].concat(ids)) { const t = TABS.find((x) => x.id === id); t.groupId = -1; setTimeout(() => evs.tabsUpdated.fire(id, { groupId: -1 }, t), 0); } };
  TABS = [{ id: 1, url: "https://a.com/", active: true, windowId: 1, groupId: -1 }, { id: 2, url: "https://b.com/", active: false, windowId: 1, groupId: -1 }, { id: 3, url: "https://c.com/", active: false, windowId: 1, groupId: -1 }];
  await chrome.storage.local.set({ useTabGroup: true, tdGroups: [], unshareOnGroupLeave: false, noAutoShareOpened: true, denyOrigins: [] });
  await C.revokeAll(); await C.setShareOptions({ lockToDomain: false });
  await C.shareTab(1); await C.shareTab(2);
  await popup({ cmd: "sharing.toggleActive" }); await popup({ cmd: "sharing.toggleActive" }); // unshare + re-share the active tab: any sharing change repaints the badges/groups
  await sleep(500);
  eq(calls.map((c) => c.groupId), [null], "(setup) two shared tabs open ONE group");
  await C.shareTab(3); await popup({ cmd: "sharing.toggleActive" }); await popup({ cmd: "sharing.toggleActive" }); // any sharing change repaints
  await sleep(400);
  eq([calls.length, calls[1]?.groupId, TABS[2].groupId], [2, 101, 101], "a third shared tab JOINS the existing group instead of opening a second one");
  // the user pulls tab 2 out of the group: with 'unshare on leave' off it stays shared and stays out
  TABS[1].groupId = -1;
  await evs.tabsUpdated.fire(2, { groupId: -1 }, TABS[1]);
  eq(Object.keys((await C.getState()).allow).includes("2"), true, "dragging a tab out of the group does not unshare it (default)");
  const n = calls.length;
  await popup({ cmd: "sharing.toggleActive" }); await popup({ cmd: "sharing.toggleActive" });
  await sleep(400);
  eq([calls.slice(n).some((c) => c.tabIds.includes(2)), TABS[1].groupId], [false, -1], "...and the next repaint doesn't herd it back into a group");
}

console.log(fails ? `\nGATE TESTS FAILED (${fails})` : "\nGATE TESTS PASSED");
process.exit(fails ? 1 : 0);
