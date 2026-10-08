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
let CDP = []; // what was sent to the (mock) debugger
const HANGS = []; // evaluations that never finish: rejected when the (mock) debugger detaches, like Chrome does
const LISTENERS = []; // chrome.debugger.onEvent listeners
const emit = (method, params, tabId = 1) => { for (const f of LISTENERS) f({ tabId }, method, params); };
// What the (mock) browser answers over CDP, derived from the scripted PAGE (frames[0] = the top document,
// the others its children) unless the test overrides PAGE.tree / PAGE.contexts / PAGE.evalError / PAGE.loader.
const treeOf = () => {
  const top = PAGE.frames[0] || probe("null", { url: "about:blank" });
  return PAGE.tree || { frame: { id: "F0", loaderId: PAGE.loader || "L1", url: top.url, securityOrigin: top.origin },
    childFrames: Object.entries(PAGE.frames).filter(([f]) => f !== "0").map(([f, r]) => ({ frame: { id: `F${f}`, url: r.url, securityOrigin: r.origin } })) };
};
function cdpReply(method, params) {
  if (method === "Runtime.enable") {
    const top = PAGE.frames[0] || probe("null", { url: "about:blank" });
    for (const c of PAGE.contexts || [{ id: 7, uniqueId: "u7", origin: top.origin, auxData: { frameId: "F0", isDefault: true } }]) emit("Runtime.executionContextCreated", { context: c });
    return {};
  }
  if (method === "Page.getFrameTree") { const t = treeOf(); if (PAGE.onTree) PAGE.onTree(); return { frameTree: t }; }
  if (method === "Page.setWebLifecycleState") {
    // PAGE.keepFrozen: never thaws. PAGE.needToggle: "active" only counts after a "frozen" was set first.
    // PAGE.refreeze: thaws, then Chrome freezes the page again 25 ms later.
    if (params?.state === "frozen") PAGE.sawFrozen = true;
    if (params?.state === "active" && PAGE.tabs[1] && !PAGE.keepFrozen && (!PAGE.needToggle || PAGE.sawFrozen)) {
      PAGE.tabs[1].frozen = false;
      if (PAGE.refreeze) setTimeout(() => { PAGE.tabs[1].frozen = true; }, 25);
    }
    return {};
  }
  if (method === "Runtime.evaluate") { if (PAGE.evalHang) return new Promise((_, rej) => HANGS.push(rej)); if (PAGE.evalError) throw new Error(PAGE.evalError); return { result: { value: PAGE.evalValue ?? 42 } }; }
  return {};
}
const probe = (origin, extra = {}) => ({ url: origin + "/", origin, top: origin, ancestors: [], depth: 0, title: "t", width: 800, height: 600, ...extra });
globalThis.chrome = {
  storage: { session: area(store.session), local: area(store.local) },
  permissions: { contains: async () => true },
  debugger: {
    onEvent: { addListener(f) { LISTENERS.push(f); } },
    async attach() { CDP.push({ method: "attach" }); },
    async detach() { CDP.push({ method: "detach" }); for (const rej of HANGS.splice(0)) rej(new Error("Detached while handling command.")); },
    async sendCommand(_t, method, params) { CDP.push({ method, params }); return cdpReply(method, params); },
  },
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
const baseExec = chrome.scripting.executeScript;
const { HANDLERS, judgeContext, consoleEntryBlocked, probeFrame, keyDescriptor, startCdpConsole, stopCdpConsole } = await import("../extension/handlers/index.js");
const setState = (o) => { store.local.originMode = o.originMode || "block"; store.local.denyOrigins = o.denyOrigins || []; };
const run = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { err: e.code || String(e) }; } };
const page = (frames) => { PAGE = { frames, content: "hello", tabs: {} }; LOG = []; };

// ---- top frame is pinned by documentId ---------------------------------------
setState({ denyOrigins: ["*.bank.com"] });
page({ 0: probe("https://a.com") });
let r = await run(() => HANDLERS.get_page_content({ tabId: 1, _pin: "a.com" }));
eq([r.ok?.content, LOG.at(-1).target], ["hello", { tabId: 1, documentIds: ["doc0"] }], "lock on, page still on the pinned host: reads, and the injection targets the probed documentId");

page({ 0: probe("https://b.com") });
r = await run(() => HANDLERS.get_page_content({ tabId: 1, _pin: "a.com" }));
eq(r.err, "ORIGIN_DRIFT", "lock on, page moved to another host: ORIGIN_DRIFT, nothing injected");
eq(LOG.filter((l) => l.fn !== "probeFrame").length, 0, "...and no action ran on the drifted page");

r = await run(() => HANDLERS.get_page_content({ tabId: 1 })); // lock off: no pin
eq(r.ok?.content, "hello", "lock off: the same cross-host page is fine (no false ORIGIN_DRIFT on redirects)");

page({ 0: probe("https://x.bank.com") });
r = await run(() => HANDLERS.get_page_content({ tabId: 1 }));
eq(r.err, "ORIGIN_DENIED", "lock off: a page on a filtered-out origin is still refused");

