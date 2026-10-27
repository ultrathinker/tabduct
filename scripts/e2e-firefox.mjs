#!/usr/bin/env node
// OPT-IN end-to-end test of the Firefox build in a REAL Firefox (headless, throwaway profile) - not part of `npm test`:
//   node scripts/e2e-firefox.mjs          (or: npm run test:e2e-firefox)
// It builds the Firefox extension (scripts/build-firefox.mjs), starts a SEPARATE Firefox (-no-remote, throwaway profile: your own
// Firefox and profile are never touched), installs the build as a temporary add-on through Marionette and drives it like
// scripts/e2e-chrome.mjs drives Chrome: the extension's own modules (handlers, consent, platform) run in an extension page
// of the test build, fed with code by this script, against real pages (two origins, an iframe). The native host is not
// involved at this layer, and nothing is written to the registry.
// Set FIREFOX to use a particular binary; the test skips when none is found (Firefox Developer Edition, Nightly or ESR
// load an unsigned build; a release Firefox refuses it).

import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build-firefox.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATES = [process.env.FIREFOX, "C:\\Program Files\\Firefox Developer Edition\\firefox.exe", "C:\\Program Files\\Firefox Nightly\\firefox.exe", "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
  "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox", "/Applications/Firefox Nightly.app/Contents/MacOS/firefox", "/Applications/Firefox.app/Contents/MacOS/firefox", "/usr/bin/firefox-developer-edition", "/usr/bin/firefox-esr", "/usr/bin/firefox"].filter(Boolean);
const FIREFOX = CANDIDATES.find((p) => existsSync(p));
if (!FIREFOX) { console.log("SKIP: no Firefox found (set FIREFOX)"); process.exit(0); }

let fails = 0;
const ok = (c, m, extra) => { if (!c) { console.error("  FAIL:", m, extra !== undefined ? JSON.stringify(extra) : ""); fails++; } else console.log("  ok:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the test build: the real build plus a test page that runs modules this script serves ------------------------------------------------
const base = mkdtempSync(join(tmpdir(), "tabduct-ff-e2e-"));
const out = join(base, "ext");
build({ out });
const EXT_UUID = "5d1c2f0a-8e44-4b7a-9d0e-3f6a2b1c7e90";
const GECKO_ID = JSON.parse(readFileSync(join(REPO, "firefox", "manifest.patch.json"), "utf8")).set.browser_specific_settings.gecko.id;

// ---- servers: the runner (modules, results, a long poll) and two test sites on different origins --------------------------------------------
const results = new Map(); const queue = []; const modules = new Map(); let waiter = null; let nextId = 1;
let PA = 0, PB = 0;
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST" };
const html = (b) => `<!doctype html><meta charset="utf-8">${b}`;
function site(side, q, r) {
  const send = (code, body, type = "text/html") => { r.writeHead(code, { "content-type": type, ...cors }); r.end(body); };
  const u = new URL(q.url, "http://x");
  if (q.method === "OPTIONS") return send(204, "");
  if (u.pathname === "/ping") return send(200, "pong", "text/plain");
  if (side === "A") {
    if (u.pathname === "/page") return send(200, html(`<title>Shop</title><input id="name"><button id="b">go</button><div id="plain">hello shop</div><iframe id="f" src="http://localhost:${PB}/frame" width="300" height="80"></iframe>
<script>window.EVENTS=[]; b.addEventListener('click',e=>EVENTS.push(['click',e.isTrusted])); name.addEventListener('input',e=>EVENTS.push(['input',e.isTrusted]));</script>`));
    if (u.pathname === "/next") { // long poll: the test page asks for its next module
      const give = (id) => send(200, JSON.stringify({ id }), "application/json");
      if (queue.length) return give(queue.shift());
      const t = setTimeout(() => { waiter = null; send(204, ""); }, 20000);
      waiter = (id) => { clearTimeout(t); waiter = null; give(id); };
      return;
    }
    if (u.pathname.startsWith("/m/")) { const id = Number(u.pathname.slice(3).replace(".mjs", "")); return send(200, modules.get(id) ?? "export default async () => 'missing module'", "text/javascript"); }
    if (u.pathname.startsWith("/result/") && q.method === "POST") { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => { results.get(Number(u.pathname.slice(8)))?.(b); send(200, "ok", "text/plain"); }); return; }
    if (u.pathname === "/hello") return send(200, "hello", "text/plain");
  } else {
    if (u.pathname === "/frame") return send(200, html(`<title>Frame</title><input id="email">in the frame`));
    if (u.pathname === "/other") return send(200, html(`<title>Other site</title>another origin`));
  }
  send(404, "nf", "text/plain");
}
const serve = (side) => new Promise((res) => { const s = http.createServer((q, r) => site(side, q, r)); s.listen(0, "127.0.0.1", () => res({ s, port: s.address().port })); });
const A = await serve("A"), B = await serve("B"); PA = A.port; PB = B.port;
const URL_A = `http://127.0.0.1:${PA}`, URL_B = `http://localhost:${PB}`;

// the extension side of the harness: a page that imports the real modules and runs what this script sends it
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "test-boot.js"), `chrome.tabs.create({ url: chrome.runtime.getURL("test-page.html"), active: false });\n`);
writeFileSync(join(out, "test-page.html"), `<!doctype html><meta charset="utf-8"><title>Tabduct e2e driver</title><script type="module" src="test-page.js"></script>`);
writeFileSync(join(out, "test-page.js"), `
import * as H from "./handlers/index.js";
import * as C from "./consent.js";
import * as P from "./platform.js";
const RUNNER = "http://127.0.0.1:${PA}";
const env = { H, C, P, call: async (name, args) => { try { return { ok: await H.HANDLERS[name](args) }; } catch (e) { return { err: e.code || String(e), msg: e.message }; } } };
for (;;) {
  let id;
  try { const r = await fetch(RUNNER + "/next"); if (r.status === 204) continue; id = (await r.json()).id; } catch { await new Promise((r) => setTimeout(r, 500)); continue; }
  let out;
  try { const m = await import(RUNNER + "/m/" + id + ".mjs"); out = { value: await m.default(env) }; } catch (e) { out = { error: String(e?.stack ?? e) }; }
  await fetch(RUNNER + "/result/" + id, { method: "POST", body: JSON.stringify(out) });
}
`);
{
  const mf = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  mf.background.scripts = ["test-boot.js", ...mf.background.scripts];
  mf.content_security_policy = { extension_pages: "script-src 'self' http://127.0.0.1:*; object-src 'self'" };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(mf, null, 2));
}

