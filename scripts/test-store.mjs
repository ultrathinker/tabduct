#!/usr/bin/env node
// Unit test for the Chrome-BOUND half of consent.js (the serialized storage mutators), run
// against an in-memory mock of chrome.storage / chrome.tabs. The decision logic itself is
// covered by test-consent.mjs; this file catches what pure tests cannot: a mutator that
// forgets to carry a field over, lost updates under concurrency, the Reload mirror.

import * as C from "../extension/consent.js";

let fails = 0;
const eq = (a, b, m) => { const p = JSON.stringify(a) === JSON.stringify(b); console.log(`${p ? "ok" : "FAIL"}: ${m}${p ? "" : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`); if (!p) fails++; };
const code = (r) => (r.allow ? "ALLOW" : r.code);

// ---- mock chrome ----------------------------------------------------------
let TABS = [];
function area() {
  const d = {};
  return {
    d,
    async get(keys) { const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {}); const o = {}; for (const k of ks) if (k in d) o[k] = JSON.parse(JSON.stringify(d[k])); return o; },
    async set(o) { for (const [k, v] of Object.entries(o)) d[k] = JSON.parse(JSON.stringify(v)); },
    async remove(k) { for (const x of [].concat(k)) delete d[x]; },
  };
}
function resetChrome(tabs) {
  TABS = tabs;
  globalThis.chrome = {
    storage: { session: area(), local: area() },
    tabs: {
      async get(id) { const t = TABS.find((x) => x.id === id); if (!t) throw new Error(`No tab with id: ${id}`); return t; },
      async query() { return TABS.map((t) => ({ ...t })); },
    },
  };
}
let NOW = 1_000_000;
Date.now = () => NOW;

// ---- OPUS-1: unrelated mutations must not wipe the 'Everything' share's clock ----
resetChrome([{ id: 1, url: "https://a.com/" }, { id: 2, url: "https://b.com/" }]);
await C.setShareOptions({ ttlMs: 60_000 });
await C.shareTab(2);
await C.setTier("all");
const t0 = (await C.getState()).tierSetAt;
eq(t0, NOW, "setTier(all) records when the share started");
await C.unshareTab(2); // closing/unsharing ONE tab used to erase the TTL of the whole 'Everything' share
eq((await C.getState()).tierSetAt, t0, "unshareTab keeps the 'Everything' start time (OPUS-1)");
await C.shareTab(1);
eq((await C.getState()).tierSetAt, t0, "shareTab keeps it too");
NOW += 120_000;
eq(code(C.evaluate(await C.getState(), { tool: "get_page_content", tabId: 1, host: "a.com", now: NOW })), "NOT_SHARED", "the 'Everything' share still expires after its TTL");
eq(await C.sweepExpired(), true, "sweepExpired removes the expired 'Everything' share");
eq((await C.getState()).tier, "none", "...and sharing is off afterwards");

// ---- B1/B3: lock-to-domain is live; drift pauses, never revokes ----------------
resetChrome([{ id: 5, url: "https://console.aws.amazon.com/" }]);
await C.setShareOptions({ lockToDomain: true });
await C.shareTab(5);
let st = await C.getState();
eq(st.allow["5"].host, "console.aws.amazon.com", "grant remembers the shared host");
eq("mode" in st.allow["5"], false, "grant no longer seals the lock setting");
TABS[0].url = "https://us-east-1.console.aws.amazon.com/";
eq(code(C.evaluate(st, { tool: "get_page_content", tabId: 5, host: C.hostOf(TABS[0].url), now: NOW })), "ORIGIN_DRIFT", "lock on: a cross-subdomain navigation is refused");
eq(Object.keys((await C.getState()).allow), ["5"], "...but the grant is still there (paused, not revoked)");
await C.setShareOptions({ lockToDomain: false });
st = await C.getState();
eq(code(C.evaluate(st, { tool: "get_page_content", tabId: 5, host: C.hostOf(TABS[0].url), now: NOW })), "ALLOW", "lock switched OFF later frees the tab that was shared while it was on (B1)");
TABS[0].url = "https://eu-central-1.console.aws.amazon.com/home";
await C.setShareOptions({ lockToDomain: true });
st = await C.getState();
eq(st.allow["5"].host, "eu-central-1.console.aws.amazon.com", "lock switched back ON pins the tab to the host it is on now");
eq(code(C.evaluate(st, { tool: "get_page_content", tabId: 5, host: "eu-central-1.console.aws.amazon.com", now: NOW })), "ALLOW", "...so it keeps working there");
eq(code(C.evaluate(st, { tool: "get_page_content", tabId: 5, host: "support.console.aws.amazon.com", now: NOW })), "ORIGIN_DRIFT", "...and drifts from there");
// lock ON re-pin drops grants of tabs that were closed meanwhile
await C.setShareOptions({ lockToDomain: false });
TABS.length = 0;
await C.setShareOptions({ lockToDomain: true });
eq(Object.keys((await C.getState()).allow), [], "re-pin forgets grants of tabs that no longer exist");