// a blocked site's blob: document (origin = the site) and about:blank opened by it
page({ 0: probe("https://x.bank.com", { url: "blob:https://x.bank.com/3f2a" }) });
eq((await run(() => HANDLERS.get_page_content({ tabId: 1 }))).err, "ORIGIN_DENIED", "a blocked site's blob: document is refused");
page({ 0: probe("https://x.bank.com", { url: "about:blank" }) });
eq((await run(() => HANDLERS.get_page_content({ tabId: 1 }))).err, "ORIGIN_DENIED", "about:blank inheriting a blocked origin is refused");
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
eq((await run(() => HANDLERS.get_page_content({ tabId: 1, frameId: 3, _pin: "shop.com" }))).err, "ORIGIN_DENIED", "sandboxed frame (opaque origin) of a blocked site is refused by its URL");
page({ 0: probe("https://shop.com"), 3: probe("null", { url: "data:text/html,x", top: "https://shop.com", ancestors: ["https://pay.bank.com"], depth: 2 }) });
eq((await run(() => HANDLERS.get_page_content({ tabId: 1, frameId: 3, _pin: "shop.com" }))).err, "ORIGIN_DENIED", "a frame nested inside a blocked frame is refused");
page({ 0: probe("https://shop.com") });
eq((await run(() => HANDLERS.get_page_content({ tabId: 1, frameId: 9, _pin: "shop.com" }))).err, "INVALID_ARGS", "unknown frameId: clear INVALID_ARGS");
page({ 0: probe("https://other.com"), 3: probe("https://js.hsforms.net", { top: "https://other.com", depth: 1 }) });
eq((await run(() => HANDLERS.get_page_content({ tabId: 1, frameId: 3, _pin: "shop.com" }))).err, "ORIGIN_DRIFT", "frame seen through a drifted page is refused");
page({ 0: probe("https://shop.com"), 3: probe("https://pay.bank.com", { top: "https://shop.com", depth: 1, width: 300, height: 200 }), 4: probe("https://ok.com", { top: "https://shop.com", depth: 1 }) });
const lf = await run(() => HANDLERS.list_frames({ tabId: 1, _pin: "shop.com" }));
eq(lf.ok?.frames.map((f) => f.frameId), [0, 4], "list_frames hides the blocked frame");

// ---- screenshot refuses a visible blocked frame -----------------------------------
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

// wait_for `text`: accepted on its own and passed to the injected check as the 4th argument
let textArg = "unset";
chrome.scripting.executeScript = async (d) => {
  if (d.func?.name === "probeFrame") return [{ frameId: 0, documentId: "doc1", result: probe("https://a.com") }];
  textArg = d.args[3]; return [{ result: { matched: d.args[3] === "Order shipped" } }];
};
r = await run(() => HANDLERS.wait_for({ tabId: 1, text: "Order shipped", timeoutMs: 2000 }));
eq([!!r.ok?.matched, textArg], [true, "Order shipped"], "wait_for with only `text` is a valid wait and the text reaches the page check");
r = await run(() => HANDLERS.wait_for({ tabId: 1, timeoutMs: 100 }));
eq(r.err, "INVALID_ARGS", "wait_for with no condition at all is still refused");

chrome.scripting.executeScript = baseExec; // the wait_for tests above swapped in a polling mock
// ---- the document's real origin (probeFrame): about:blank inherits it, location.origin says "null" ----------
const vm = await import("node:vm");
const runProbe = (selfOrigin, locOrigin, href = "about:blank") =>
  vm.runInNewContext(`(${probeFrame.toString()})()`, { self: { origin: selfOrigin }, location: { origin: locOrigin, href, ancestorOrigins: [] }, document: { title: "t" }, innerWidth: 1, innerHeight: 1, Array });
eq(runProbe("https://x.bank.com", "null").origin, "https://x.bank.com", "probeFrame: an about:blank popup of a bank reports the BANK's origin (self.origin), not location.origin 'null'");
eq(runProbe("null", "https://x.bank.com", "https://x.bank.com/widget").origin, "https://x.bank.com", "probeFrame: a sandboxed frame (opaque self.origin) falls back to the origin of its URL");
eq(runProbe("https://a.com", "https://a.com", "https://a.com/").origin, "https://a.com", "probeFrame: an ordinary page");
setState({ originMode: "allow", denyOrigins: ["ok.com"] });
page({ 0: probe("https://ok.com", { url: "about:blank" }) });
eq((await run(() => HANDLERS.get_page_content({ tabId: 1 }))).ok?.content, "hello", "allow mode: an about:blank document that inherited an ALLOWED origin is usable (editors on srcdoc/blank frames)");
page({ 0: probe("https://evil.com", { url: "about:blank" }) });
eq((await run(() => HANDLERS.get_page_content({ tabId: 1 }))).err, "ORIGIN_DENIED", "allow mode: ...and one that inherited an unlisted origin is refused");
setState({ denyOrigins: ["*.bank.com"] });

// ---- CDP evaluation runs in the context that was judged -------------------------------
const ST = { originMode: "block", denyOrigins: ["*.bank.com"] };
eq([judgeContext(ST, "a.com", "https://a.com"), judgeContext(ST, "a.com", "https://b.com")?.code, judgeContext(ST, undefined, "https://x.bank.com")?.code, judgeContext(ST, undefined, "https://ok.com"),
    judgeContext(ST, null, "null"), judgeContext(ST, null, "https://a.com")?.code, judgeContext({ originMode: "allow", denyOrigins: ["ok.com"] }, undefined, "null")?.code, judgeContext(ST, "a.com", "https://a.com./")],
   [null, "ORIGIN_DRIFT", "ORIGIN_DENIED", null, null, "ORIGIN_DRIFT", "ORIGIN_DENIED", null], "judgeContext: pin drift, filter, blank pages, trailing dot");