// Runs `body` (an async function source taking `{ H, C, P, call }`) inside the extension page and returns what it returns.
async function ext(body, ms = 30000) {
  const id = nextId++;
  modules.set(id, `export default async (env) => { const { H, C, P, call } = env; ${body} };`);
  const p = new Promise((res, rej) => { results.set(id, (t) => res(JSON.parse(t))); setTimeout(() => rej(new Error("no answer from the extension page")), ms); });
  if (waiter) waiter(id); else queue.push(id);
  const r = await p;
  if (r.error) throw new Error("module failed: " + r.error);
  return r.value;
}

// ---- Firefox, started as a separate hidden process ----------------------------------------------------------------------------------------
const MARIONETTE = 2829;
const profile = join(base, "profile"); mkdirSync(profile, { recursive: true });
writeFileSync(join(profile, "user.js"), [
  `user_pref("marionette.port", ${MARIONETTE});`, `user_pref("xpinstall.signatures.required", false);`, `user_pref("extensions.autoDisableScopes", 0);`,
  `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [GECKO_ID]: EXT_UUID }))});`,
  `user_pref("browser.shell.checkDefaultBrowser", false);`, `user_pref("datareporting.policy.dataSubmissionEnabled", false);`, `user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);`,
  `user_pref("app.update.auto", false);`, `user_pref("app.update.enabled", false);`, `user_pref("browser.startup.homepage", "about:blank");`, `user_pref("startup.homepage_welcome_url", "about:blank");`,
].join("\n"));
const ff = spawn(FIREFOX, ["-profile", profile, "-no-remote", "-headless", "-marionette"], { stdio: "ignore", windowsHide: true });