// ---- OPUS-2: live TTL ---------------------------------------------------------
resetChrome([{ id: 1, url: "https://a.com/" }]);
await C.shareTab(1); // shared while TTL was OFF
NOW += 3_600_000;
await C.setShareOptions({ ttlMs: 60_000 });
st = await C.getState();
eq(code(C.evaluate(st, { tool: "get_page_content", tabId: 1, host: "a.com", now: NOW })), "ALLOW", "enabling TTL does not instantly expire a tab shared an hour ago");
NOW += 61_000;
eq(code(C.evaluate(await C.getState(), { tool: "get_page_content", tabId: 1, host: "a.com", now: NOW })), "NOT_SHARED", "...but covers it once the TTL has run from the moment it was enabled");
eq(await C.sweepExpired(), true, "sweepExpired drops it");
await C.setShareOptions({ ttlMs: 0 });
await C.shareTab(1);
NOW += 9e9;
eq(code(C.evaluate(await C.getState(), { tool: "get_page_content", tabId: 1, host: "a.com", now: NOW })), "ALLOW", "TTL off → no expiry");
NOW = 1_000_000;

// ---- serialization: no lost updates under concurrency ----------------------------
resetChrome(Array.from({ length: 25 }, (_, i) => ({ id: i + 1, url: `https://h${i + 1}.com/` })));
await Promise.all(TABS.map((t) => C.shareTab(t.id)));
eq(Object.keys((await C.getState()).allow).length, 25, "25 concurrent shareTab calls: none lost");
await Promise.all(TABS.slice(0, 20).map((t) => C.unshareTab(t.id)));
eq(Object.keys((await C.getState()).allow).sort(), ["21", "22", "23", "24", "25"], "20 concurrent unshareTab calls: exactly the right five remain");

// ---- B5: onReplaced -----------------------------------------------------------------
resetChrome([{ id: 10, url: "https://a.com/" }]);
await C.shareTab(10);
TABS[0].id = 24;
eq(await C.replaceTabId(10, 24), true, "replaceTabId carries the grant");
st = await C.getState();
eq(Object.keys(st.allow), ["24"], "grant now lives under the new tab id");
eq(await C.replaceTabId(10, 30), false, "replaceTabId on an unshared id is a no-op");

// ---- B7: Reload restores sharing; browser restart does not ----------------------------
resetChrome([{ id: 1, url: "https://a.com/" }, { id: 2, url: "https://b.com/" }]);
await C.shareTab(1);
await C.shareTab(2);
const mirrorBefore = chrome.storage.local.d.allowMirror;
eq(!!mirrorBefore && Object.keys(mirrorBefore.allow).length === 2, true, "every mutation mirrors the grants to storage.local");
NOW += 40_000;
await C.touchMirror();
eq(chrome.storage.local.d.allowMirror.aliveAt, NOW, "the heartbeat refreshes the mirror");
// extension Reload: storage.session is wiped, storage.local survives, tabs keep their ids
chrome.storage.session.d = {}; chrome.storage.session.get = async (k) => ({});
resetSession();
function resetSession() { const s = area(); chrome.storage.session.get = s.get; chrome.storage.session.set = s.set; chrome.storage.session.remove = s.remove; }
eq((await C.getState()).tier, "none", "after Reload nothing is shared (session storage was wiped)");
TABS[1].url = "https://elsewhere.com/"; // one tab navigated meanwhile
NOW += 20_000;
eq(await C.restoreFromMirror(await chrome.tabs.query({}), NOW), 1, "restoreFromMirror brings back the grant whose tab is still on its host");
st = await C.getState();
eq([st.tier, Object.keys(st.allow)], ["tabs", ["1"]], "...and only that one (tab 2 moved away, so it is not resurrected)");
eq(await C.restoreFromMirror(await chrome.tabs.query({}), NOW), 0, "restoring again is a no-op (something is already shared)");
// browser restart: the mirror is cleared by onStartup, so nothing can come back
await C.clearMirror();
resetSession();
eq(await C.restoreFromMirror(await chrome.tabs.query({}), NOW), 0, "no mirror → nothing restored");
// a stale mirror from long ago is never restored
await C.shareTab(1);
NOW += 3_600_000;
resetSession();
eq(await C.restoreFromMirror(await chrome.tabs.query({}), NOW), 0, "a stale mirror is ignored (fresh-heartbeat rule)");

// ---- revokeAll leaves nothing to restore --------------------------------------------------
resetChrome([{ id: 1, url: "https://a.com/" }]);
await C.shareTab(1);
await C.revokeAll();
eq(chrome.storage.local.d.allowMirror.allow, {}, "revokeAll empties the mirror too");

console.log(fails ? `\nSTORE TESTS FAILED (${fails})` : "\nSTORE TESTS PASSED");
process.exit(fails ? 1 : 0);