page({ 0: probe("https://a.com") }); CDP = [];
r = await run(() => HANDLERS.execute_script({ tabId: 1, code: "return 1", _engine: "cdp", _pin: "a.com" }));
const evalCall = CDP.find((c) => c.method === "Runtime.evaluate");
eq([r.ok?.via, r.ok?.result, evalCall?.params.uniqueContextId], ["cdp", 42, "u7"], "cdp eval: Runtime.evaluate runs inside the judged context (uniqueContextId)");
eq([evalCall?.params.expression.includes("bank.com"), evalCall?.params.expression.includes("denyOrigins")], [false, false], "cdp eval: the consent rules are NOT sent into the page (the agent's code can't read them, the page can't tamper with them)");
eq(CDP.map((c) => c.method), ["attach", "Runtime.disable", "Runtime.enable", "Page.getFrameTree", "Runtime.evaluate", "Runtime.disable", "detach"], "cdp eval: enables Runtime for the call and switches it off again");

page({ 0: probe("https://a.com") }); PAGE.contexts = [{ id: 8, uniqueId: "u8", origin: "https://b.com", auxData: { frameId: "F0", isDefault: true } }]; CDP = [];
r = await run(() => HANDLERS.execute_script({ tabId: 1, code: "return 1", _engine: "cdp", _pin: "a.com" }));
eq([r.err, CDP.some((c) => c.method === "Runtime.evaluate")], ["ORIGIN_DRIFT", false], "cdp eval, lock on: the page's context is on another origin than the pin -> ORIGIN_DRIFT, nothing evaluated");
page({ 0: probe("https://a.com") }); PAGE.contexts = [{ id: 8, uniqueId: "u8", origin: "https://x.bank.com", auxData: { frameId: "F0", isDefault: true } }]; CDP = [];
r = await run(() => HANDLERS.execute_script({ tabId: 1, code: "return 1", _engine: "cdp" }));
eq([r.err, CDP.some((c) => c.method === "Runtime.evaluate")], ["ORIGIN_DENIED", false], "cdp eval, lock off: a context of a blocked origin -> ORIGIN_DENIED, nothing evaluated (a page can't talk its way past this: the origin comes from the browser)");
page({ 0: probe("https://a.com", { url: "about:blank" }) }); PAGE.contexts = [{ id: 8, uniqueId: "u8", origin: "https://x.bank.com", auxData: { frameId: "F0", isDefault: true } }]; CDP = [];
eq((await run(() => HANDLERS.execute_script({ tabId: 1, code: "return 1", _engine: "cdp" }))).err, "ORIGIN_DENIED", "cdp eval: an about:blank popup that inherited the bank's origin is refused");
page({ 0: probe("https://a.com") }); PAGE.evalError = "Cannot find context with specified id"; CDP = [];
eq((await run(() => HANDLERS.execute_script({ tabId: 1, code: "return 1", _engine: "cdp", _pin: "a.com" }))).err, "ORIGIN_DRIFT", "cdp eval: the context died between check and evaluation (navigation) -> ORIGIN_DRIFT, never a run in the new document");
page({ 0: probe("https://a.com") }); PAGE.contexts = []; CDP = [];
eq((await run(() => HANDLERS.execute_script({ tabId: 1, code: "return 1", _engine: "cdp" }))).err, "SCRIPT_ERROR", "cdp eval: no context found for the top frame -> SCRIPT_ERROR, nothing evaluated");

// ---- console + network buffers: judged by the document that produced the line ------------
eq([consoleEntryBlocked(ST, { origin: "https://x.bank.com", url: "https://cdn.example/b.js" }), consoleEntryBlocked(ST, { origin: "https://shop.com", url: "https://x.bank.com/a.js" }),
    consoleEntryBlocked(ST, { origin: "https://shop.com" }), consoleEntryBlocked(ST, { origin: "", url: "" }), consoleEntryBlocked({ originMode: "block", denyOrigins: [] }, { origin: "", url: "" }),
    consoleEntryBlocked({ originMode: "allow", denyOrigins: ["shop.com"] }, { origin: "https://shop.com" })],
   [true, true, false, true, false, false], "consoleEntryBlocked: context origin or script URL decides; an unknown source is dropped while a filter is active (and only then)");

