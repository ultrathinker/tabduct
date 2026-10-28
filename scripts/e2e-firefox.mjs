#!/usr/bin/env node
// OPT-IN end-to-end test of the Firefox build in a REAL Firefox (headless, throwaway profile) - not part of `npm test`:
//   node scripts/e2e-firefox.mjs          (or: npm run test:e2e-firefox)
// It builds the Firefox extension (scripts/build-firefox.mjs), starts a SEPARATE Firefox (-no-remote, throwaway profile: your own
// Firefox and profile are never touched), installs the build as a temporary add-on through Marionette and drives it like
// scripts/e2e-chrome.mjs drives Chrome: the extension's own modules (handlers, consent, platform) run in an extension page
// of the test build, fed with code by this script, against real pages (two origins, an iframe). The native host is not
// involved in the first part. The last part runs the WHOLE chain (Firefox -> native host -> hub -> an MCP client) in an isolated
// TABDUCT_DIR with a test hub port (your live hub is never touched); it needs the native-messaging manifest registered for Firefox
// (`node hosts/node/bin/tabduct.js register --browser firefox`) and is skipped, with a note, when it is not. This script writes nothing
// to the registry itself.
// Set FIREFOX to use a particular binary; the test skips when none is found (Firefox Developer Edition, Nightly or ESR
// load an unsigned build; a release Firefox refuses it).

