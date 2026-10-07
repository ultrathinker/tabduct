#!/usr/bin/env node
// OPT-IN end-to-end test in a REAL Chrome (headless, throwaway profile) — not part of `npm test`:
//   node scripts/e2e-chrome.mjs
// What the mock-based tests cannot prove, this does with the real browser engine: documentId
// pinning on a real page that redirects across hosts, cross-origin frames (out-of-process iframes),
// blob: documents of a blocked site, trusted (isTrusted) typing / clicking / key presses through
// CDP, <select> handling, and sharing surviving an extension Reload.
//
// Chrome 137+ removed --load-extension from branded builds, so the extension is installed through
// CDP's Extensions.loadUnpacked (needs --enable-unsafe-extension-debugging, set below). It drives the extension's
// service worker directly (HANDLERS.* and the consent store), because the native host is not
// involved at this layer. It never touches your real browser profile, ~/.tabduct or the live hub.
// Set CHROME_PATH to use a different binary; the test skips if none is found.

import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATES = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
const CHROME = CANDIDATES.find((p) => existsSync(p));
if (!CHROME) { console.log("SKIP: no Chrome found (set CHROME_PATH)"); process.exit(0); }

let fails = 0;
const ok = (c, m, extra) => { if (!c) { console.error("  FAIL:", m, extra !== undefined ? JSON.stringify(extra) : ""); fails++; } else console.log("  ok:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- test pages (two origins: 127.0.0.1 and localhost are different sites) --------------------------
let PA = 0, PB = 0;
const page = (body) => `<!doctype html><meta charset="utf-8">${body}`;
function route(side, req, res) {
  const u = new URL(req.url, "http://x");
  const send = (code, html, type = "text/html") => { res.writeHead(code, { "content-type": type }); res.end(html); };
  if (side === "A") {
    if (u.pathname === "/") return send(200, page(`<title>Shop</title>
<input id="name"><select id="country"><option value="de">Germany</option><option value="fr">France</option></select>
<button id="b">go</button><div id="dd" tabindex="0" style="width:120px;height:30px;border:1px solid #000">menu</div><div id="menu" hidden>open!</div>
<div id="plain">just text</div>
<iframe id="f" src="http://localhost:${PB}/frame.html" width="300" height="100"></iframe>
<script>window.EVENTS=[];
b.addEventListener('click',e=>EVENTS.push(['click',e.isTrusted]));
dd.addEventListener('mousedown',e=>{EVENTS.push(['dd-mousedown',e.isTrusted]); if(e.isTrusted) menu.hidden=false;});
country.addEventListener('change',e=>EVENTS.push(['change',e.isTrusted,country.value]));
name.addEventListener('input',e=>EVENTS.push(['input',e.isTrusted]));</script>`));
    if (u.pathname === "/term") return send(200, page(`<title>Term</title><textarea class="xterm-helper-textarea" id="t" style="width:300px;height:60px"></textarea>
<script>window.EVENTS=[];
t.addEventListener('keydown',e=>EVENTS.push(['keydown',e.key,e.ctrlKey,e.isTrusted]));
t.addEventListener('input',e=>EVENTS.push(['input',e.inputType,e.data,e.isTrusted]));</script>`));
    if (u.pathname === "/redirect") return send(200, page(`<title>Redirecting</title><script>setTimeout(()=>{location.href='http://localhost:${PB}/final'},700)</script>`));
    if (u.pathname === "/netpage") return send(200, page(`<title>Net</title><script>fetch('/start',{mode:'no-cors'}).then(()=>fetch('/plainreq',{mode:'no-cors'}));</script>`));
    if (u.pathname === "/start") { res.writeHead(302, { location: `http://localhost:${PB}/mid` }); return res.end(); }
    if (u.pathname === "/end" || u.pathname === "/plainreq") return send(200, "ok", "text/plain");
  } else {
    if (u.pathname === "/frame.html") return send(200, page(`<title>Frame</title><input id="email">
<script>window.EVENTS=[];email.addEventListener('input',e=>EVENTS.push(['input',e.inputType,e.isTrusted]));</script>`));
    if (u.pathname === "/final") return send(200, page(`<title>Final</title><p>landed</p>`));
    if (u.pathname === "/mid") { res.writeHead(302, { location: `http://127.0.0.1:${PA}/end` }); return res.end(); }
    if (u.pathname === "/blobmaker") return send(200, page(`<title>Blobmaker</title><script>setTimeout(()=>{location.href=URL.createObjectURL(new Blob(['<title>Secret</title><p>secret</p>'],{type:'text/html'}))},500)</script>`));
  }
  send(404, "nf", "text/plain");
}
const serve = (side) => new Promise((res) => { const s = http.createServer((q, r) => route(side, q, r)); s.listen(0, () => res({ s, port: s.address().port })); });
const A = await serve("A"), B = await serve("B"); PA = A.port; PB = B.port;
const URL_A = `http://127.0.0.1:${PA}`, URL_B = `http://localhost:${PB}`;

// ---- Chrome over a WebSocket ------------------------------------------------------------------------------------
// (On Windows the launched process exits at once and the real browser lives on: read the port from
// DevToolsActivePort in the throwaway profile, and close with Browser.close.)
const profile = mkdtempSync(join(tmpdir(), "tabduct-e2e-"));
const chrome = spawn(CHROME, ["--headless", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore", windowsHide: true });
const portFile = join(profile, "DevToolsActivePort");
for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(200);
if (!existsSync(portFile)) { console.error("Chrome did not start (no DevToolsActivePort)"); process.exit(1); }
const [cdpPort, cdpPath] = readFileSync(portFile, "utf8").trim().split("\n");
const ws = new WebSocket(`ws://127.0.0.1:${cdpPort}${cdpPath}`);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("CDP websocket failed"))); });
let nextId = 1; const waiting = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { const { res, rej } = waiting.get(m.id); waiting.delete(m.id); m.error ? rej(new Error(`${m.error.message} (${JSON.stringify(m.error.data ?? "")})`)) : res(m.result); }
});
const cdp = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = nextId++; waiting.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); rej(new Error(`CDP timeout: ${method}`)); } }, 30000);
});
async function finish(code) {
  try { await cdp("Browser.close"); } catch {}
  await sleep(500);
  try { chrome.kill(); } catch {}
  A.s.close(); B.s.close();
  console.log(code ? `\nE2E FAILED (${fails})` : "\nE2E PASSED");
  process.exit(code);
}
process.on("unhandledRejection", (e) => { console.error("  ERROR:", e); fails++; finish(1); });
setTimeout(() => { console.error("E2E TIMEOUT (240s)"); fails++; finish(1); }, 240000).unref();