page({ 0: probe("https://shop.com") });
PAGE.contexts = [
  { id: 7, uniqueId: "u7", origin: "https://shop.com", auxData: { frameId: "F0", isDefault: true } },
  { id: 8, uniqueId: "u8", origin: "https://pay.bank.com", auxData: { frameId: "F3", isDefault: true } },
  { id: 9, uniqueId: "u9", origin: "", auxData: { frameId: "F4", isDefault: true } },
];
await startCdpConsole(1);
const say = (ctx, text, url) => emit("Runtime.consoleAPICalled", { type: "log", executionContextId: ctx, args: [{ type: "string", value: text }], ...(url ? { stackTrace: { callFrames: [{ url }] } } : {}) });
say(7, "shop line", "https://shop.com/app.js"); say(7, "shop line without a stack"); say(8, "bank frame line from a CDN bundle", "https://cdn.example/bundle.js"); say(9, "opaque frame, no stack");
r = await run(() => HANDLERS.get_console_logs({ tabId: 1 }));
eq(r.ok?.logs.map((l) => l.text), ["shop line", "shop line without a stack"], "cdp console: lines of a blocked site's frame and of an unidentifiable (opaque, no URL) source are not handed over");
emit("Network.requestWillBeSent", { requestId: "r1", type: "XHR", documentURL: "https://pay.bank.com/frame", request: { url: "https://api.example/x", method: "GET", headers: { Referer: "https://pay.bank.com/" } } });
emit("Network.requestWillBeSent", { requestId: "r2", type: "XHR", documentURL: "https://shop.com/", request: { url: "https://api.example/y", method: "GET", headers: {} } });
r = await run(() => HANDLERS.list_network_requests({ tabId: 1 }));
eq(r.ok?.requests.map((q) => q.requestId), ["r2"], "network buffer: a request issued by a blocked site's document is hidden even though its URL is neutral");
eq((await run(() => HANDLERS.get_network_request({ tabId: 1, requestId: "r1" }))).err, "ORIGIN_DENIED", "...and can't be fetched by id either");
r = await run(() => HANDLERS.get_network_request({ tabId: 1, requestId: "r2" }));
eq(["docUrl" in (r.ok?.request ?? {}), r.ok?.request?.url], [false, "https://api.example/y"], "...while the allowed one is returned without the internal docUrl field");
await stopCdpConsole(1);

// ---- navigate does not describe a page the caller may not see ----------------------------------
page({ 0: probe("https://a.com") });
PAGE.tabs[1] = { id: 1, url: "https://mail.bank.com/inbox", title: "Inbox (5) - jane@example.com", windowId: 1 };
r = await run(() => HANDLERS.navigate({ tabId: 1, url: "https://sho.rt/x", waitUntilComplete: false }));
eq([r.ok?.withheld, r.ok?.url, r.ok?.title], [true, undefined, undefined], "navigate that ends on a blocked site (redirect): address and title are withheld");
PAGE.tabs[1] = { id: 1, url: "https://b.com/landing", title: "B", windowId: 1 };
r = await run(() => HANDLERS.navigate({ tabId: 1, url: "https://sho.rt/x", waitUntilComplete: false, _pin: "a.com" }));
eq([r.ok?.withheld, r.ok?.url], [true, undefined], "navigate that ends off the pinned origin (lock on): withheld too");
PAGE.tabs[1] = { id: 1, url: "https://a.com/next", title: "A", windowId: 1 };
r = await run(() => HANDLERS.navigate({ tabId: 1, url: "https://a.com/next", waitUntilComplete: false, _pin: "a.com" }));
eq([r.ok?.withheld, r.ok?.url], [undefined, "https://a.com/next"], "navigate that stays inside what is shared: the normal reply");

// ---- screenshot: a second look AFTER the capture -----------------------------------------------
page({ 0: probe("https://shop.com") });
PAGE.tabs[1] = shotTab;
chrome.tabs.captureVisibleTab = async () => { PAGE.frames[3] = probe("https://pay.bank.com", { top: "https://shop.com", depth: 1, width: 300, height: 200 }); return "data:image/png;base64,QUJD"; };
r = await run(() => HANDLERS.screenshot({ tabId: 1, _pin: "shop.com" }));
eq([r.err, r.ok], ["ORIGIN_DENIED", undefined], "screenshot: a blocked frame that became visible while the pixels were taken -> the image is dropped");
chrome.tabs.captureVisibleTab = async () => "data:image/png;base64,QUJD";

// ---- trusted input: CDP Input.* ------------------------------------------------------------------------
eq([keyDescriptor("Enter").key, keyDescriptor("Enter").text, keyDescriptor("Enter").windowsVirtualKeyCode], ["Enter", "\r", 13], "keyDescriptor: Enter types a carriage return");
eq([keyDescriptor("c", ["ctrl"]).text, keyDescriptor("c", ["ctrl"]).modifiers, keyDescriptor("c", ["ctrl"]).code, keyDescriptor("c", ["ctrl"]).windowsVirtualKeyCode], [undefined, 2, "KeyC", 67], "keyDescriptor: Ctrl+C is a command (no text), modifier bit 2");
eq([keyDescriptor("a").text, keyDescriptor("A", ["shift"]).modifiers], ["a", 8], "keyDescriptor: a plain letter types itself; shift is bit 8");
eq([keyDescriptor("tab").key, keyDescriptor("esc").key, keyDescriptor("f5").windowsVirtualKeyCode, keyDescriptor("ArrowDown").windowsVirtualKeyCode, keyDescriptor("Space").text], ["Tab", "Escape", 116, 40, " "], "keyDescriptor: names are case-insensitive; F5, arrows, Space");
eq([keyDescriptor("alt+x"), keyDescriptor(""), keyDescriptor("F13")], [null, null, null], "keyDescriptor: unknown keys are rejected");

