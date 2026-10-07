#!/usr/bin/env node
// OPT-IN end-to-end test of "Wake the browser" in a REAL, HEADED Chrome (throwaway profile):
//   node scripts/e2e-wake.mjs        (npm run test:e2e-wake)
// A hidden window cannot be simulated headless, so this one opens a real browser window for a few
// seconds (it may flash on screen and take the focus once). It loads extension/wake.js into the
// extension's own page and checks what the mock tests cannot: a MINIMIZED window really stops
// drawing and reports no focus, wake() brings it back to a rendered, focused state in well under a
// second (screenshots work), and release() minimizes it again. Like e2e-chrome.mjs it never touches
// your real profile, ~/.tabduct or the live hub (the extension copy has no `key`).
// Set CHROME_PATH to use a different binary; the test skips if none is found.

import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, cpSync } from "node:fs";
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

const srv = http.createServer((q, r) => {
  r.writeHead(200, { "content-type": "text/html" });
  r.end(`<!doctype html><title>Wake</title><script>window.raf=0;(function f(){window.raf++;requestAnimationFrame(f)})();</script><body>page</body>`);
});
await new Promise((r) => srv.listen(0, r));
const PORT = srv.address().port;

const profile = mkdtempSync(join(tmpdir(), "tabduct-wake-"));
const args = ["--remote-debugging-port=0", "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "--window-size=700,500", `--user-data-dir=${profile}`, "about:blank"];
// Windows: the launcher exits at once and the real browser lives on, started minimized so it does not take the focus.
if (process.platform === "win32") spawnSync("powershell", ["-NoProfile", "-Command", `Start-Process -FilePath '${CHROME}' -ArgumentList '${args.join(" ")}' -WindowStyle Minimized`], { windowsHide: true });
else spawn(CHROME, args, { stdio: "ignore", detached: true }).unref();
const portFile = join(profile, "DevToolsActivePort");
for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(200);
if (!existsSync(portFile)) { console.error("Chrome did not start (no DevToolsActivePort)"); process.exit(1); }
const [cdpPort, cdpPath] = readFileSync(portFile, "utf8").trim().split("\n");
const ws = new WebSocket(`ws://127.0.0.1:${cdpPort}${cdpPath}`);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("CDP websocket failed"))); });
let nextId = 1; const waiting = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { const { res, rej } = waiting.get(m.id); waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
const cdp = (method, params = {}, sessionId, tmo = 30000) => new Promise((res, rej) => { const id = nextId++; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); rej(new Error(`CDP timeout: ${method}`)); } }, tmo); });
async function finish(code) {
  try { await cdp("Browser.close", {}, undefined, 5000); } catch {}
  await sleep(500);
  srv.close();
  console.log(code ? `\nE2E WAKE FAILED (${fails})` : "\nE2E WAKE PASSED");
  process.exit(code);
}
process.on("unhandledRejection", (e) => { console.error("  ERROR:", e); fails++; finish(1); });
setTimeout(() => { console.error("E2E WAKE TIMEOUT (120s)"); fails++; finish(1); }, 120000).unref();

const extCopy = mkdtempSync(join(tmpdir(), "tabduct-ext-"));
cpSync(join(REPO, "extension"), extCopy, { recursive: true });
{ const mf = JSON.parse(readFileSync(join(extCopy, "manifest.json"), "utf8")); delete mf.key; writeFileSync(join(extCopy, "manifest.json"), JSON.stringify(mf, null, 2)); }
const { id: EXT } = await cdp("Extensions.loadUnpacked", { path: extCopy });
ok(!!EXT, `extension loaded unpacked (id ${EXT})`);
const { targetId: extT } = await cdp("Target.createTarget", { url: `chrome-extension://${EXT}/viewer.html?k=wake` });
const { sessionId: extS } = await cdp("Target.attachToTarget", { targetId: extT, flatten: true });
await cdp("Runtime.enable", {}, extS); await sleep(500);
const ext = async (code, tmo = 15000) => {
  const r = await cdp("Runtime.evaluate", { expression: `(async()=>{try{return JSON.stringify(await (async()=>{${code}})())}catch(e){return JSON.stringify({ERR:String(e&&e.message||e)})}})()`, awaitPromise: true, returnByValue: true }, extS, tmo);
  return r.result?.value ? JSON.parse(r.result.value) : r;
};

const { tabId, windowId } = await ext(`const t=await chrome.tabs.create({url:'http://127.0.0.1:${PORT}/',active:true}); return {tabId:t.id, windowId:t.windowId};`);
await sleep(1500);
const tg = (await cdp("Target.getTargets")).targetInfos.find((t) => t.url.includes(`:${PORT}/`));
const { sessionId: pS } = await cdp("Target.attachToTarget", { targetId: tg.targetId, flatten: true });
await cdp("Runtime.enable", {}, pS);
const page = async (expr) => (await cdp("Runtime.evaluate", { expression: expr, returnByValue: true }, pS, 8000)).result?.value;
const winState = async () => (await ext(`return (await chrome.windows.get(${windowId})).state`));
const frames = async () => { const a = await page("window.raf"); await sleep(600); return (await page("window.raf")) - a; };
const shot = async () => { try { return (await cdp("Page.captureScreenshot", { format: "jpeg", quality: 30 }, pS, 4000)).data.length > 100; } catch { return false; } };

await ext(`window.W = await import(chrome.runtime.getURL('wake.js')); W.timing.idleMs = 800; return 1;`);

for (const [label, before] of [["a normal window, minimized", "normal"], ["a maximized window, minimized", "maximized"]]) {
  console.log(`\n${label}`);
  if (before === "maximized") { await ext(`await chrome.windows.update(${windowId},{state:'maximized'}); return 1;`); await sleep(800); }
  await ext(`await chrome.windows.update(${windowId},{state:'minimized'}); return 1;`);
  await sleep(2000);
  ok(await winState() === "minimized", "window is minimized");
  ok(await page("document.visibilityState") === "hidden", "the page is hidden");
  ok(await page("document.hasFocus()") === false, "the page reports no focus");
  ok(await frames() === 0, "the page draws nothing while hidden");
  ok(await shot() === false, "a screenshot of the hidden page does not work");

  const t0 = Date.now();
  await ext(`window.rec = await W.wake(${tabId}); return !!window.rec;`);
  const took = Date.now() - t0;
  // (this harness runs wake() inside an extension tab that is itself hidden, so its timers are throttled
  // to ~1 s; in the service worker nothing is throttled)
  ok(took < 2500, `wake() returned in ${took} ms`, took);
  ok(await winState() === before, `the window is back to its earlier state (${before})`, await winState());
  ok(await page("document.visibilityState") === "visible", "the page is visible");
  ok(await page("document.hasFocus()") === true, "the page reports focus");
  ok(await frames() > 10, "the page draws again");
  ok(await shot() === true, "a screenshot works");

  await ext(`W.release(window.rec); return 1;`);
  await sleep(2500);
  ok(await winState() === "minimized", "after the idle period the window is minimized again");
  ok(await page("document.visibilityState") === "hidden", "...and the page sleeps again");
  await ext(`await chrome.windows.update(${windowId},{state:'normal'}); return 1;`); await sleep(500);
}

await finish(fails ? 1 : 0);
