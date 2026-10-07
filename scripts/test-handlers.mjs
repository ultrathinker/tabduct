#!/usr/bin/env node
// Black-box tests of the page tools' document pinning (handlers/index.js) against a mock
// chrome.scripting / chrome.tabs. No browser: the mock answers the probe the handlers
// inject (`probeFrame`) from a scripted "page", and records what the tool then injected.
// What this guards: a tool acts on ONE probed, consent-checked document, for the top
// frame as well as for child frames; lock-to-domain on pins the host, off leaves only
// the origin filter; a blocked site's blob/sandboxed/nested frames stay blocked.

let fails = 0;
const eq = (a, b, m) => { const p = JSON.stringify(a) === JSON.stringify(b); console.log(`${p ? "ok" : "FAIL"}: ${m}${p ? "" : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`); if (!p) fails++; };

// ---- mock chrome ----------------------------------------------------------
const store = { session: {}, local: {} };
const area = (d) => ({
  async get(keys) { const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {}); const o = {}; for (const k of ks) if (k in d) o[k] = d[k]; return o; },
  async set(o) { Object.assign(d, o); },
  async remove(k) { for (const x of [].concat(k)) delete d[x]; },
});
// the scripted page(s): frames[frameId] = probe result (+ optional documentId); content = what get_page_content reads
let PAGE = { frames: {}, content: "hello", tabs: {} };
let LOG = [];
const probe = (origin, extra = {}) => ({ url: origin + "/", origin, top: origin, ancestors: [], depth: 0, title: "t", width: 800, height: 600, ...extra });
globalThis.chrome = {
  storage: { session: area(store.session), local: area(store.local) },
  permissions: {},
  tabs: {
    async get(id) { return PAGE.tabs[id] || { id, url: "https://a.com/", active: true, windowId: 1 }; },
    async query() { return [{ id: 1, active: true, windowId: 1 }]; },
  },
  scripting: {
    async executeScript(d) {
      LOG.push({ target: d.target, fn: d.func?.name || "(anon)" });
      if (d.func?.name === "probeFrame") {
        if (d.target.allFrames) return Object.entries(PAGE.frames).map(([fid, r]) => ({ frameId: Number(fid), documentId: `doc${fid}`, result: r }));
        const fid = d.target.frameIds?.[0] ?? 0;
        const r = PAGE.frames[fid];
        if (!r) throw new Error(`No frame with id ${fid} in tab 1`);
        return [{ frameId: fid, documentId: `doc${fid}`, result: r }];
      }
      return [{ result: PAGE.content }]; // get_page_content's injected reader
    },
  },
};
const { HANDLERS, cdpGuardSource } = await import("../extension/handlers/index.js");
const setState = (o) => { store.local.originMode = o.originMode || "block"; store.local.denyOrigins = o.denyOrigins || []; };
const run = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { err: e.code || String(e) }; } };
const page = (frames) => { PAGE = { frames, content: "hello", tabs: {} }; LOG = []; };

// ---- top frame is pinned by documentId (B2) ---------------------------------------
setState({ denyOrigins: ["*.bank.com"] });
page({ 0: probe("https://a.com") });
let r = await run(() => HANDLERS.get_page_content({ tabId: 1, _pin: "a.com" }));
eq([r.ok?.content, LOG.at(-1).target], ["hello", { tabId: 1, documentIds: ["doc0"] }], "lock on, page still on the pinned host: reads, and the injection targets the probed documentId");

page({ 0: probe("https://b.com") });
r = await run(() => HANDLERS.get_page_content({ tabId: 1, _pin: "a.com" }));
eq(r.err, "ORIGIN_DRIFT", "lock on, page moved to another host: ORIGIN_DRIFT, nothing injected");
eq(LOG.filter((l) => l.fn !== "probeFrame").length, 0, "...and no action ran on the drifted page");

r = await run(() => HANDLERS.get_page_content({ tabId: 1 })); // lock off: no pin
eq(r.ok?.content, "hello", "lock off: the same cross-host page is fine (B2: no false ORIGIN_DRIFT on redirects)");

page({ 0: probe("https://x.bank.com") });
r = await run(() => HANDLERS.get_page_content({ tabId: 1 }));
eq(r.err, "ORIGIN_DENIED", "lock off: a page on a filtered-out origin is still refused");