const FOCUS_OK = { ok: true, focused: true, hasFocus: true, tag: "textarea" };
let injected = {};
const trustedMock = async (d) => {
  const fn = d.func?.name;
  LOG.push({ target: d.target, fn });
  if (fn === "probeFrame") {
    if (d.target.allFrames) return Object.entries(PAGE.frames).map(([fid, r]) => ({ frameId: Number(fid), documentId: `doc${fid}`, result: r }));
    const fid = d.target.frameIds?.[0] ?? 0; const r = PAGE.frames[fid];
    if (!r) throw new Error(`No frame with id ${fid} in tab 1`);
    return [{ frameId: fid, documentId: `doc${fid}`, result: r }];
  }
  if (fn === "focusElement") return [{ result: injected.focus ?? FOCUS_OK }];
  if (fn === "pageHasFocus") return [{ result: injected.hasFocusLater ?? false }];
  if (fn === "locateElement") return [{ result: injected.locate ?? { ok: true, x: 100.4, y: 50.6, tag: "div" } }];
  return [{ result: "x" }];
};
chrome.scripting.executeScript = trustedMock;
const cdpMethods = () => CDP.map((c) => c.method);
setState({ denyOrigins: ["*.bank.com"] });
page({ 0: probe("https://console.aws.amazon.com") }); injected = {}; CDP = [];

r = await run(() => HANDLERS.type({ tabId: 1, selector: ".xterm-helper-textarea", text: "echo hello", trusted: true }));
eq([r.err, CDP.length], ["CDP_NOT_PERMITTED", 0], "trusted type without the gate's opt-in (_trusted) is refused before any debugger attach");

r = await run(() => HANDLERS.type({ tabId: 1, selector: ".xterm-helper-textarea", text: "echo hello", trusted: true, _trusted: true }));
eq([r.ok?.trusted, cdpMethods(), CDP.find((c) => c.method === "Input.insertText")?.params], [true, ["attach", "Page.getFrameTree", "Input.insertText", "detach"], { text: "echo hello" }], "trusted type: focuses in the pinned document, then Input.insertText, then detaches");
eq(LOG.some((l) => l.fn === "focusElement" && l.target.documentIds?.[0] === "doc0"), true, "...the focus ran in the probed document");

CDP = []; injected = { focus: { ok: true, focused: true, hasFocus: true, tag: "textarea" } };
r = await run(() => HANDLERS.type({ text: "x", trusted: true, _trusted: true, tabId: 1 }));
eq(r.ok?.selector, null, "trusted type with no selector types into whatever is focused");

CDP = []; injected = { focus: { ok: true, focused: false, hasFocus: true, tag: "div" } };
r = await run(() => HANDLERS.type({ tabId: 1, selector: "#term", text: "x", trusted: true, _trusted: true }));
eq([r.err, CDP.length], ["INVALID_ARGS", 0], "an element that doesn't take focus is an INVALID_ARGS with advice, and nothing is typed");
injected = { focus: { __nofocus: true } }; CDP = [];
eq((await run(() => HANDLERS.type({ tabId: 1, text: "x", trusted: true, _trusted: true }))).err, "INVALID_ARGS", "no selector and nothing focused → INVALID_ARGS");

injected = {}; CDP = [];
r = await run(() => HANDLERS.type({ tabId: 1, selector: "#a", text: "", clear: true, trusted: true, _trusted: true }));
eq(CDP.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => c.params.key), ["Delete", "Delete"], "trusted type of an empty string with clear presses Delete (the content was selected)");

injected = {}; CDP = [];
r = await run(() => HANDLERS.press_key({ tabId: 1, key: "Enter", _trusted: true }));
const ks = CDP.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => [c.params.type, c.params.key, c.params.text ?? null]);
eq([r.ok?.pressed, ks], [true, [["keyDown", "Enter", "\r"], ["keyUp", "Enter", null]]], "press_key Enter: keyDown with text, keyUp");
CDP = [];
await run(() => HANDLERS.press_key({ tabId: 1, key: "c", modifiers: ["ctrl"], count: 3, _trusted: true }));
const kc = CDP.filter((c) => c.method === "Input.dispatchKeyEvent");
eq([kc.length, kc[0].params.type, kc[0].params.modifiers, "text" in kc[0].params], [6, "rawKeyDown", 2, false], "press_key Ctrl+C x3: six events, raw (no text), ctrl modifier");
CDP = [];
eq([(await run(() => HANDLERS.press_key({ tabId: 1, key: "Hyper", _trusted: true }))).err, CDP.length], ["INVALID_ARGS", 0], "press_key with an unknown key: INVALID_ARGS, no debugger attach");
eq((await run(() => HANDLERS.press_key({ tabId: 1, key: "Enter" }))).err, "CDP_NOT_PERMITTED", "press_key without the gate's opt-in is refused");

// a visible frame of a filtered-out site: nothing is typed/clicked/pressed
page({ 0: probe("https://shop.com"), 3: probe("https://pay.bank.com", { top: "https://shop.com", depth: 1, width: 300, height: 200 }) }); injected = {}; CDP = [];
eq([(await run(() => HANDLERS.type({ tabId: 1, selector: "#a", text: "x", trusted: true, _trusted: true }))).err, (await run(() => HANDLERS.press_key({ tabId: 1, key: "Enter", _trusted: true }))).err, (await run(() => HANDLERS.click({ tabId: 1, selector: "#a", trusted: true, _trusted: true }))).err, CDP.length], ["ORIGIN_DENIED", "ORIGIN_DENIED", "ORIGIN_DENIED", 0], "a visible blocked-site frame on the page: trusted type/key/click refused, debugger never attached");

// typing into a cross-origin frame works (focus is browser-level)
page({ 0: probe("https://shop.com"), 3: probe("https://js.hsforms.net", { top: "https://shop.com", depth: 1 }) }); injected = {}; CDP = [];
r = await run(() => HANDLERS.type({ tabId: 1, frameId: 3, selector: "#email", text: "a@b.c", trusted: true, _trusted: true, _pin: "shop.com" }));
eq([r.ok?.typed, cdpMethods().includes("Input.insertText"), LOG.some((l) => l.fn === "focusElement" && l.target.documentIds?.[0] === "doc3")], [true, true, true], "trusted type inside a cross-origin frame: focused in that frame's document, text inserted");