let sock = null, buf = ""; const waiting = new Map(); let mid = 1;
const drain = () => { for (;;) { const c = buf.indexOf(":"); if (c < 0) return; const n = Number(buf.slice(0, c)); const rest = Buffer.from(buf.slice(c + 1)); if (rest.length < n) return; const m = JSON.parse(rest.subarray(0, n).toString()); buf = rest.subarray(n).toString(); if (Array.isArray(m) && m[0] === 1 && waiting.has(m[1])) { const { res, rej } = waiting.get(m[1]); waiting.delete(m[1]); m[2] ? rej(new Error(JSON.stringify(m[2]))) : res(m[3]); } } };
const cmd = (name, params = {}) => new Promise((res, rej) => { const id = mid++; waiting.set(id, { res, rej }); const b = JSON.stringify([0, id, name, params]); sock.write(`${Buffer.byteLength(b)}:${b}`); setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); rej(new Error(`timeout ${name}`)); } }, 30000); });
async function finish(code) {
  try { await cmd("Marionette:Quit", { flags: ["eForceQuit"] }); } catch {}
  await sleep(1000); try { ff.kill(); } catch {}
  A.s.close(); B.s.close();
  console.log(code ? `\nFIREFOX E2E FAILED (${fails})` : "\nFIREFOX E2E PASSED");
  process.exit(code);
}
process.on("unhandledRejection", (e) => { console.error("  ERROR:", e); fails++; finish(1); });
setTimeout(() => { console.error("FIREFOX E2E TIMEOUT (180 s)"); fails++; finish(1); }, 180000).unref();

for (let i = 0; i < 60 && !sock; i++) { try { sock = await new Promise((res, rej) => { const s = net.connect(MARIONETTE, "127.0.0.1", () => res(s)); s.once("error", rej); }); } catch { await sleep(500); } }
if (!sock) { console.error("Firefox did not come up (no Marionette)"); fails++; await finish(1); }
sock.on("data", (d) => { buf += d.toString(); drain(); });
await sleep(1500);
await cmd("WebDriver:NewSession", { capabilities: {} });
console.log("— the Firefox build loads as a temporary add-on");
const addonId = (await cmd("Addon:Install", { path: out, temporary: true })).value;
ok(addonId === GECKO_ID, `installed with the add-on id from firefox/manifest.patch.json (${addonId})`);