// a blocked site's blob: document (origin = the site) and about:blank opened by it
page({ 0: probe("https://x.bank.com", { url: "blob:https://x.bank.com/3f2a" }) });
eq((await run(() => HANDLERS.get_page_content({ tabId: 1 }))).err, "ORIGIN_DENIED", "a blocked site's blob: document is refused (OPUS-3)");
page({ 0: probe("https://x.bank.com", { url: "about:blank" }) });
eq((await run(() => HANDLERS.get_page_content({ tabId: 1 }))).err, "ORIGIN_DENIED", "about:blank inheriting a blocked origin is refused (OPUS-3/4)");
page({ 0: probe("null", { url: "about:blank", top: "null" }) });
eq((await run(() => HANDLERS.get_page_content({ tabId: 1 }))).ok?.content, "hello", "an empty opaque-origin page is harmless in block mode");

// blank-page grant: pin null
page({ 0: probe("null", { url: "about:blank" }) });
eq((await run(() => HANDLERS.get_page_content({ tabId: 1, _pin: null }))).ok?.content, "hello", "pin null: a still-blank page is fine");
page({ 0: probe("https://a.com") });
eq((await run(() => HANDLERS.get_page_content({ tabId: 1, _pin: null }))).err, "ORIGIN_DRIFT", "pin null: a blank-page grant drifts when the page gets a real origin");

// ---- child frames ----------------------------------------------------------------------
setState({ denyOrigins: ["*.bank.com"] });
page({ 0: probe("https://shop.com"), 3: probe("https://js.hsforms.net", { top: "https://shop.com", depth: 1 }) });
r = await run(() => HANDLERS.get_page_content({ tabId: 1, frameId: 3, _pin: "shop.com" }));
eq([r.ok?.content, LOG.at(-1).target], ["hello", { tabId: 1, documentIds: ["doc3"] }], "child frame: probed, judged, targeted by documentId");
page({ 0: probe("https://shop.com"), 3: probe("https://pay.bank.com", { top: "https://shop.com", depth: 1 }) });
eq((await run(() => HANDLERS.get_page_content({ tabId: 1, frameId: 3, _pin: "shop.com" }))).err, "ORIGIN_DENIED", "child frame of a blocked site is refused");
page({ 0: probe("https://shop.com"), 3: probe("null", { url: "https://pay.bank.com/widget", top: "https://shop.com", depth: 1 }) });
eq((await run(() => HANDLERS.get_page_content({ tabId: 1, frameId: 3, _pin: "shop.com" }))).err, "ORIGIN_DENIED", "sandboxed frame (opaque origin) of a blocked site is refused by its URL (OPUS-6)");
page({ 0: probe("https://shop.com"), 3: probe("null", { url: "data:text/html,x", top: "https://shop.com", ancestors: ["https://pay.bank.com"], depth: 2 }) });
eq((await run(() => HANDLERS.get_page_content({ tabId: 1, frameId: 3, _pin: "shop.com" }))).err, "ORIGIN_DENIED", "a frame nested inside a blocked frame is refused (OPUS-6)");
page({ 0: probe("https://shop.com") });
eq((await run(() => HANDLERS.get_page_content({ tabId: 1, frameId: 9, _pin: "shop.com" }))).err, "INVALID_ARGS", "unknown frameId: clear INVALID_ARGS");
page({ 0: probe("https://other.com"), 3: probe("https://js.hsforms.net", { top: "https://other.com", depth: 1 }) });
eq((await run(() => HANDLERS.get_page_content({ tabId: 1, frameId: 3, _pin: "shop.com" }))).err, "ORIGIN_DRIFT", "frame seen through a drifted page is refused");
page({ 0: probe("https://shop.com"), 3: probe("https://pay.bank.com", { top: "https://shop.com", depth: 1, width: 300, height: 200 }), 4: probe("https://ok.com", { top: "https://shop.com", depth: 1 }) });
const lf = await run(() => HANDLERS.list_frames({ tabId: 1, _pin: "shop.com" }));
eq(lf.ok?.frames.map((f) => f.frameId), [0, 4], "list_frames hides the blocked frame");