// trusted click
page({ 0: probe("https://a.com") }); injected = {}; CDP = [];
r = await run(() => HANDLERS.click({ tabId: 1, selector: "button", trusted: true, _trusted: true }));
eq([r.ok, CDP.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => [c.params.type, c.params.x, c.params.y, c.params.button ?? null])], [{ clicked: true, trusted: true, selector: "button", x: 100, y: 51 }, [["mouseMoved", 100.4, 50.6, null], ["mousePressed", 100.4, 50.6, "left"], ["mouseReleased", 100.4, 50.6, "left"]]], "trusted click: move, press, release at the element's centre");
injected = { locate: { __covered: "div#overlay" } }; CDP = [];
r = await run(() => HANDLERS.click({ tabId: 1, selector: "button", trusted: true, _trusted: true }));
eq([r.err, CDP.length], ["INVALID_ARGS", 0], "trusted click on a covered element is refused (a real click would hit the overlay)");
injected = { locate: { __crossOrigin: true } }; CDP = [];
eq([(await run(() => HANDLERS.click({ tabId: 1, frameId: 0, selector: "b", trusted: true, _trusted: true }))).err, CDP.length], ["INVALID_ARGS", 0], "trusted click that can't be located (cross-origin frame) is refused with advice");
injected = {}; CDP = [];
r = await run(() => HANDLERS.click({ tabId: 1, selector: "button", trusted: false }));
eq(cdpMethods().length, 0, "click without trusted never touches the debugger");

// ---- trusted input: the browser's own look right before the events, and its other guards -----------
const inputSent = () => CDP.some((c) => c.method.startsWith("Input."));
const frameNode = (id, url, securityOrigin, childFrames = []) => ({ frame: { id, url, securityOrigin }, childFrames });
page({ 0: probe("https://shop.com") }); injected = {}; CDP = [];
PAGE.tree = { frame: { id: "F0", loaderId: "L1", url: "https://shop.com/", securityOrigin: "https://shop.com" }, childFrames: [frameNode("F9", "https://pay.bank.com/x", "https://pay.bank.com")] };
eq([(await run(() => HANDLERS.type({ tabId: 1, selector: "#a", text: "x", trusted: true, _trusted: true }))).err, (await run(() => HANDLERS.press_key({ tabId: 1, key: "Enter", _trusted: true }))).err, (await run(() => HANDLERS.click({ tabId: 1, selector: "#a", trusted: true, _trusted: true }))).err, inputSent()],
   ["ORIGIN_DENIED", "ORIGIN_DENIED", "ORIGIN_DENIED", false], "a blocked site's frame in the frame tree - even one the visibility probe didn't see (0x0, added after it) - stops trusted input before any event");
PAGE.tree = { frame: { id: "F0", loaderId: "L1", url: "https://shop.com/", securityOrigin: "https://shop.com" }, childFrames: [frameNode("F2", "https://js.hsforms.net/f", "https://js.hsforms.net", [frameNode("F3", "about:blank", "https://x.bank.com")])] }; CDP = [];
eq([(await run(() => HANDLERS.press_key({ tabId: 1, key: "Enter", _trusted: true }))).err, inputSent()], ["ORIGIN_DENIED", false], "...also when it is nested deeper, inside an allowed frame");
PAGE.tree = { frame: { id: "F0", loaderId: "L1", url: "https://evil.com/", securityOrigin: "https://evil.com" }, childFrames: [] }; CDP = [];
eq([(await run(() => HANDLERS.type({ tabId: 1, selector: "#a", text: "x", trusted: true, _trusted: true, _pin: "shop.com" }))).err, inputSent()], ["ORIGIN_DRIFT", false], "the page moved to another origin between the probe and the attach (lock on): ORIGIN_DRIFT, nothing typed");
PAGE.tree = { frame: { id: "F0", loaderId: "L1", url: "about:blank", securityOrigin: "https://x.bank.com" }, childFrames: [] }; CDP = [];
eq([(await run(() => HANDLERS.type({ tabId: 1, selector: "#a", text: "x", trusted: true, _trusted: true }))).err, inputSent()], ["ORIGIN_DENIED", false], "...and a top document whose real origin (securityOrigin) is a blocked site is refused even at about:blank");

page({ 0: probe("https://shop.com") }); injected = {}; CDP = [];
{ let n = 0; PAGE.onTree = () => { if (++n === 1) PAGE.loader = "L2"; }; } // the page navigates right after the first look
r = await run(() => HANDLERS.press_key({ tabId: 1, key: "Enter", count: 3, _trusted: true }));
eq([r.err, CDP.filter((c) => c.method === "Input.dispatchKeyEvent").length], ["ORIGIN_DRIFT", 2], "press_key x3: a navigation after the first key stops the rest (one keyDown/keyUp pair went out)");