import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { manifestDir, windowsRegKey } from "../hosts/node/src/register.js";
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
    if (u.pathname === "/csp") { r.writeHead(200, { "content-type": "text/html", "content-security-policy": "default-src 'self'; img-src 'self'", ...cors }); return r.end(html(`<title>Strict CSP page</title><link rel="icon" href="/orig.png">hello csp`)); }
    if (u.pathname === "/icon") return send(200, html(`<title>Icon page</title><link rel="icon" type="image/png" href="/orig.png">hello icon`));
    if (u.pathname === "/orig.png") { r.writeHead(200, { "content-type": "image/png", ...cors }); return r.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64")); }
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
const hubDir = join(base, "hub");
const hubPort = 12800 + Math.floor(Date.now() % 900);
const ff = spawn(FIREFOX, ["-profile", profile, "-no-remote", "-headless", "-marionette"], { stdio: "ignore", windowsHide: true, env: { ...process.env, TABDUCT_DIR: hubDir, TABDUCT_HUB_PORT: String(hubPort), TABDUCT_HUB_IDLE_MS: "4000" } });
const nativeHostRegistered = () => {
  if (process.platform === "win32") return spawnSync("reg", ["query", windowsRegKey("firefox")], { windowsHide: true }).status === 0;
  const d = manifestDir("firefox"); return !!d && existsSync(join(d, "com.tabduct.host.json"));
};
function mcp(body, { sessionId, token } = {}) {
  return new Promise((resolve) => {
    const pl = Buffer.from(JSON.stringify(body));
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": pl.length };
    if (token) headers.authorization = `Bearer ${token}`; if (sessionId) headers["mcp-session-id"] = sessionId;
    const req = http.request({ host: "127.0.0.1", port: hubPort, path: "/mcp", method: "POST", headers }, (r) => {
      let d = ""; r.on("data", (x) => (d += x)); r.on("end", () => { let j; if ((r.headers["content-type"] || "").includes("text/event-stream")) { const l = d.split("\n").filter((x) => x.startsWith("data:")).pop(); j = l ? JSON.parse(l.slice(5).trim()) : undefined; } else if (d) { try { j = JSON.parse(d); } catch {} } resolve({ status: r.statusCode, json: j, sessionId: r.headers["mcp-session-id"] }); });
    });
    req.on("error", () => resolve({ status: "REFUSED" })); req.end(pl);
  });
}

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
setTimeout(() => { console.error("FIREFOX E2E TIMEOUT (240 s)"); fails++; finish(1); }, 240000).unref();

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
  console.log("— platform: Firefox has no debugger API but has tab groups; the extension knows");
  let r = await ext(`return { ff: P.isFirefox(), name: P.browserName(), dbg: P.hasDebugger(), groups: P.hasTabGroups(), ver: chrome.runtime.getManifest().version, st: P.withPlatform({ allowCdp: true, cdpAlways: true, cdpConsole: true }) };`);
  ok(r.ff === true && r.name === "firefox" && r.dbg === false && r.groups === true, "isFirefox, no debugger, but tab groups (the \⚡ group works as in Chrome)", r);
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
    return { debuggerHidden: hidden('[data-needs="debugger"]'), groupsHidden: hidden('[data-needs="tabgroups"]'), bells: [...d.querySelectorAll("#shared .wk")].map((b) => b.textContent), silent: !!d.getElementById("silent"), ver: d.getElementById("ver")?.textContent, shared: d.getElementById("shared")?.innerText };
  `);
  ok(r.debuggerHidden.length >= 1 && r.debuggerHidden.every(Boolean), "the CDP settings are not offered in Firefox", r);
  ok(r.groupsHidden.length >= 1 && r.groupsHidden.every((h) => h === false), "...but the tab-group settings are (Firefox has tab groups)", r);
  ok(r.bells.length >= 1 && r.bells[0] === "🔔" && r.silent === true, "the shared tab has its bell, and the Silent button is there", r);
  ok(/Tabduct v/.test(r.ver || ""), "the popup says which version it is", r);

  // ======================================================================================================
  console.log("— the whole chain: Firefox -> native host -> hub -> an MCP client (isolated hub, test port)");
  if (!nativeHostRegistered()) {
    console.log("  SKIP: the native-messaging manifest is not registered for Firefox (node hosts/node/bin/tabduct.js register --browser firefox)");
  } else {
    r = await ext(`const answer = await chrome.runtime.sendMessage({ cmd: "connect", port: 0 }); let st = answer; for (let i = 0; i < 60 && st?.state !== "connected"; i++) { await new Promise((r) => setTimeout(r, 500)); st = await chrome.runtime.sendMessage({ cmd: "status" }); } return st;`, 60000);
    ok(r?.state === "connected", "the extension connects: Firefox starts the native host, which starts the (isolated) hub", r);
    let tAgent = null;
    for (let i = 0; i < 50 && !tAgent; i++) { await sleep(200); try { tAgent = JSON.parse(readFileSync(join(hubDir, "token"), "utf8")).tAgent; } catch {} }
    ok(!!tAgent, "the hub came up in the isolated folder and wrote its token");
    const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } }, { token: tAgent });
    const sid = init.sessionId;
    await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { sessionId: sid, token: tAgent });
    const tool = async (name, args) => { const x = await mcp({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method: "tools/call", params: { name, arguments: args } }, { sessionId: sid, token: tAgent }); const c = x.json?.result?.content?.[0]; return { isError: !!x.json?.result?.isError, text: c?.text, type: c?.type, raw: x.json }; };
    const js = (t) => { try { return JSON.parse(t); } catch { return null; } };
    let inst = null;
    for (let i = 0; i < 40 && !inst; i++) { const li = js((await tool("list_instances", {})).text); inst = li?.instances?.find((x) => x.browser === "firefox") ?? null; if (!inst) await sleep(500); }
    ok(!!inst, "the agent sees the Firefox as an instance behind the hub", inst);
    ok(inst?.extensionVersion === JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).version && !inst?.features?.includes("cdp-input") && inst?.features?.includes("frames"), "...with the extension version, no 'cdp-input' feature and the others", inst);
    ok(/^Firefox-[a-z]{4}$/.test(inst?.label || ""), "...and a label that says Firefox", inst?.label);
    const lt = js((await tool("list_tabs", {})).text);
    const mine = (lt?.tabs || []).find((t) => t.url?.startsWith(URL_A));
    ok(!!mine && mine.id.startsWith(inst.instanceId + ":"), "list_tabs shows the shared tab with a composite id", lt?.tabs?.map((t) => t.url));
    let t = await tool("get_page_content", { tabId: mine.id });
    ok(!t.isError && /hello shop/.test(t.text || ""), "get_page_content through the hub reads the page", t.text?.slice(0, 120));
    t = await tool("execute_script", { tabId: mine.id, code: "return document.title" });
    ok(!t.isError && /^(⚡ )?Shop$/.test(js(t.text)?.result || ""), "execute_script through the hub (the page's own script sees the mark on its title: the mark is visible to the page)", t.text);
    t = await tool("screenshot", { tabId: mine.id });
    ok(t.type === "image", "screenshot comes back as an image through the hub", t.type);
    t = await tool("press_key", { tabId: mine.id, key: "Enter" });
    ok(t.isError && /CDP_NOT_PERMITTED/.test(t.text || "") && /Firefox/.test(t.text || "") && !/EXTENSION_OUTDATED/.test(t.text || ""), "press_key: the hub refuses it by name (Firefox has no debugger API), not as 'outdated'", t.text?.slice(0, 200));
    t = await tool("get_page_content", { tabId: mine.id, quiet: true });
    ok(!t.isError, "a quiet read works too", t.text?.slice(0, 100));
    // the popup while connected (it also lists the other browsers behind the hub): one browser, one row per shared tab, no duplicates
    r = await ext(`
      const f = document.createElement("iframe"); f.src = chrome.runtime.getURL("popup.html"); f.style.width = "400px"; f.style.height = "500px"; document.body.appendChild(f);
      await new Promise((r) => setTimeout(r, 3500));
      const d = f.contentDocument;
      return { rows: [...d.querySelectorAll("#shared li:not(.grp)")].map((li) => li.querySelector(".ttl")?.textContent), groups: [...d.querySelectorAll("#shared li.grp")].map((li) => li.textContent), dot: d.getElementById("dot")?.dataset.state };
    `);
    ok(r.dot === "connected" && r.rows.length === 1 && r.groups.length === 0, "the connected popup lists the one shared tab once (no group header, no duplicate row)", r);
    // ---- the "\⚡" tab group: named and coloured in Firefox as in Chrome, and in sync with sharing both ways
    console.log("— the \⚡ tab group (Firefox 139+ names and colours it like Chrome)");
    const unshare = (id) => ext(`await chrome.runtime.sendMessage({ cmd: "sharing.unshare", tabId: ${id} }); return 1;`);
    const grp = (id) => ext(`const t = await chrome.tabs.get(${id}); const g = t.groupId >= 0 ? await chrome.tabGroups.get(t.groupId) : null; return { groupId: t.groupId, title: g?.title, color: g?.color };`);
    await ext(`await chrome.runtime.sendMessage({ cmd: "sharing.setTabGroup", on: true }); return 1;`);
    await sleep(3000);
    r = await grp(tab);
    ok(r.groupId >= 0 && r.title === "\⚡" && r.color === "purple", "a shared tab sits in a named, coloured \⚡ group", r);
    const gid = r.groupId;
    const tabIn = await ext(`const t = await chrome.tabs.create({ url: ${JSON.stringify(URL_A + "/hello")}, active: false }); for (let i = 0; i < 100; i++) { const x = await chrome.tabs.get(t.id); if (x.status === "complete") break; await new Promise((r) => setTimeout(r, 100)); } await new Promise((r) => setTimeout(r, 4500)); await chrome.tabs.group({ groupId: ${gid}, tabIds: [t.id] }); return t.id;`);
    await sleep(2000);
    let ltg = js((await tool("list_tabs", {})).text);
    ok((ltg?.tabs || []).some((x) => x.url?.endsWith("/hello")), "dragging a tab INTO the group shares it (Firefox reports the group change)", (ltg?.tabs || []).map((x) => x.url));
    await ext(`await chrome.tabs.ungroup([${tabIn}]); return 1;`);
    await sleep(3500);
    ltg = js((await tool("list_tabs", {})).text);
    r = await grp(tabIn);
    ok((ltg?.tabs || []).some((x) => x.url?.endsWith("/hello")) && r.groupId === -1, "taken OUT of the group the tab stays shared (the default) and is not herded back in", r);
    await unshare(tabIn);
    await ext(`await chrome.runtime.sendMessage({ cmd: "sharing.setTabGroup", on: false }); return 1;`);
    await sleep(2500);
    r = await grp(tab);
    ok(r.groupId === -1, "switching the group setting off takes the shared tabs out of the group", r);
    await ext(`await chrome.runtime.sendMessage({ cmd: "sharing.setTabGroup", on: true }); return 1;`);
    await sleep(2500);

    // ---- the mark on a shared tab, in Firefox's own tab strip
    console.log("— the mark on a shared tab: the icon where the page has one of its own, the title where it has none or a strict policy refuses the icon");
    const tabInfo = (id) => ext(`const t = await chrome.tabs.get(${id}); return { title: t.title, icon: (t.favIconUrl || "").slice(0, 22), full: t.favIconUrl || "" };`);
    // opens the page, remembers its own icon BEFORE it is shared (the mark goes on as soon as it is), then shares it
    const openShared = (path) => ext(`const t = await chrome.tabs.create({ url: ${JSON.stringify(URL_A + path)}, active: false }); for (let i = 0; i < 100; i++) { const x = await chrome.tabs.get(t.id); if (x.status === "complete") break; await new Promise((r) => setTimeout(r, 100)); } await new Promise((r) => setTimeout(r, 800)); const before = (await chrome.tabs.get(t.id)).favIconUrl || ""; await C.shareTab(t.id); return { id: t.id, before };`);
    const { id: tabIcon, before: iconBefore } = await openShared("/icon");
    const { id: tabCsp, before: cspBefore } = await openShared("/csp");
    await ext(`await chrome.runtime.sendMessage({ cmd: "sharing.setTabMark", mode: "icon" }); return 1;`);
    await sleep(7500); // the marks go on, the browser shows them, the ones it refused fall back to the title
    r = await tabInfo(tabIcon);
    ok(iconBefore.length > 0 && r.icon === "data:image/png;base64," && r.full !== iconBefore && r.full.length > iconBefore.length * 3 && r.title === "Icon page", "a page with an icon of its own shows the marked icon, and its title is untouched", { ...r, full: r.full.length, before: iconBefore.length });
    r = await tabInfo(tabCsp);
    ok(r.title === "⚡ Strict CSP page" && r.full === cspBefore, "a page whose security policy refuses the new icon keeps its icon and gets the title mark", r);
    r = await tabInfo(tab);
    ok(r.title === "⚡ Shop", "a page with no icon link of its own gets the title mark (an icon set there could never be taken off again)", r);
    const lt2 = js((await tool("list_tabs", {})).text);
    ok((lt2?.tabs || []).some((x) => x.url?.endsWith("/csp") && x.title === "Strict CSP page") && (lt2?.tabs || []).some((x) => x.url?.endsWith(`:${PA}/page`) && x.title === "Shop"), "the agent still sees clean titles", (lt2?.tabs || []).map((x) => x.title));
    await unshare(tabIcon); await unshare(tabCsp);
    await sleep(2500);
    r = await tabInfo(tabIcon);
    ok(r.full === iconBefore && r.title === "Icon page", "unshared: the page's own icon is back", { icon: r.icon, same: r.full === iconBefore });
    r = await tabInfo(tabCsp);
    ok(r.title === "Strict CSP page" && r.full === cspBefore, "...and the title mark is gone", r);
    await ext(`await chrome.runtime.sendMessage({ cmd: "sharing.setTabMark", mode: "off" }); return 1;`);
    await sleep(2500);
    r = await tabInfo(tab);
    ok(r.title === "Shop", "mark mode off: the title is back to the page's own", r);

    await ext(`await chrome.runtime.sendMessage({ cmd: "sharing.setSilent", on: true }); return 1;`);
    t = await tool("activate_tab", { tabId: mine.id });
    ok(t.isError && /WAKE_NOT_ALLOWED/.test(t.text || ""), "Silent mode (set in the popup's background): activate_tab is refused with WAKE_NOT_ALLOWED", t.text?.slice(0, 160));
    await ext(`await chrome.runtime.sendMessage({ cmd: "sharing.setSilent", on: false }); await chrome.runtime.sendMessage({ cmd: "disconnect" }); return 1;`);
  }
} catch (e) { console.error("  ERROR:", e.stack || e); fails++; }

// the hub this run started leaves by itself once its last browser is gone; if it has not by now, stop exactly that process
for (let i = 0; i < 30 && existsSync(join(hubDir, "hub.json")); i++) await sleep(500);
try { const hj = JSON.parse(readFileSync(join(hubDir, "hub.json"), "utf8")); if (hj.pid) process.kill(hj.pid); } catch {}

await finish(fails ? 1 : 0);