try {
  // ======================================================================================================
  console.log("— platform: Firefox has no debugger API and no tab-group API; the extension knows");
  let r = await ext(`return { ff: P.isFirefox(), name: P.browserName(), dbg: P.hasDebugger(), groups: P.hasTabGroups(), ver: chrome.runtime.getManifest().version, st: P.withPlatform({ allowCdp: true, cdpAlways: true, cdpConsole: true }) };`);
  ok(r.ff === true && r.name === "firefox" && r.dbg === false && r.groups === false, "isFirefox, no debugger, no tab groups", r);
  ok(r.st.allowCdp === false && r.st.cdpAlways === false && r.st.cdpConsole === false, "withPlatform turns the CDP opt-ins off whatever was stored");

  // ======================================================================================================
  console.log("— tools on real pages (consent store + handlers, scripting engine)");
  const tab = await ext(`const t = await chrome.tabs.create({ url: ${JSON.stringify(URL_A + "/page")}, active: true }); for (let i = 0; i < 100; i++) { const x = await chrome.tabs.get(t.id); if (x.status === "complete") break; await new Promise((r) => setTimeout(r, 100)); } await new Promise((r) => setTimeout(r, 500)); await C.setTier("none"); await C.shareTab(t.id); return t.id;`);
  const call = (name, args) => ext(`return await call(${JSON.stringify(name)}, ${JSON.stringify(args)});`);
  r = await call("get_page_content", { tabId: tab });
  ok(r.ok?.content?.includes("hello shop"), "get_page_content reads the page", r);
  r = await call("execute_script", { tabId: tab, code: "return document.title" });
  ok(r.ok?.result === "Shop", "execute_script runs a script and returns its value (scripting engine)", r);
  r = await call("list_frames", { tabId: tab });
  const frames = r.ok?.frames || [];
  ok(frames.length === 2 && frames.some((f) => f.frameId === 0) && frames.some((f) => /\/frame$/.test(f.url || "")), "list_frames sees the page and the cross-origin iframe", frames.map((f) => [f.frameId, f.url]));
  r = await call("get_page_content", { tabId: tab, frameId: frames.find((f) => f.frameId !== 0)?.frameId });
  ok(r.ok?.content?.includes("in the frame"), "...and reads the content of that iframe (frameId, documentId pinned)", r);
  r = await call("click", { tabId: tab, selector: "#b" });
  const ev1 = await call("execute_script", { tabId: tab, code: "return window.EVENTS" });
  ok(r.ok && JSON.stringify(ev1.ok?.result) === JSON.stringify([["click", false]]), "click: a script click (untrusted, as in Chrome without CDP)", { r, ev1 });
  r = await call("type", { tabId: tab, selector: "#name", text: "abc" });
  const v = await call("execute_script", { tabId: tab, code: "return document.getElementById('name').value" });
  ok(r.ok && v.ok?.result === "abc", "type: fills the field", { r, v });
  r = await call("wait_for", { tabId: tab, text: "hello shop", timeoutMs: 3000 });
  ok(r.ok?.matched === true, "wait_for text", r);
  r = await call("get_dom_snapshot", { tabId: tab });
  ok(/button/i.test(JSON.stringify(r.ok || {})), "get_dom_snapshot lists the button", r);
  r = await call("screenshot", { tabId: tab });
  ok(typeof r.ok?.dataUrl === "string" ? r.ok.dataUrl.startsWith("data:image/") : !!r.ok, "screenshot of the active tab returns an image", Object.keys(r.ok || r));

  // ======================================================================================================
  console.log("— what needs the debugger is refused by name, not by crashing");
  r = await call("execute_script", { tabId: tab, code: "return 1", _engine: "cdp", _allowCdp: true });
  ok(r.err === "CDP_NOT_PERMITTED", "execute_script forced onto CDP: CDP_NOT_PERMITTED", r);
  r = await call("press_key", { tabId: tab, key: "Enter", _trusted: true });
  ok(r.err === "CDP_NOT_PERMITTED", "press_key (trusted input): CDP_NOT_PERMITTED", r);

  // ======================================================================================================
  console.log("— lock to domain: the page is pinned by documentId; a tab that moves to another origin is refused");
  await ext(`await C.setShareOptions({ lockToDomain: true }); return 1;`);
  await ext(`await chrome.tabs.update(${tab}, { url: ${JSON.stringify(URL_B + "/other")} }); await new Promise((r) => setTimeout(r, 1500)); return 1;`);
  r = await call("get_page_content", { tabId: tab, _pin: "127.0.0.1" });
  ok(r.err === "ORIGIN_DRIFT", "pinned to 127.0.0.1, the tab is now on localhost: ORIGIN_DRIFT", r);
  r = await call("get_page_content", { tabId: tab });
  ok(r.ok?.content?.includes("another origin"), "...without the pin the same page reads fine (the pin is what refuses)", r);

  // ======================================================================================================
  console.log("— the popup, drawn by Firefox against the real background");
  r = await ext(`
    await chrome.tabs.update(${tab}, { url: ${JSON.stringify(URL_A + "/page")} }); await new Promise((r) => setTimeout(r, 1200));
    await C.shareTab(${tab});
    const f = document.createElement("iframe"); f.src = chrome.runtime.getURL("popup.html"); f.style.width = "400px"; f.style.height = "500px"; document.body.appendChild(f);
    await new Promise((r) => setTimeout(r, 2500));
    const d = f.contentDocument;
    const hidden = (sel) => [...d.querySelectorAll(sel)].map((e) => e.hidden);
    return { debuggerHidden: hidden('[data-needs="debugger"]'), groupsHidden: hidden('[data-needs="tabgroups"]'), bells: [...d.querySelectorAll("#shared .wk")].map((b) => b.textContent), silent: !!d.getElementById("silent"), ver: d.getElementById("ver")?.textContent };
  `);
  ok(r.debuggerHidden.length >= 1 && r.debuggerHidden.every(Boolean), "the CDP settings are not offered in Firefox", r);
  ok(r.groupsHidden.length >= 1 && r.groupsHidden.every(Boolean), "...nor the tab-group settings", r);
  ok(r.bells.length === 1 && r.bells[0] === "🔔" && r.silent === true, "the shared tab has its bell, and the Silent button is there", r);
  ok(/Tabduct v/.test(r.ver || ""), "the popup says which version it is", r);
} catch (e) { console.error("  ERROR:", e.stack || e); fails++; }

await finish(fails ? 1 : 0);