injected = {}; CDP = [];
const pasteErrs = [];
for (const [key, modifiers] of [["v", ["ctrl"]], ["V", ["meta"]], ["v", ["ctrl", "shift"]], ["Insert", ["shift"]]]) pasteErrs.push((await run(() => HANDLERS.press_key({ tabId: 1, key, modifiers, _trusted: true }))).err);
eq([pasteErrs, CDP.length], [["INVALID_ARGS", "INVALID_ARGS", "INVALID_ARGS", "INVALID_ARGS"], 0], "press_key Ctrl/Cmd+V and Shift+Insert (paste = the user's clipboard) are refused before any debugger attach");
eq((await run(() => HANDLERS.press_key({ tabId: 1, key: "a", modifiers: ["ctrl"], _trusted: true }))).ok?.pressed, true, "...other chords (Ctrl+A) still work");

page({ 0: probe("https://shop.com"), 3: probe("https://js.hsforms.net", { top: "https://shop.com", depth: 1 }) }); CDP = [];
injected = { focus: { ok: true, focused: true, hasFocus: false, tag: "input" } };
eq([(await run(() => HANDLERS.type({ tabId: 1, frameId: 3, text: "x", trusted: true, _trusted: true }))).err, (await run(() => HANDLERS.press_key({ tabId: 1, frameId: 3, key: "Enter", _trusted: true }))).err, inputSent()],
   ["INVALID_ARGS", "INVALID_ARGS", false], "frameId without a selector while another frame holds the focus: refused (the keys would go to that other frame)");
eq((await run(() => HANDLERS.press_key({ tabId: 1, frameId: 3, selector: "#e", key: "Enter", _trusted: true }))).ok?.pressed, true, "...with a selector the element is focused first, so it works");
injected = {};
eq((await run(() => HANDLERS.press_key({ tabId: 1, frameId: 3, key: "Enter", _trusted: true }))).ok?.pressed, true, "...and when the named frame does hold the focus, a selector isn't needed");

// the focus report right after focus() can lag (another process, window just brought forward): look again before warning
injected = { focus: { ok: true, focused: true, hasFocus: false, tag: "textarea" }, hasFocusLater: true };
eq((await run(() => HANDLERS.type({ tabId: 1, frameId: 3, selector: "#e", text: "x", trusted: true, _trusted: true }))).ok?.warning, undefined, "type: no 'page asleep' warning when the focus shows up a moment later");
injected = { focus: { ok: true, focused: true, hasFocus: false, tag: "textarea" }, hasFocusLater: false };
eq(/background or minimized/.test((await run(() => HANDLERS.type({ tabId: 1, frameId: 3, selector: "#e", text: "x", trusted: true, _trusted: true }))).ok?.warning ?? ""), true, "type: the warning stays when the page never reports focus");
injected = {};

// ---- a frozen page is thawed through the debugger, without touching the window ----------------------------
{
  const { thawIfFrozen, thawTraceOf, releaseThaw, detachCdpTab, thawWait, thawLinger } = await import("../extension/handlers/index.js");
  Object.assign(thawWait, { polls: 3, pollMs: 10, settleMs: 20 }); thawLinger.ms = 40;
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  page({ 0: probe("https://a.com") }); CDP = [];
  PAGE.tabs[1] = { id: 1, url: "https://a.com/", active: true, windowId: 1, frozen: true };
  eq(await thawIfFrozen(1), "thawed", "a frozen tab is thawed");
  eq(CDP.map((c) => c.method), ["attach", "Page.setWebLifecycleState"], "...and the debugger STAYS attached (a page it lets go of freezes again)");
  eq(CDP.find((c) => c.method === "Page.setWebLifecycleState")?.params, { state: "active" }, "...asking for the 'active' lifecycle state");
  releaseThaw(1);
  await sleepMs(10);
  eq(CDP.some((c) => c.method === "detach"), false, "when the call is over the debugger lingers a little (the next call usually follows)");
  await sleepMs(80);
  eq(CDP.map((c) => c.method), ["attach", "Page.setWebLifecycleState", "detach"], "...and goes after the linger");
  CDP = [];
  eq([await thawIfFrozen(1), CDP.length], ["not-frozen", 0], "a tab that is not frozen is left alone (the debugger is never attached)");
  releaseThaw(1); // nothing held: a no-op
  PAGE.tabs[1].frozen = true; PAGE.keepFrozen = true; CDP = [];
  eq(await thawIfFrozen(1), "still-frozen", "a thaw that does not take effect is reported, not hidden");
  eq(CDP.map((c) => c.method + (c.params?.state ? ":" + c.params.state : "")),
    ["attach", "Page.setWebLifecycleState:active", "attach", "Page.setWebLifecycleState:frozen", "Page.setWebLifecycleState:active", "attach", "Page.enable", "Page.setWebLifecycleState:active"],
    "...after every way was tried: 'active', 'frozen' then 'active', Page.enable then 'active'");
  const trace = thawTraceOf(1);
  eq([/^active: still frozen after/.test(trace), /frozen, then active: still frozen after/.test(trace), /Page\.enable, then active: still frozen after/.test(trace)], [true, true, true], "...and the trace says what each try did", trace);
  CDP = [];
  await detachCdpTab(1);
  eq([CDP.map((c) => c.method), thawTraceOf(1)], [["detach"], ""], "...and a revoke / tab close drops the hold (and the trace) at once");

  // Chrome ignored a lone 'active' for a page it froze itself: 'frozen' first, then 'active', works
  page({ 0: probe("https://a.com") }); PAGE.tabs[1] = { id: 1, url: "https://a.com/", active: true, windowId: 1, frozen: true }; PAGE.needToggle = true;
  eq(await thawIfFrozen(1), "thawed", "a page that ignores a lone 'active' is thawed by 'frozen', then 'active'");
  eq(/^active: still frozen after .*frozen, then active: thawed at/.test(thawTraceOf(1)), true, "...and the trace names the way that worked", thawTraceOf(1));
  await detachCdpTab(1);

  // thawed, then frozen again by Chrome: not a success
  page({ 0: probe("https://a.com") }); PAGE.tabs[1] = { id: 1, url: "https://a.com/", active: true, windowId: 1, frozen: true }; PAGE.refreeze = true;
  Object.assign(thawWait, { polls: 8, pollMs: 10, settleMs: 60 });
  eq(await thawIfFrozen(1), "still-frozen", "a page Chrome freezes again within moments is reported as still frozen");
  eq(/thawed at \d+ ms, frozen again at \d+ ms/.test(thawTraceOf(1)), true, "...and the trace says it was thawed and frozen again", thawTraceOf(1));
  PAGE.refreeze = false; await sleepMs(60);
  Object.assign(thawWait, { polls: 3, pollMs: 10, settleMs: 20 });
  await detachCdpTab(1);

  page({ 0: probe("https://a.com") }); PAGE.tabs[1] = { id: 1, url: "https://a.com/", active: true, windowId: 1, frozen: true };
  const had = chrome.permissions.contains; chrome.permissions.contains = async () => false;
  eq(await thawIfFrozen(1), "failed", "without the debugger permission the thaw is simply not possible");
  chrome.permissions.contains = had;
  eq(await thawIfFrozen(999), "not-frozen", "an unknown tab id answers from the default tab (not frozen) without error");
}