// ---- screenshot refuses a visible blocked frame (OPUS-5) -----------------------------------
const shotTab = { id: 1, url: "https://shop.com/", active: true, windowId: 1 };
PAGE.tabs[1] = shotTab;
chrome.windows = { async update() {} };
chrome.tabs.update = async () => shotTab;
chrome.tabs.query = async () => [shotTab];
chrome.tabs.captureVisibleTab = async () => "data:image/png;base64,QUJD";
page({ 0: probe("https://shop.com"), 3: probe("https://pay.bank.com", { top: "https://shop.com", depth: 1, width: 300, height: 200 }) });
PAGE.tabs[1] = shotTab;
eq((await run(() => HANDLERS.screenshot({ tabId: 1, _pin: "shop.com" }))).err, "ORIGIN_DENIED", "screenshot of a page showing a blocked site's frame is refused");
page({ 0: probe("https://shop.com"), 3: probe("https://pay.bank.com", { top: "https://shop.com", depth: 1, width: 0, height: 0 }) });
PAGE.tabs[1] = shotTab;
eq((await run(() => HANDLERS.screenshot({ tabId: 1, _pin: "shop.com" }))).ok?.mimeType, "image/png", "a hidden (0x0) blocked frame does not block the screenshot");
page({ 0: probe("https://shop.com"), 3: probe("https://pay.bank.com", { top: "https://shop.com", depth: 1, width: 300, height: 200 }) });
PAGE.tabs[1] = shotTab;
eq((await run(() => HANDLERS.screenshot({ tabId: 1, _manual: true }))).ok?.mimeType, "image/png", "a manual capture the user triggers is not second-guessed");

// ---- wait_for re-pins every poll: a redirect with lock off completes, with lock on drifts ----------
let polls = 0;
chrome.scripting.executeScript = async (d) => {
  if (d.func?.name === "probeFrame") { polls++; return [{ frameId: 0, documentId: `doc${polls}`, result: probe(polls < 3 ? "https://a.com" : "https://b.com", { url: polls < 3 ? "https://a.com/" : "https://b.com/landed" }) }]; }
  return [{ result: { matched: d.args[1] ? "landed" : false } }].map((x) => ({ result: d.args[1] && polls >= 3 ? { matched: true } : { matched: false } }));
};
polls = 0;
r = await run(() => HANDLERS.wait_for({ tabId: 1, urlContains: "landed", timeoutMs: 5000 }));
eq(!!r.ok?.matched, true, "wait_for across a cross-host redirect, lock off: completes");
polls = 0;
r = await run(() => HANDLERS.wait_for({ tabId: 1, urlContains: "landed", timeoutMs: 5000, _pin: "a.com" }));
eq(r.err, "ORIGIN_DRIFT", "wait_for across a cross-host redirect, lock on: ORIGIN_DRIFT");

// ---- CDP in-page guard (pure source, executed here against a fake location) ----------------------
const runGuard = (src, origin) => {
  const loc = { origin };
  return new Function("location", "URL", `return (()=>{ ${src} return "ran"; })()`)(loc, URL);
};
const ST = { originMode: "block", denyOrigins: ["*.bank.com"] };
eq(runGuard(cdpGuardSource("a.com", ST), "https://a.com"), "ran", "cdp guard, pinned: same host runs");
eq(runGuard(cdpGuardSource("a.com", ST), "https://b.com"), { __tabduct_drift: true }, "cdp guard, pinned: other host → drift");
eq(runGuard(cdpGuardSource(null, ST), "null"), "ran", "cdp guard, pin null: opaque/blank page runs");
eq(runGuard(cdpGuardSource(undefined, ST), "https://anything.com"), "ran", "cdp guard, lock off: any non-blocked host runs");
eq(runGuard(cdpGuardSource(undefined, ST), "https://x.bank.com"), { __tabduct_denied: true }, "cdp guard, lock off: blocked host is refused in-page");
eq(runGuard(cdpGuardSource(undefined, { originMode: "allow", denyOrigins: ["ok.com"] }), "https://ok.com"), "ran", "cdp guard, allow mode: listed host runs");
eq(runGuard(cdpGuardSource(undefined, { originMode: "allow", denyOrigins: ["ok.com"] }), "https://other.com"), { __tabduct_denied: true }, "cdp guard, allow mode: unlisted host refused");
eq(runGuard(cdpGuardSource(undefined, { originMode: "allow", denyOrigins: ["ok.com"] }), "null"), { __tabduct_denied: true }, "cdp guard, allow mode: opaque origin refused (no wildcard)");
eq(runGuard(cdpGuardSource("a.com", ST), "https://a.com./"), "ran", "cdp guard: trailing-dot origin normalizes");

console.log(fails ? `\nHANDLER TESTS FAILED (${fails})` : "\nHANDLER TESTS PASSED");
process.exit(fails ? 1 : 0);