// ---- load the extension, attach to its service worker ----------------------------------------------------------------
const { id: EXT } = await cdp("Extensions.loadUnpacked", { path: join(REPO, "extension") });
ok(!!EXT, `extension loaded unpacked (id ${EXT})`);
// A service worker can't import() modules, so the harness drives the extension's own modules
// (handlers, consent) from one of its pages: same APIs and permissions, same storage. The
// background worker keeps running for real (alarms, onInstalled...), and the Reload test below
// checks ITS behaviour through the shared storage.
async function swSession() {
  for (let i = 0; i < 30; i++) {
    const { targetId } = await cdp("Target.createTarget", { url: `chrome-extension://${EXT}/viewer.html?k=e2e` });
    const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
    await cdp("Runtime.enable", {}, sessionId);
    await sleep(300);
    // right after a Reload the extension's pages can open before the extension is ready: retry
    const t = await cdp("Runtime.evaluate", { expression: "typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL", returnByValue: true }, sessionId);
    if (t.result?.value === "function") return sessionId;
    try { await cdp("Target.closeTarget", { targetId }); } catch {}
    await sleep(500);
  }
  throw new Error("extension page never became usable");
}
let SW = await swSession();
// Run JS in the extension page; `H` = handlers module, `C` = consent module, helpers below.
const PRELUDE = `const H = await import(chrome.runtime.getURL("handlers/index.js")); const C = await import(chrome.runtime.getURL("consent.js"));
const call = async (name, args) => { try { return { ok: await H.HANDLERS[name](args) }; } catch (e) { return { err: e.code || String(e), msg: e.message }; } };
const openTab = async (url) => { const t = await chrome.tabs.create({ url, active: true }); for (let i = 0; i < 100; i++) { const x = await chrome.tabs.get(t.id); if (x.status === "complete" && !x.pendingUrl) return x.id; await new Promise(r => setTimeout(r, 100)); } return t.id; };
const evalIn = async (tabId, code, frameId) => (await chrome.scripting.executeScript({ target: frameId ? { tabId, frameIds: [frameId] } : { tabId }, world: "MAIN", func: (c) => (0, eval)(c), args: [code] }))[0].result;`;
async function sw(code) {
  const r = await cdp("Runtime.evaluate", { expression: `(async()=>{ ${PRELUDE} ${code} })()`, awaitPromise: true, returnByValue: true }, SW);
  if (r.exceptionDetails) throw new Error(`SW eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
const setDeny = (list, mode = "block") => sw(`await chrome.storage.local.set({ denyOrigins: ${JSON.stringify(list)}, originMode: ${JSON.stringify(mode)} });`);

try {
  // ======================================================================================================
  console.log("— B2: the page is pinned by documentId; a cross-host redirect is fine with lock off, a drift with lock on");
  await setDeny([]);
  let tab = await sw(`return await openTab(${JSON.stringify(URL_A + "/redirect")});`);
  let r = await sw(`return await call("wait_for", { tabId: ${tab}, urlContains: "/final", timeoutMs: 8000 });`);
  ok(r.ok?.matched === true, "lock off: wait_for follows a 127.0.0.1 → localhost redirect to completion", r);
  tab = await sw(`return await openTab(${JSON.stringify(URL_A + "/redirect")});`);
  r = await sw(`return await call("wait_for", { tabId: ${tab}, urlContains: "/final", timeoutMs: 8000, _pin: "127.0.0.1" });`);
  ok(r.err === "ORIGIN_DRIFT", "lock on (pinned to 127.0.0.1): the same wait ends in ORIGIN_DRIFT", r);
  r = await sw(`return await call("get_page_content", { tabId: ${tab}, _pin: "127.0.0.1" });`);
  ok(r.err === "ORIGIN_DRIFT", "...and so does a later read on the drifted page");
  r = await sw(`return await call("get_page_content", { tabId: ${tab} });`);
  ok(r.ok?.content?.includes("landed"), "lock off: the drifted page is readable", r);

  // ======================================================================================================
  console.log("— frames: cross-origin iframe (out-of-process), list / read / type, filter on it");
  tab = await sw(`return await openTab(${JSON.stringify(URL_A + "/")});`);
  r = await sw(`return await call("list_frames", { tabId: ${tab}, _pin: "127.0.0.1" });`);
  const frameId = r.ok?.frames?.find((f) => f.frameId !== 0)?.frameId;
  ok(r.ok?.frames?.length === 2 && frameId > 0, "list_frames shows the page and the cross-origin iframe", r);
  r = await sw(`return await call("get_page_content", { tabId: ${tab}, frameId: ${frameId}, _pin: "127.0.0.1" });`);
  ok(r.ok?.content === "", "the iframe document is read by its documentId (no visible text, but reachable)", r);
  r = await sw(`return await call("type", { tabId: ${tab}, frameId: ${frameId}, selector: "#email", text: "a@b.c", _pin: "127.0.0.1" });`);
  ok(r.ok?.typed === true, "scripted type into the cross-origin frame works", r);
  let ev = await sw(`return await evalIn(${tab}, "JSON.stringify(window.EVENTS)", ${frameId});`);
  ok(JSON.parse(ev).some((e) => e[0] === "input" && e[2] === false), "...as an untrusted event (isTrusted false) — the reason trusted input exists", ev);

  await setDeny(["localhost"]);
  r = await sw(`return await call("list_frames", { tabId: ${tab}, _pin: "127.0.0.1" });`);
  ok(r.ok?.frames?.length === 1, "origin filter blocks localhost: the iframe disappears from list_frames", r);
  r = await sw(`return await call("get_page_content", { tabId: ${tab}, frameId: ${frameId}, _pin: "127.0.0.1" });`);
  ok(r.err === "ORIGIN_DENIED", "...and reading it is ORIGIN_DENIED", r);
  r = await sw(`return await call("screenshot", { tabId: ${tab}, _pin: "127.0.0.1" });`);
  ok(r.err === "ORIGIN_DENIED", "screenshot of a page that shows the blocked site's iframe is refused (OPUS-5)", r);
  r = await sw(`return await call("press_key", { tabId: ${tab}, key: "Enter", _trusted: true, _pin: "127.0.0.1" });`);
  ok(r.err === "ORIGIN_DENIED", "trusted key press is refused too while that iframe is on screen", r);
  await setDeny([]);
  r = await sw(`return await call("screenshot", { tabId: ${tab}, _pin: "127.0.0.1" });`);
  ok(r.ok?.mimeType === "image/png" && r.ok?.dataUrl?.length > 500, "with the filter off the same screenshot works", r && { err: r.err, msg: r.msg });

  // ======================================================================================================
  console.log("— blob: document of a blocked site (OPUS-3)");
  await setDeny(["localhost"]);
  tab = await sw(`return await openTab(${JSON.stringify(URL_B + "/blobmaker")});`);
  let url = "";
  for (let i = 0; i < 40 && !url.startsWith("blob:"); i++) { await sleep(250); url = await sw(`return (await chrome.tabs.get(${tab})).url;`); }
  ok(url.startsWith("blob:http://localhost"), "the tab navigated itself to a blob: document of localhost", url);
  r = await sw(`return await call("get_page_content", { tabId: ${tab} });`);
  ok(r.err === "ORIGIN_DENIED", "reading it is ORIGIN_DENIED although the URL has no hostname of its own", r);
  ok(await sw(`return C.hostOf(${JSON.stringify(url)});`) === "localhost", "hostOf resolves the blob's real host");
  await setDeny([]);
  r = await sw(`return await call("get_page_content", { tabId: ${tab} });`);
  ok(r.ok?.content?.includes("secret"), "with the filter off the blob document reads normally", r);

  // ======================================================================================================
  console.log("— F1: trusted typing, key presses and clicks are really isTrusted");
  tab = await sw(`return await openTab(${JSON.stringify(URL_A + "/term")});`);
  r = await sw(`return await call("type", { tabId: ${tab}, selector: ".xterm-helper-textarea", text: "echo hello", trusted: true });`);
  ok(r.err === "CDP_NOT_PERMITTED", "trusted type without the gate's opt-in is refused", r);
  r = await sw(`return await call("type", { tabId: ${tab}, selector: ".xterm-helper-textarea", text: "echo hello", trusted: true, _trusted: true });`);
  ok(r.ok?.trusted === true, "trusted type succeeds", r);
  r = await sw(`return await call("press_key", { tabId: ${tab}, key: "Enter", _trusted: true });`);
  ok(r.ok?.pressed === true, "press_key Enter succeeds", r);
  r = await sw(`return await call("press_key", { tabId: ${tab}, key: "c", modifiers: ["ctrl"], _trusted: true });`);
  ev = JSON.parse(await sw(`return await evalIn(${tab}, "JSON.stringify(window.EVENTS)");`));
  ok(ev.some((e) => e[0] === "input" && e[1] === "insertText" && e[2] === "echo hello" && e[3] === true), "the page saw the text as a trusted insertText event", ev);
  ok(ev.some((e) => e[0] === "keydown" && e[1] === "Enter" && e[3] === true), "the page saw a trusted Enter keydown", ev);
  ok(ev.some((e) => e[0] === "keydown" && e[1] === "c" && e[2] === true && e[3] === true), "the page saw a trusted Ctrl+C", ev);
  ok((await sw(`return await evalIn(${tab}, "document.getElementById('t').value");`)).startsWith("echo hello"), "and the text really is in the field (Enter added the newline)");

  tab = await sw(`return await openTab(${JSON.stringify(URL_A + "/")});`);
  r = await sw(`return await call("click", { tabId: ${tab}, selector: "#dd" });`);
  ok(r.ok?.clicked === true, "a scripted click on the custom dropdown runs", r);
  ok(await sw(`return await evalIn(${tab}, "document.getElementById('menu').hidden");`) === true, "...but the menu stays closed: the control ignores untrusted events");
  r = await sw(`return await call("click", { tabId: ${tab}, selector: "#dd", trusted: true, _trusted: true });`);
  ok(r.ok?.trusted === true, "the trusted click goes through", r);
  ok(await sw(`return await evalIn(${tab}, "document.getElementById('menu').hidden");`) === false, "...and opens the menu (real mouse events)");
  r = await sw(`return await call("click", { tabId: ${tab}, selector: "#plain", trusted: true, _trusted: true });`);
  ok(r.ok?.clicked === true, "trusted click on a plain element works", r);

  // trusted typing INTO the cross-origin frame
  r = await sw(`return await call("list_frames", { tabId: ${tab}, _pin: "127.0.0.1" });`);
  const fid2 = r.ok?.frames?.find((f) => f.frameId !== 0)?.frameId;
  r = await sw(`return await call("type", { tabId: ${tab}, frameId: ${fid2}, selector: "#email", text: "real@typing.io", trusted: true, _trusted: true, _pin: "127.0.0.1" });`);
  ok(r.ok?.trusted === true, "trusted type INTO the cross-origin iframe succeeds", r);
  ev = JSON.parse(await sw(`return await evalIn(${tab}, "JSON.stringify(window.EVENTS)", ${fid2});`));
  ok(ev.some((e) => e[0] === "input" && e[1] === "insertText" && e[2] === true), "...and that frame saw trusted input", ev);
  ok(await sw(`return await evalIn(${tab}, "document.getElementById('email').value", ${fid2});`) === "real@typing.io", "the cross-origin field holds the text");
  r = await sw(`return await call("click", { tabId: ${tab}, frameId: ${fid2}, selector: "#email", trusted: true, _trusted: true, _pin: "127.0.0.1" });`);
  ok(r.err === "INVALID_ARGS" && /cross-origin/.test(r.msg || ""), "a trusted click can't be placed inside a cross-origin frame — clear INVALID_ARGS with advice", r);

  // ======================================================================================================
  console.log("— type on <select>, selectors, editability");
  r = await sw(`return await call("type", { tabId: ${tab}, selector: "#country", text: "France" });`);
  ok(r.ok?.typed === true, "type on <select> picks the option by its visible text", r);
  ev = JSON.parse(await sw(`return await evalIn(${tab}, "JSON.stringify(window.EVENTS)");`));
  ok(ev.some((e) => e[0] === "change" && e[2] === "fr"), "...and fires change with the new value", ev);
  ok(await sw(`return await evalIn(${tab}, "document.getElementById('country').options.length");`) === 2, "...the options are all still there (the old code wiped them)");
  r = await sw(`return await call("type", { tabId: ${tab}, selector: "#country", text: "Atlantis" });`);
  ok(r.err === "INVALID_ARGS" && /Germany/.test(r.msg || ""), "an unknown option is INVALID_ARGS listing the real ones", r);
  r = await sw(`return await call("type", { tabId: ${tab}, selector: "#plain", text: "x" });`);
  ok(r.err === "INVALID_ARGS", "typing into a non-editable <div> is INVALID_ARGS (it used to overwrite its content)", r);
  r = await sw(`return await call("click", { tabId: ${tab}, selector: "button:contains('go')" });`);
  ok(r.err === "INVALID_ARGS" && /invalid CSS selector/.test(r.msg || ""), "an invalid CSS selector is reported as such", r);
  r = await sw(`return await call("wait_for", { tabId: ${tab}, selector: "button:contains('go')", timeoutMs: 1000 });`);
  ok(r.err === "INVALID_ARGS", "wait_for with an invalid selector fails at once instead of waiting out the timeout", r);

  // ======================================================================================================
  console.log("— network buffer: a redirect chain is hidden when ANY hop is on a filtered origin (CDX-5)");
  await setDeny([]);
  tab = await sw(`return await openTab("about:blank");`);
  await sw(`await C.setShareOptions({ allowCdp: true, cdpConsole: true }); await H.startCdpConsole(${tab}); return 1;`);
  await sw(`await chrome.tabs.update(${tab}, { url: ${JSON.stringify(URL_A + "/netpage")} }); await new Promise(r => setTimeout(r, 2500)); return 1;`);
  r = await sw(`return await call("list_network_requests", { tabId: ${tab}, urlContains: "/", limit: 100 });`);
  const urls = (r.ok?.requests || []).map((q) => q.url);
  ok(urls.some((u) => u.endsWith("/end")) && urls.some((u) => u.endsWith("/plainreq")), "unfiltered: the redirected request (final URL /end) and the plain one are listed", urls);
  await setDeny(["localhost"]);
  r = await sw(`return await call("list_network_requests", { tabId: ${tab}, urlContains: "/", limit: 100 });`);
  const urls2 = (r.ok?.requests || []).map((q) => q.url);
  ok(!urls2.some((u) => u.endsWith("/end")), "localhost blocked: the request whose redirect HOP was localhost is hidden although it ended on an allowed host", urls2);
  ok(urls2.some((u) => u.endsWith("/plainreq")), "...unrelated requests stay", urls2);
  await sw(`await H.stopAllCdpConsole(); await C.setShareOptions({ allowCdp: false, cdpConsole: false }); return 1;`);

  // ======================================================================================================
  console.log("— B7: restoring shares after an extension Reload (real storage and real tab ids)");
  // chrome.runtime.reload() can't be driven here: an extension installed through CDP isn't persisted
  // in the profile, so Chrome doesn't bring it back. A real Reload wipes storage.session and fires
  // runtime.onInstalled with reason "update" (documented Chrome behaviour, handled in background.js);
  // this checks the part in between on the real engine: the mirror in storage.local and the restore.
  await setDeny([]);
  const tabKeep = await sw(`return await openTab(${JSON.stringify(URL_A + "/")});`);
  const tabMoved = await sw(`return await openTab(${JSON.stringify(URL_A + "/term")});`);
  await sw(`await C.setTier("none"); await C.shareTab(${tabKeep}); await C.shareTab(${tabMoved}); return 1;`);
  ok((await sw(`return Object.keys((await C.getState()).allow);`)).length === 2, "two tabs shared; the mirror is in storage.local");
  await sw(`await chrome.tabs.update(${tabMoved}, { url: ${JSON.stringify(URL_B + "/final")} }); await new Promise(r => setTimeout(r, 1200)); return 1;`);
  await sw(`await chrome.storage.session.remove("consent"); return 1;`); // what a Reload does to the session
  ok((await sw(`return (await C.getState()).tier;`)) === "none", "after the wipe nothing is shared");
  const n = await sw(`return await C.restoreFromMirror(await chrome.tabs.query({}), Date.now());`);
  const after = await sw(`return Object.keys((await C.getState()).allow);`);
  ok(n === 1 && after.includes(String(tabKeep)) && !after.includes(String(tabMoved)), "restored only the tab that is still on the host it was shared on (the other navigated away)", { n, after, tabKeep, tabMoved });
  ok((await sw(`const r = await call("get_page_content", { tabId: ${tabKeep}, _pin: "127.0.0.1" }); return r.ok ? "ok" : r.err;`)) === "ok", "...and it works again");
} catch (e) { console.error("  ERROR:", e.stack || e); fails++; }

await finish(fails ? 1 : 0);