// ---- a script that never finishes must not block the tab's later evals --------------------------------
{
  const { evalDeadline } = await import("../extension/handlers/index.js");
  const saved = evalDeadline.ms; evalDeadline.ms = 60;
  const within = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res({ err: "STILL HANGING" }), ms))]);
  page({ 0: probe("https://a.com") }); CDP = [];
  PAGE.evalHang = true;
  const hung = await within(run(() => HANDLERS.execute_script({ tabId: 1, code: "await new Promise(() => {})", _engine: "cdp", _pin: "a.com" })), 1500);
  eq([hung.err, CDP.some((c) => c.method === "detach")], ["SCRIPT_ERROR", true], "cdp eval: a script that never finishes is stopped after the deadline (debugger detached) with a clear error");
  PAGE.evalHang = false;
  const next = await within(run(() => HANDLERS.execute_script({ tabId: 1, code: "return 1", _engine: "cdp", _pin: "a.com" })), 1500);
  eq(next.ok?.result, 42, "...and the next eval on the same tab is not stuck behind it");
  evalDeadline.ms = saved;
}

// ---- a caller queued behind a stuck script is told at once, not after the stuck one's whole deadline -----
{
  const { evalDeadline, callDeadline, withCallDeadline } = await import("../extension/handlers/index.js");
  const saved = { ...evalDeadline };
  Object.assign(evalDeadline, { ms: 400, queueMs: 60 });
  page({ 0: probe("https://a.com") }); CDP = [];
  PAGE.evalHang = true;
  const a = run(() => HANDLERS.execute_script({ tabId: 1, code: "await new Promise(() => {})", _engine: "cdp", _pin: "a.com" })); // stuck
  await new Promise((r) => setTimeout(r, 30));
  const t0 = Date.now();
  const b = await run(() => HANDLERS.execute_script({ tabId: 1, code: "return 1", _engine: "cdp", _pin: "a.com" }));
  const waited = Date.now() - t0;
  eq([b.err, waited < 300], ["SCRIPT_ERROR", true], `queued behind a stuck script: refused after ~queueMs (${waited} ms), not after the stuck script's deadline`);
  const msg = await (async () => { try { await HANDLERS.execute_script({ tabId: 1, code: "return 1", _engine: "cdp", _pin: "a.com" }); } catch (e) { return e; } })();
  eq([/has been running for|is ahead of this call/.test(msg.message || ""), /Leave site/.test(msg.message || ""), msg.stuck], [true, true, true], "...and says why: a script is still running, a page waiting for a dialog cannot answer");
  await a; // the stuck one hits its own deadline (detach frees it)
  PAGE.evalHang = false;
  const c = await run(() => HANDLERS.execute_script({ tabId: 1, code: "return 1", _engine: "cdp", _pin: "a.com" }));
  eq(c.ok?.result, 42, "...and once the stuck script is gone the next call runs normally");
  Object.assign(evalDeadline, saved);

  // any tool call has a deadline of its own, with the same explanation (list_frames is not a CDP eval)
  callDeadline.ms = 60;
  let e2 = null; try { await withCallDeadline("list_frames", {}, new Promise(() => {})); } catch (e) { e2 = e; }
  eq([e2?.code, e2?.stuck, /did not answer list_frames within/.test(e2?.message || "")], ["TIMEOUT", true, true], "a tool call that never answers ends with TIMEOUT and the dialog hint");
  eq(await withCallDeadline("list_frames", {}, Promise.resolve("fine")), "fine", "...and a call that answers in time is untouched");
  callDeadline.ms = 18000;
}

console.log(fails ? `\nHANDLER TESTS FAILED (${fails})` : "\nHANDLER TESTS PASSED");
process.exit(fails ? 1 : 0);
