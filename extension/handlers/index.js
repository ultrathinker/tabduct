// Tabduct extension — tool handlers.
//
// Each handler implements one tool from ../../protocol/tools.schema.json using
// chrome.tabs / chrome.scripting. Handlers are async and return a
// JSON-serializable result, or throw. To signal a specific wire error code,
// throw via err(CODE, message).

import { getState as getConsentState, originBlocked, hostOf } from "./consent.js";

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function resolveTabId(args) {
  if (typeof args?.tabId === "number") return args.tabId;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw err("TAB_NOT_FOUND", "No active tab");
  return tab.id;
}

function tabInfo(t) {
  return { id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId, status: t.status };
}

// NOTE: list_tabs / get_active_tab are handled entirely in background.js
// handleInvoke (enumerate path) with consent FILTERING — they are intentionally
// NOT in HANDLERS so there is exactly one (filtered) implementation and no
// unfiltered leak path if dispatch is refactored.
export const HANDLERS = {
  async open_tab(args) {
    const tab = await chrome.tabs.create({ url: args?.url, active: args?.active !== false });
    // tab.url is usually "" until the navigation commits (dest lives in pendingUrl);
    // report the intended origin so auto-share grants the right host instead of a
    // null host that self-revokes on ORIGIN_DRIFT the moment the page loads.
    return tabInfo({ ...tab, url: tab.url || tab.pendingUrl || args?.url || "" });
  },

  async activate_tab(args) {
    const tab = await chrome.tabs.update(args.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tabInfo(tab);
  },

  async close_tab(args) {
    await chrome.tabs.remove(args.tabId);
    return { closed: args.tabId };
  },

  async navigate(args) {
    const tabId = await resolveTabId(args);
    if (args.waitUntilComplete === false) {
      await chrome.tabs.update(tabId, { url: args.url });
      return tabInfo(await chrome.tabs.get(tabId));
    }
    // Attach listeners BEFORE update() to avoid a lost-wakeup race; guard tab
    // close; bound with an internal deadline < the host's invoke timeout.
    const done = new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        chrome.tabs.onUpdated.removeListener(onUpd);
        chrome.tabs.onRemoved.removeListener(onRem);
        clearTimeout(timer);
      };
      const finish = (fn, v) => { if (settled) return; settled = true; cleanup(); fn(v); };
      const onUpd = (id, info) => { if (id === tabId && info.status === "complete") finish(resolve); };
      const onRem = (id) => { if (id === tabId) finish(reject, err("TAB_NOT_FOUND", "tab closed during navigation")); };
      const timer = setTimeout(() => finish(resolve, "deadline"), 15000);
      chrome.tabs.onUpdated.addListener(onUpd);
      chrome.tabs.onRemoved.addListener(onRem);
    });
    await chrome.tabs.update(tabId, { url: args.url });
    await done;
    return tabInfo(await chrome.tabs.get(tabId));
  },

  async get_page_content(args) {
    const tabId = await resolveTabId(args);
    const format = args?.format ?? "text";
    const maxChars = args?.maxChars ?? 200000;
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [format, args._authHost ?? null],
      func: (fmt, authHost) => {
        // TOCTOU re-check IN-PAGE: a shared tab can self-navigate between gate time
        // and now; refuse to read the wrong origin. (MAIN world, kept inline.)
        if (authHost) { const h = (location.hostname || "").toLowerCase().replace(/\.$/, ""); if (h !== authHost) return { __originMismatch: true }; }
        if (fmt === "html") return document.documentElement.innerHTML;
        if (fmt === "outerHTML") return document.documentElement.outerHTML;
        if (fmt === "textContent") return document.body ? document.body.textContent : "";
        return document.body ? document.body.innerText : "";
      },
    });
    const raw = results?.[0]?.result;
    if (raw && typeof raw === "object" && raw.__originMismatch) throw err("ORIGIN_DRIFT", "tab navigated away from the authorized origin");
    const text = typeof raw === "string" ? raw : "";
    return {
      format,
      truncated: maxChars > 0 && text.length > maxChars,
      content: maxChars > 0 ? text.slice(0, maxChars) : text,
    };
  },

  async execute_script(args) {
    const tabId = await resolveTabId(args);
    // Engine selection (PART 4). _engine/_allowCdp are injected by background's
    // gate from the user's CDP settings; default "auto" = chrome.scripting with a
    // CDP fallback only when CSP blocks AND the user opted in.
    const engine = args._engine === "cdp" || args._engine === "scripting" ? args._engine : "auto";
    const allowCdp = !!args._allowCdp;
    const authHost = args._authHost ?? null;
    const callArgs = args.args ?? [];

    if (engine === "cdp") return cdpEval(tabId, args.code, callArgs, authHost, { hold: !!args._cdpAlways });

    const runScripting = async () => {
      // Runs in the page's MAIN world. Arbitrary-string eval is subject to the
      // PAGE's CSP; on strict-CSP sites it surfaces cleanly as CSP_BLOCKED. The
      // CSP-proof fallback is CDP (cdpEval) when the user opts in; the real
      // roadmap fix is chrome.userScripts. (ISOLATED world was removed: extension
      // MV3 CSP forbids eval there, so it could never succeed.)
      let results;
      try {
        results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          args: [args.code, callArgs, authHost],
          func: (code, callArgs, authHost) => {
            try {
              // TOCTOU re-check IN-PAGE: a shared tab can self-navigate between gate
              // time and now; refuse to execute in the wrong origin. (MAIN world, inline.)
              if (authHost) { const h = (location.hostname || "").toLowerCase().replace(/\.$/, ""); if (h !== authHost) return { __originMismatch: true }; }
              const fn = new Function("args", `return (async () => { ${code} })(args)`);
              return Promise.resolve(fn(callArgs)).then(
                (value) => ({ ok: true, value }),
                (e) => ({ ok: false, error: String((e && e.stack) || e) })
              );
            } catch (e) {
              return { ok: false, error: String((e && e.stack) || e) };
            }
          },
        });
      } catch (e) {
        throw err("SCRIPT_ERROR", `executeScript failed: ${e?.message ?? e}`);
      }
      const wrapped = results?.[0]?.result;
      if (!wrapped) throw err("SCRIPT_ERROR", "no result frame (target unavailable?)");
      if (wrapped.__originMismatch) throw err("ORIGIN_DRIFT", "tab navigated away from the authorized origin");
      if (!wrapped.ok) {
        const code = /content security policy|unsafe-eval|EvalError/i.test(wrapped.error) ? "CSP_BLOCKED" : "SCRIPT_ERROR";
        throw err(code, wrapped.error);
      }
      // Cap well under the host's 32 MiB inbound frame cap (MAX_FRAME_BYTES) so a huge
      // return can't get the reply dropped (→ misleading TIMEOUT), but generous enough
      // for real DOM/table scrapes.
      const CAP = 8_000_000;
      let s; try { s = JSON.stringify(wrapped.value); } catch { s = undefined; }
      if (s !== undefined && s.length > CAP) return { result: s.slice(0, CAP), truncated: true, note: "result truncated to 8MB", via: "scripting" };
      return { result: wrapped.value, via: "scripting" };
    };

    try {
      return await runScripting();
    } catch (e) {
      // "auto": on a CSP block, fall back to CDP if the user opted in; otherwise
      // surface CSP_BLOCKED with a hint pointing at the opt-in.
      if (engine === "auto" && e?.code === "CSP_BLOCKED") {
        if (allowCdp) return cdpEval(tabId, args.code, callArgs, authHost, { hold: false });
        throw err("CSP_BLOCKED", `${e.message} — enable 'Allow CDP eval' in the Tabduct popup and retry`);
      }
      throw e;
    }
  },

  async screenshot(args) {
    const tabId = await resolveTabId(args);
    let tab = await chrome.tabs.get(tabId);
    const authHost = args._authHost ?? null;
    const format = args?.format === "jpeg" ? "jpeg" : "png";
    const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
    // CDP full-page (Page.captureScreenshot) works on the attached target regardless
    // of which tab is active; every other path uses captureVisibleTab and so needs
    // the target to be the window's ACTIVE tab.
    const usesVisible = !(args.fullPage && args._allowCdp);
    if (usesVisible && !tab.active) {
      if (!args?.activate) throw err("INVALID_ARGS", `tab ${tabId} is not active; captureVisibleTab only sees the active tab — pass activate:true or activate_tab first`);
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      tab = await chrome.tabs.get(tabId);
    }

    if (args.fullPage) {
      const maxHeightPx = clampMaxHeight(args.maxHeightPx);
      // CDP when the user enabled it (clean single-shot); else scroll-and-stitch.
      if (args._allowCdp) return await cdpFullPageScreenshot(tabId, authHost, format, args.quality, maxHeightPx);
      return await stitchFullPage(tab, authHost, format, args.quality, maxHeightPx);
    }

    // Viewport capture, optionally scrolled to a target/offset first.
    if (args.selector || typeof args.scrollTo === "number") {
      await scrollTab(tabId, authHost, args.selector || null, typeof args.scrollTo === "number" ? args.scrollTo : null);
    }
    const opts = { format };
    if (format === "jpeg" && typeof args?.quality === "number") opts.quality = args.quality;
    // captureVisibleTab is WINDOW-scoped — it grabs whatever tab is active in the
    // window at capture time, not `tabId`. A focus change (concurrent invoke or the
    // user switching tabs) could otherwise leak an UNshared tab's pixels. Assert the
    // authorized tab is the active one immediately before AND after the capture.
    const activeIs = async () => (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0]?.id;
    if (await activeIs() !== tabId) throw err("INTERNAL", "target tab is not the active tab; retry");
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, opts);
    if (await activeIs() !== tabId) throw err("INTERNAL", "active tab changed during capture; retry");
    return { mimeType, dataUrl };
  },

  // CSP-safe interaction/wait tools (PART 1) + console capture (PART 2).
  // All run via chrome.scripting.executeScript({target, func, args}) — i.e.
  // INJECTED FUNCTIONS, never string eval — so page CSP (which blocks string
  // eval) does not stop them. get_page_content already proves this pattern.
  // Each injected func re-checks the authorized origin (_authHost) in-page to
  // close the gate→inject TOCTOU window; a mismatch becomes ORIGIN_DRIFT.

  async wait_for(args) {
    const tabId = await resolveTabId(args);
    // At least one condition is required (no field is individually required in
    // the schema, so enforce the "at least one" rule here).
    if (!args.selector && !args.urlContains && !args.loadState) throw err("INVALID_ARGS", "wait_for needs at least one of selector, urlContains, loadState");
    if (args.loadState && args.loadState !== "complete") throw err("INVALID_ARGS", "loadState must be 'complete'");
    const _t = Number(args.timeoutMs); const timeoutMs = Math.min(_t > 0 ? _t : 10000, 25000); // default 10s, cap 25s
    const selector = args.selector || null, urlContains = args.urlContains || null, loadState = args.loadState || null, authHost = args._authHost ?? null;
    const start = Date.now();
    // Poll ~every 250ms (bounded by timeoutMs). Each poll is one executeScript.
    const check = async () => {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        args: [selector, urlContains, loadState, authHost],
        func: (sel, urlContains, loadState, authHost) => {
          if (authHost) { const h = (location.hostname || "").toLowerCase().replace(/\.$/, ""); if (h !== authHost) return { __originMismatch: true }; }
          if (sel && document.querySelector(sel)) return { matched: true };
          if (urlContains && location.href.includes(urlContains)) return { matched: true };
          if (loadState && document.readyState === loadState) return { matched: true };
          return { matched: false };
        },
      });
      return results?.[0]?.result;
    };
    while (Date.now() - start < timeoutMs) {
      const r = await check();
      if (r && typeof r === "object" && r.__originMismatch) throw err("ORIGIN_DRIFT", "tab navigated away from the authorized origin");
      if (r && r.matched) return { matched: true, waitedMs: Date.now() - start };
      await new Promise((res) => setTimeout(res, 250));
    }
    throw err("TIMEOUT", `wait_for timed out after ${timeoutMs}ms`);
  },

  async click(args) {
    const tabId = await resolveTabId(args);
    if (!args.selector) throw err("INVALID_ARGS", "click requires a selector");
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [args.selector, args._authHost ?? null],
      func: (sel, authHost) => {
        if (authHost) { const h = (location.hostname || "").toLowerCase().replace(/\.$/, ""); if (h !== authHost) return { __originMismatch: true }; }
        const el = document.querySelector(sel);
        if (!el) return { __notfound: true };
        if (typeof el.click !== "function") return { __notclickable: true };
        el.scrollIntoView({ block: "center" });
        el.click();
        return { ok: true };
      },
    });
    const r = results?.[0]?.result;
    if (!r) throw err("SCRIPT_ERROR", "no result frame (target unavailable?)");
    if (r.__originMismatch) throw err("ORIGIN_DRIFT", "tab navigated away from the authorized origin");
    if (r.__notfound) throw err("SCRIPT_ERROR", `no element matches ${args.selector}`);
    if (r.__notclickable) throw err("SCRIPT_ERROR", `element ${args.selector} is not clickable`);
    return { clicked: true, selector: args.selector };
  },

  async type(args) {
    const tabId = await resolveTabId(args);
    if (!args.selector) throw err("INVALID_ARGS", "type requires a selector");
    if (typeof args.text !== "string") throw err("INVALID_ARGS", "type requires text");
    const clear = !!args.clear;
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [args.selector, args.text, clear, args._authHost ?? null],
      func: (sel, text, clear, authHost) => {
        if (authHost) { const h = (location.hostname || "").toLowerCase().replace(/\.$/, ""); if (h !== authHost) return { __originMismatch: true }; }
        const el = document.querySelector(sel);
        if (!el) return { __notfound: true };
        try { el.focus?.(); } catch {}
        try { el.scrollIntoView?.({ block: "center" }); } catch {}
        const tag = (el.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea") {
          // Use the native value setter so React/Vue controlled inputs pick up the
          // change (assigning .value directly is ignored by some frameworks).
          const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          const next = clear ? text : (el.value || "") + text;
          if (setter) setter.call(el, next); else el.value = next;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          // contenteditable / generic element: set textContent + fire input.
          el.textContent = clear ? text : (el.textContent || "") + text;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
        }
        return { ok: true };
      },
    });
    const r = results?.[0]?.result;
    if (!r) throw err("SCRIPT_ERROR", "no result frame (target unavailable?)");
    if (r.__originMismatch) throw err("ORIGIN_DRIFT", "tab navigated away from the authorized origin");
    if (r.__notfound) throw err("SCRIPT_ERROR", `no element matches ${args.selector}`);
    return { typed: true, selector: args.selector };
  },

  async get_dom_snapshot(args) {
    const tabId = await resolveTabId(args);
    const _m = Number(args.maxChars); const maxChars = Math.min(_m > 0 ? _m : 40000, 200000); // default 40000, hard cap 200000
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [maxChars, args._authHost ?? null],
      func: (maxChars, authHost) => {
        if (authHost) { const h = (location.hostname || "").toLowerCase().replace(/\.$/, ""); if (h !== authHost) return { __originMismatch: true }; }
        // Self-contained: no external helpers. Walks the visible DOM and emits a
        // compact outline of interactive/structural elements — enough to pick
        // click/type selectors on CSP sites without arbitrary JS.
        const SEL = "a,button,input,textarea,select,summary,[role],label,h1,h2,h3,h4,h5,h6,nav,form,fieldset,legend,optgroup,option,video,audio,canvas,table,thead,tbody,th,td,li,datalist,output";
        // Reasonably stable CSS selector: #id when unique, else a short nth-of-type path.
        const selFor = (el) => {
          if (el.id) { try { if (document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`; } catch {} }
          const parts = [];
          let cur = el, depth = 0;
          while (cur && cur.nodeType === 1 && cur !== document.documentElement && depth < 12) {
            const name = cur.nodeName.toLowerCase();
            const parent = cur.parentElement;
            if (parent) {
              const same = [...parent.children].filter((s) => s.nodeName.toLowerCase() === name);
              parts.unshift(same.length > 1 ? `${name}:nth-of-type(${same.indexOf(cur) + 1})` : name);
            } else parts.unshift(name);
            cur = parent; depth++;
          }
          return parts.join(">");
        };
        const labelOf = (el) => (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name"))) || (el.textContent || "").trim();
        const lines = [];
        let len = 0, truncated = false;
        for (const el of document.querySelectorAll(SEL)) {
          // Skip hidden: display:none, visibility:hidden, the `hidden` attr, or a
          // null offsetParent that isn't a position:fixed element.
          const cs = getComputedStyle(el);
          if (el.hidden || cs.display === "none" || cs.visibility === "hidden" || (el.offsetParent === null && cs.position !== "fixed")) continue;
          const tag = el.nodeName.toLowerCase();
          const role = el.getAttribute("role");
          const lab = (labelOf(el) || "").replace(/\s+/g, " ").slice(0, 80);
          const line = `<${tag}${role ? ` role="${role}"` : ""}${lab ? ` ${lab}` : ""} [${selFor(el)}]>`;
          lines.push(line); len += line.length + 1;
          if (maxChars > 0 && len > maxChars) { truncated = true; break; } // stop walking a huge DOM once the budget is full
        }
        let out = lines.join("\n");
        if (maxChars > 0 && out.length > maxChars) { out = out.slice(0, maxChars); truncated = true; }
        return { snapshot: out, truncated };
      },
    });
    const r = results?.[0]?.result;
    if (r && r.__originMismatch) throw err("ORIGIN_DRIFT", "tab navigated away from the authorized origin");
    return r || { snapshot: "", truncated: false };
  },

  async get_console_logs(args) {
    const tabId = await resolveTabId(args);
    const clear = !!args.clear;
    // CDP capture path: when console capture is attached to this tab we return the
    // FULL buffer (console.* + uncaught exceptions + browser Log entries), recorded
    // continuously since attach — not just since this call. Falls back to the
    // injected monkeypatch below when CDP capture is off.
    if (cdpConsoleTabs.has(tabId)) {
      // Origin re-check (the CDP buffer keeps filling across a navigation, so a
      // drifted lock-to-domain tab could otherwise leak new-origin lines).
      const authHost = args._authHost ?? null;
      if (authHost) {
        let h = null; try { h = (new URL((await chrome.tabs.get(tabId)).url).hostname || "").toLowerCase().replace(/\.$/, ""); } catch {}
        if (h !== authHost) throw err("ORIGIN_DRIFT", "tab navigated away from the authorized origin");
      }
      const buf = cdpLogs.get(tabId);
      const logs = buf ? buf.slice() : [];
      if (clear) cdpLogs.delete(tabId);
      return { logs, source: "cdp", note: "captured via CDP (console + exceptions + browser log entries)" };
    }
    // MAIN world: we must patch the PAGE's console object (ISOLATED world has its
    // own console and would capture nothing). Re-installs on each call, so a
    // page navigation (which wipes the hook) is recovered automatically.
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [clear, args._authHost ?? null],
      func: (clear, authHost) => {
        if (authHost) { const h = (location.hostname || "").toLowerCase().replace(/\.$/, ""); if (h !== authHost) return { __originMismatch: true }; }
        const MAX = 500;
        const installHook = () => {
          if (window.__tabductLogsInstalled) return;
          window.__tabductLogsInstalled = true;
          window.__tabductLogs = [];
          const safe = (a) => { try { if (a instanceof Error) return a.stack || String(a); if (typeof a === "object" && a !== null) return JSON.stringify(a); return String(a); } catch { try { return String(a); } catch { return "[unserializable]"; } } };
          const push = (level, a) => { const text = ((Array.isArray(a) ? a : [a]).map(safe).join(" ")).slice(0, 500); window.__tabductLogs.push({ level, ts: Date.now(), text }); if (window.__tabductLogs.length > MAX) window.__tabductLogs.splice(0, window.__tabductLogs.length - MAX); };
          for (const lvl of ["log", "info", "warn", "error", "debug"]) {
            const orig = console[lvl] && console[lvl].bind ? console[lvl].bind(console) : console[lvl];
            console[lvl] = (...a) => { try { push(lvl, a); } catch {} return orig.apply(console, a); };
          }
        };
        installHook();
        const copy = (window.__tabductLogs || []).slice();
        if (clear) window.__tabductLogs = [];
        return { logs: copy };
      },
    });
    const r = results?.[0]?.result;
    if (r && r.__originMismatch) throw err("ORIGIN_DRIFT", "tab navigated away from the authorized origin");
    return { logs: r?.logs || [], source: "inject", note: "capture starts when first requested; earlier logs may be missing" };
  },

  // Network inspection (PART 7) — read the CDP-captured request log for a shared
  // tab. Bundled under the SAME opt-in as console capture (cdpConsole): when that
  // is on, background's reconcile enables the Network domain on each shared tab and
  // buffers requests into cdpNet (see ensureCdpListeners + startCdpConsole). No
  // separate consent gate: capture only runs while the tab is attached, and these
  // tools are "read" (allowed in read-only). Origin re-checked like get_console_logs.
  async list_network_requests(args) {
    const tabId = await resolveTabId(args);
    if (!cdpConsoleTabs.has(tabId)) return { requests: [], source: "off", note: "network capture is off — enable 'Capture console, errors & network via CDP' in the Tabduct popup (Advanced)" };
    await assertNetOrigin(tabId, args._authHost ?? null);
    const m = cdpNet.get(tabId);
    let list = m ? [...m.values()] : [];
    const { urlContains, method, resourceType, statusMin } = args;
    if (urlContains) list = list.filter((r) => (r.url || "").includes(urlContains));
    if (method) { const mm = String(method).toUpperCase(); list = list.filter((r) => (r.method || "").toUpperCase() === mm); }
    if (resourceType) { const rt = String(resourceType).toLowerCase(); list = list.filter((r) => (r.resourceType || "").toLowerCase() === rt); }
    if (typeof statusMin === "number") list = list.filter((r) => typeof r.status === "number" && r.status >= statusMin);
    // Denylist over HISTORICAL buffered data (M1): the CDP buffer keeps filling across
    // navigations, so with lockToDomain off a shared tab may have visited a denied
    // origin — never hand that origin's traffic to the agent, even after it navigated
    // back to an allowed one. (assertNetOrigin only guards the CURRENT url.)
    const cstate = await getConsentState();
    list = list.filter((r) => !originBlocked(cstate, hostOf(r.url)));
    const total = list.length;
    const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500);
    const requests = list.slice(-limit).map(netSummary); // newest-last; take the newest `limit`
    if (args.clear && m) m.clear();
    return { requests, total, returned: requests.length, source: "cdp" };
  },

  async get_network_request(args) {
    const tabId = await resolveTabId(args);
    if (!args.requestId || typeof args.requestId !== "string") throw err("INVALID_ARGS", "get_network_request requires a string requestId");
    if (!cdpConsoleTabs.has(tabId)) throw err("CDP_NOT_PERMITTED", "network capture is off — enable 'Capture console, errors & network via CDP' in the Tabduct popup (Advanced)");
    await assertNetOrigin(tabId, args._authHost ?? null);
    const rec = cdpNet.get(tabId)?.get(args.requestId);
    if (!rec) throw err("SCRIPT_ERROR", `no captured request with id ${args.requestId} (it may have been evicted from the buffer)`);
    // Denylist over historical buffered data (M1) — same reasoning as list_network_requests.
    const cstate = await getConsentState();
    if (originBlocked(cstate, hostOf(rec.url))) throw err("ORIGIN_DENIED", "destination not allowed by consent policy");
    let body = null, bodyBase64 = false, bodyTruncated = false, bodyError = null;
    if (args.includeBody !== false) {
      try {
        const r = await chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId: args.requestId });
        body = r?.body ?? null; bodyBase64 = !!r?.base64Encoded;
        const HARD = 2_000_000; // hard cap regardless of maxBodyBytes (protects the wire frame)
        const cap = args.maxBodyBytes === 0 ? HARD : Math.min(Number(args.maxBodyBytes) || 512_000, HARD);
        if (typeof body === "string" && body.length > cap) { body = body.slice(0, cap); bodyTruncated = true; }
      } catch (e) { bodyError = String(e?.message ?? e); } // body no longer buffered / not applicable (e.g. redirects)
    }
    return { request: rec, body, bodyBase64, bodyTruncated, bodyError };
  },
};

// Origin re-check for the network tools: the CDP buffer keeps filling across a
// navigation, so a drifted lock-to-domain tab could otherwise leak another
// origin's traffic. Mirrors the get_console_logs CDP-path check.
async function assertNetOrigin(tabId, authHost) {
  if (!authHost) return;
  let h = null;
  try { h = (new URL((await chrome.tabs.get(tabId)).url).hostname || "").toLowerCase().replace(/\.$/, ""); } catch {}
  if (h !== authHost) throw err("ORIGIN_DRIFT", "tab navigated away from the authorized origin");
}

// Compact per-request summary for list_network_requests (drops headers; those live
// in get_network_request).
function netSummary(r) {
  return {
    requestId: r.requestId, method: r.method, url: r.url, resourceType: r.resourceType,
    status: r.status ?? null, statusText: r.statusText ?? null, mimeType: r.mimeType ?? null,
    fromCache: !!r.fromCache, sizeBytes: r.encodedDataLength ?? null,
    durationMs: r.startedMs != null && r.endedMs != null ? r.endedMs - r.startedMs : null,
    failed: !!r.failed, errorText: r.errorText ?? null, pending: !r.finished,
    redirects: r.redirects?.length || 0,
  };
}

// ---------------------------------------------------------------------------
// Screenshot helpers (PART 8) — full-page (CDP + scroll-stitch fallback) and
// scroll-to-target. Full-page height is HARD-capped (clampMaxHeight) so an
// infinite-scroll page can never drive a runaway capture; the stitch loop also
// stops on no-scroll-progress, a segment cap, and a wall-clock deadline.

const SHOT_HARD_MAX_PX = 16384; // Chromium's practical bitmap/skia dimension limit

function clampMaxHeight(v) {
  const n = Number(v);
  const d = Number.isFinite(n) && n > 0 ? n : 15000;
  return Math.max(256, Math.min(d, SHOT_HARD_MAX_PX));
}

// Base64 data URL from a Blob WITHOUT FileReader (unavailable in service workers).
async function blobToDataUrl(blob, mimeType) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CH = 0x8000; // chunk to avoid String.fromCharCode arg-count limits
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return `data:${mimeType};base64,${btoa(bin)}`;
}

// Measure the page (self-navigation re-checked in-page like every injected tool).
async function measurePage(tabId, authHost) {
  const r = (await chrome.scripting.executeScript({
    target: { tabId }, args: [authHost],
    func: (authHost) => {
      if (authHost) { const h = (location.hostname || "").toLowerCase().replace(/\.$/, ""); if (h !== authHost) return { __originMismatch: true }; }
      const de = document.documentElement, b = document.body;
      const scrollHeight = Math.max(de.scrollHeight, b ? b.scrollHeight : 0, de.clientHeight || 0);
      return { scrollHeight, clientHeight: window.innerHeight || de.clientHeight || 0, dpr: window.devicePixelRatio || 1, originalScrollY: window.scrollY };
    },
  }))?.[0]?.result;
  if (r?.__originMismatch) throw err("ORIGIN_DRIFT", "tab navigated away from the authorized origin");
  if (!r) throw err("SCRIPT_ERROR", "could not measure page");
  return r;
}

async function scrollToY(tabId, authHost, y) {
  const r = (await chrome.scripting.executeScript({
    target: { tabId }, args: [y, authHost],
    func: (y, authHost) => {
      if (authHost) { const h = (location.hostname || "").toLowerCase().replace(/\.$/, ""); if (h !== authHost) return { __originMismatch: true }; }
      window.scrollTo(0, y);
      return { scrollY: window.scrollY };
    },
  }))?.[0]?.result;
  if (r?.__originMismatch) throw err("ORIGIN_DRIFT", "tab navigated away from the authorized origin");
  return r?.scrollY ?? 0;
}

// Scroll a selector/offset into view before a viewport capture.
async function scrollTab(tabId, authHost, selector, y) {
  const r = (await chrome.scripting.executeScript({
    target: { tabId }, args: [selector, y, authHost],
    func: (sel, y, authHost) => {
      if (authHost) { const h = (location.hostname || "").toLowerCase().replace(/\.$/, ""); if (h !== authHost) return { __originMismatch: true }; }
      if (sel) { const el = document.querySelector(sel); if (!el) return { __notfound: true }; el.scrollIntoView({ block: "center", inline: "center" }); }
      else if (y != null) window.scrollTo(0, y);
      return { ok: true };
    },
  }))?.[0]?.result;
  if (r?.__originMismatch) throw err("ORIGIN_DRIFT", "tab navigated away from the authorized origin");
  if (r?.__notfound) throw err("SCRIPT_ERROR", `no element matches ${selector}`);
  await new Promise((res) => setTimeout(res, 150)); // let it paint/settle
}

// CDP single-shot full-page capture. Attaches the debugger (idempotent, tolerant
// of an already-held console/eval session) and reuses cdpInFlight/cdpHeld so it
// never detaches a session another CDP user still needs.
async function cdpFullPageScreenshot(tabId, authHost, format, quality, maxHeightPx) {
  if (!chrome.debugger) throw err("CDP_NOT_PERMITTED", "debugger API unavailable");
  if (!(await chrome.permissions.contains({ permissions: ["debugger"] }))) throw err("CDP_NOT_PERMITTED", "debugger permission not granted");
  await assertNetOrigin(tabId, authHost); // reuse the tab-URL origin check
  // Increment BEFORE attach (L2): between attach and the increment cdpHeld() is
  // false, so a concurrent stopCdpConsole/detach could otherwise pull the session.
  cdpInFlight.set(tabId, (cdpInFlight.get(tabId) || 0) + 1);
  try {
    try { await chrome.debugger.attach({ tabId }, "1.3"); }
    catch (e) { if (!/already|another debugger/i.test(e?.message || "")) throw err("SCRIPT_ERROR", `debugger attach failed: ${e?.message ?? e}`); }
    try { await chrome.debugger.sendCommand({ tabId }, "Page.enable"); } catch {}
    const metrics = await chrome.debugger.sendCommand({ tabId }, "Page.getLayoutMetrics");
    const size = metrics?.cssContentSize; // CSS px (matches clip scale:1); Chrome >=116 always provides it (L3/L4)
    if (!size) throw err("INTERNAL", "Page.getLayoutMetrics returned no cssContentSize");
    const width = Math.max(1, Math.ceil(size.width || 0));
    const fullHeight = Math.max(1, Math.ceil(size.height || 0));
    const capped = Math.min(fullHeight, maxHeightPx);
    const fmt = format === "jpeg" ? "jpeg" : "png";
    const params = { format: fmt, captureBeyondViewport: true, fromSurface: true, clip: { x: 0, y: 0, width, height: capped, scale: 1 } };
    if (fmt === "jpeg" && typeof quality === "number") params.quality = quality;
    const shot = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", params);
    if (!shot?.data) throw err("INTERNAL", "CDP captureScreenshot returned no data");
    const mimeType = fmt === "jpeg" ? "image/jpeg" : "image/png";
    return { mimeType, dataUrl: `data:${mimeType};base64,${shot.data}`, fullPage: true, via: "cdp", capturedHeightPx: capped, fullHeightPx: fullHeight, truncated: fullHeight > capped };
  } finally {
    const n = (cdpInFlight.get(tabId) || 1) - 1;
    if (n <= 0) cdpInFlight.delete(tabId); else cdpInFlight.set(tabId, n);
    if (!cdpHeld(tabId)) { try { await chrome.debugger.detach({ tabId }); } catch {} }
  }
}

// Scroll-and-stitch full-page fallback (no CDP). Bounded on every axis: fixed
// target height (never grows with the page → infinite scroll is safe), a segment
// cap, a no-progress break, a device-pixel canvas cap, and a wall-clock deadline.
async function stitchFullPage(tab, authHost, format, quality, maxHeightPx) {
  const tabId = tab.id;
  const { scrollHeight, clientHeight, dpr, originalScrollY } = await measurePage(tabId, authHost);
  const fmt = format === "jpeg" ? "jpeg" : "png";
  const mimeType = fmt === "jpeg" ? "image/jpeg" : "image/png";
  const vh = Math.max(1, clientHeight);
  // The stitched canvas is in DEVICE pixels (captureVisibleTab returns device px),
  // so the CSS-px target MUST be capped by SHOT_HARD_MAX_PX / dpr. Otherwise on a
  // HiDPI display (DPR 2 → 4K/retina/Windows scaling) segments below the device cap
  // would be drawn off-canvas and silently clipped (bug H1). Cap is FIXED before the
  // loop, so a growing/infinite page can never extend it.
  const devHint = Math.max(1, dpr || 1);
  const cssCap = Math.min(maxHeightPx, Math.floor(SHOT_HARD_MAX_PX / devHint));
  const targetCss = Math.min(scrollHeight, cssCap);
  let truncated = scrollHeight > targetCss; // page taller than what we can capture
  const MAX_SEGMENTS = 40;
  const deadline = Date.now() + 20000;
  const capOpts = { format: fmt };
  if (fmt === "jpeg" && typeof quality === "number") capOpts.quality = quality;

  let canvas = null, ctx = null, devPerCss = devHint, hDev = 0;
  let lastY = -1, segments = 0, capturedCss = 0;
  try {
    for (let y = 0; y < targetCss; y += vh) {
      if (Date.now() > deadline || segments >= MAX_SEGMENTS) { truncated = true; break; }
      const actualY = await scrollToY(tabId, authHost, y);
      if (segments > 0 && actualY <= lastY) break; // no progress → bottom reached / scroll pinned
      lastY = actualY;
      await new Promise((r) => setTimeout(r, 120)); // let fixed/lazy content settle
      const activeId = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0]?.id;
      if (activeId !== tabId) throw err("INTERNAL", "target tab is not active during full-page capture; retry");
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, capOpts);
      const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
      if (!canvas) {
        devPerCss = bmp.height / vh || devHint; // MEASURED device px per CSS px (accounts for browser zoom)
        hDev = Math.min(Math.round(targetCss * devPerCss), SHOT_HARD_MAX_PX);
        canvas = new OffscreenCanvas(bmp.width, hDev);
        ctx = canvas.getContext("2d");
      }
      const offDev = Math.round(actualY * devPerCss);
      if (offDev >= hDev) { truncated = true; bmp.close?.(); break; } // would fall off the capped canvas → stop, and don't lie about it
      ctx.drawImage(bmp, 0, offDev); // draw at the ACTUAL offset (handles the clamped last segment's overlap)
      bmp.close?.();
      segments++;
      capturedCss = Math.min(targetCss, actualY + vh, Math.floor(hDev / devPerCss)); // real pixels-in-canvas, not just logical progress (bug H2)
      if (actualY + vh >= scrollHeight) break; // reached the original bottom
    }
  } finally {
    await scrollToY(tabId, authHost, originalScrollY).catch(() => {}); // restore the user's scroll position
  }
  if (!canvas) throw err("INTERNAL", "full-page capture produced no frames");
  const blob = await canvas.convertToBlob({ type: mimeType, quality: fmt === "jpeg" && typeof quality === "number" ? quality / 100 : undefined });
  const dataUrl = await blobToDataUrl(blob, mimeType);
  return { mimeType, dataUrl, fullPage: true, via: "stitch", capturedHeightPx: Math.round(capturedCss), fullHeightPx: scrollHeight, truncated: truncated || capturedCss < scrollHeight };
}

// ---------------------------------------------------------------------------
// CDP eval (PART 4) — runs truly arbitrary JS where chrome.scripting MAIN-world
// eval is CSP-blocked, WITHOUT weakening consent. The debugger permission is
// REQUIRED (Chrome forbids requesting it at runtime, so it is granted at install;
// nothing attaches until 'Allow CDP eval' is on) and re-checked at every call;
// consent for CDP is gated in background.js before this is reached
// (state.allowCdp + not read-only).
//
// Attach lifecycle: in force mode (cdpAlways) we KEEP the tab attached between
// calls (avoids the "is being debugged" banner flickering on/off); otherwise we
// detach after every call. `cdpAttached` tracks the held tabs and is cleared on
// disconnect / tab close / consent revoke / DevTools stealing the session.

const cdpAttached = new Set(); // tabIds we hold attached (cdpAlways force mode)
const cdpInFlight = new Map(); // tabId -> in-flight cdpEval count (folds into cdpHeld so a concurrent stop can't detach mid-eval)
// cdpConsole capture (PART 6): per-tab ring buffer + the set of tabs we hold
// attached for console capture. Kept in THIS module so get_console_logs (also in
// HANDLERS) can read the buffer directly — no cross-module plumbing. The Set is
// exported read-only-by-convention so background's reconcileCdpConsole can diff
// the shared set against the captured set (it never mutates it directly).
export const cdpConsoleTabs = new Set(); // tabIds we hold attached for console capture
const cdpLogs = new Map(); // tabId -> ring buffer array (cap 500 entries)
// Network capture (PART 7): per-tab Map(requestId -> record), insertion-ordered so
// listing newest-last is just iteration order. Filled by the Network.* branch of
// ensureCdpListeners while the tab is captured (same lifecycle as cdpLogs). Capped
// at NET_CAP requests per tab (oldest evicted).
const cdpNet = new Map(); // tabId -> Map(requestId -> record)
const NET_CAP = 300;

export async function cdpEval(tabId, code, callArgs, authHost, { hold } = {}) {
  if (!chrome.debugger) throw err("CDP_NOT_PERMITTED", "debugger API unavailable");
  if (!(await chrome.permissions.contains({ permissions: ["debugger"] }))) throw err("CDP_NOT_PERMITTED", "debugger permission not granted");
  // Attach (idempotent): "Another debugger is already attached" (us re-attaching
  // in force/console mode, or DevTools open) is tolerated — proceed to sendCommand.
  ensureCdpListeners();
  try { await chrome.debugger.attach({ tabId }, "1.3"); }
  catch (e) { if (!/already|another debugger/i.test(e?.message || "")) throw err("SCRIPT_ERROR", `debugger attach failed: ${e?.message ?? e}`); }
  if (hold) cdpAttached.add(tabId); // force mode: keep attached past this call
  cdpInFlight.set(tabId, (cdpInFlight.get(tabId) || 0) + 1); // hold across concurrent stops
  try {
    // The origin re-check is folded INTO the eval expression so it is ATOMIC with
    // the agent's code — a navigation can't slip between a separate check and the
    // payload (the scripting path gets this for free by being one injected func).
    // allowUnsafeEvalBlockedByCSP lets eval run even under a strict page CSP. The
    // agent's code `return`s its value inside the async IIFE; `args` is by name.
    const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: `(async()=>{ const __ah=${JSON.stringify(authHost)}; if(__ah){ const h=(location.hostname||"").toLowerCase().replace(/\\.$/,""); if(h!==__ah) return {__tabduct_originMismatch:true}; } const args = ${JSON.stringify(callArgs)}; ${code} })()`,
      awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true, userGesture: false,
    });
    if (r?.exceptionDetails) {
      const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval failed";
      throw err("SCRIPT_ERROR", msg);
    }
    const value = r?.result?.value;
    if (value && typeof value === "object" && value.__tabduct_originMismatch) {
      cdpAttached.delete(tabId); // drift → drop any force-hold so the finally detaches this tab
      throw err("ORIGIN_DRIFT", "tab navigated away from the authorized origin");
    }
    // Same 8MB cap as the scripting path so a huge return can't drop the reply.
    const CAP = 8_000_000;
    let s; try { s = JSON.stringify(value); } catch { s = undefined; }
    if (s !== undefined && s.length > CAP) return { result: s.slice(0, CAP), truncated: true, note: "result truncated to 8MB", via: "cdp" };
    return { result: value, via: "cdp" };
  } finally {
    const n = (cdpInFlight.get(tabId) || 1) - 1;
    if (n <= 0) cdpInFlight.delete(tabId); else cdpInFlight.set(tabId, n);
    // Detach unless force mode / console capture / another in-flight eval holds it.
    if (!cdpHeld(tabId)) { try { await chrome.debugger.detach({ tabId }); } catch {} }
  }
}

// A tab is "held" attached if EITHER cdpEval force mode (cdpAttached) OR console
// capture (cdpConsoleTabs) still needs the debugger session. Used to gate detach
// so one CDP user never detaches another's session out from under it.
function cdpHeld(tabId) { return cdpAttached.has(tabId) || cdpConsoleTabs.has(tabId) || (cdpInFlight.get(tabId) || 0) > 0; }

// Detach one tab + forget it (tab close, consent revoke, ORIGIN_DRIFT, onDetach).
// Only actually detaches when no CDP user still holds the tab; always forgets it.
export async function detachCdpTab(tabId) {
  cdpAttached.delete(tabId);
  cdpConsoleTabs.delete(tabId);
  cdpLogs.delete(tabId);
  cdpNet.delete(tabId);
  if (!cdpHeld(tabId)) { try { await chrome.debugger.detach({ tabId }); } catch {} }
}
// Release cdpAlways force-holds that are no longer wanted: a held tab is kept
// ONLY while force mode is on AND the tab is still shared. Called from the
// background reconcile so unshare/revoke/toggling cdpAlways off promptly drops the
// debugger session (and its banner) instead of leaving it attached to a dead tab.
export async function reconcileCdpForce(keepIds, forceOn) {
  for (const tabId of [...cdpAttached]) {
    if (forceOn && keepIds.has(tabId)) continue;
    cdpAttached.delete(tabId);
    if (!cdpHeld(tabId)) { try { await chrome.debugger.detach({ tabId }); } catch {} }
  }
}
// Detach every held tab (disconnect, allowCdp disabled). Clears BOTH hold sets.
export async function detachAllCdp() {
  const ids = new Set([...cdpAttached, ...cdpConsoleTabs]);
  for (const id of ids) { try { await chrome.debugger.detach({ tabId: id }); } catch {} }
  cdpAttached.clear();
  cdpConsoleTabs.clear();
  cdpLogs.clear();
  cdpNet.clear();
}

// ---------------------------------------------------------------------------
// CDP console capture (PART 6). Console/exception/Log events only arrive while
// the debugger is attached with Runtime/Log enabled, so startCdpConsole is
// called proactively by background's reconcile (not lazily per get_console_logs
// call). The buffer (cdpLogs) is read by get_console_logs above.

// Format a RemoteObject arg into a best-effort string (value > description >
// preview > type). Mirrors how DevTools renders console args.
function fmtCdpArg(a) {
  if (!a) return "";
  if (a.value !== undefined) return String(a.value);
  if (a.description) return String(a.description);
  if (a.preview?.description) return String(a.preview.description);
  return String(a.type);
}

// Buffers every console/exception/Log event for tabs we're capturing. Registered
// idempotently on module load (the `debugger` permission is required, so the API
// is always present) and again from ensureCdpListeners() whenever we attach. The
// permissions.onAdded hook is a harmless belt-and-suspenders in case the permission
// model ever changes. Levels are normalized to the inject path's vocabulary ("warn").
let _cdpListenersOn = false;
function ensureCdpListeners() {
  if (_cdpListenersOn || !chrome.debugger?.onEvent) return;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source?.tabId;
    if (tabId == null) return;
    // Network capture (PART 7): correlate the request lifecycle by requestId into
    // cdpNet. Only tabs we're capturing for have a buffer; others (cdpEval-only
    // attaches) don't enable the Network domain, so no events arrive for them.
    if (method.startsWith("Network.")) {
      const m = cdpNet.get(tabId);
      if (!m) return;
      if (method === "Network.requestWillBeSent") {
        const req = params.request || {};
        // CDP re-fires requestWillBeSent with the SAME requestId on HTTP redirects
        // (carrying params.redirectResponse). Preserve the original start time and
        // record the redirect chain instead of clobbering the whole record (L1).
        const prev = m.get(params.requestId);
        const redirects = prev?.redirects ? prev.redirects.slice() : [];
        if (params.redirectResponse) redirects.push({ url: prev?.url ?? params.redirectResponse.url, status: params.redirectResponse.status });
        m.set(params.requestId, {
          requestId: params.requestId, url: req.url, method: req.method,
          resourceType: params.type || prev?.resourceType || "Other", requestHeaders: req.headers || {},
          startedMs: prev?.startedMs ?? Date.now(), finished: false,
          redirects: redirects.length ? redirects : undefined,
        });
        if (m.size > NET_CAP) { const oldest = m.keys().next().value; m.delete(oldest); } // evict oldest
      } else if (method === "Network.responseReceived") {
        const rec = m.get(params.requestId); if (!rec) return;
        const resp = params.response || {};
        rec.status = resp.status; rec.statusText = resp.statusText; rec.mimeType = resp.mimeType;
        rec.responseHeaders = resp.headers || {}; rec.remoteIP = resp.remoteIPAddress || null;
        rec.fromCache = !!resp.fromDiskCache; rec.resourceType = params.type || rec.resourceType;
      } else if (method === "Network.loadingFinished") {
        const rec = m.get(params.requestId); if (!rec) return;
        rec.finished = true; rec.endedMs = Date.now(); rec.encodedDataLength = params.encodedDataLength;
      } else if (method === "Network.loadingFailed") {
        const rec = m.get(params.requestId); if (!rec) return;
        rec.finished = true; rec.failed = true; rec.errorText = params.errorText;
        rec.canceled = !!params.canceled; rec.endedMs = Date.now(); rec.resourceType = params.type || rec.resourceType;
      }
      return;
    }
    let entry;
    if (method === "Runtime.consoleAPICalled") {
      const t = params.type; // log|warning|error|info|debug|…
      const level = t === "warning" ? "warn" : (t === "error" ? "error" : (t === "info" ? "info" : (t === "debug" ? "debug" : "log")));
      entry = { level, source: "console", ts: Date.now(), text: ((params.args || []).map(fmtCdpArg).join(" ")).slice(0, 1000) };
    } else if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails;
      entry = { level: "error", source: "exception", ts: Date.now(), text: String(d?.exception?.description || d?.text || "uncaught exception").slice(0, 1000) };
    } else if (method === "Log.entryAdded") {
      const e = params.entry || {};
      entry = { level: e.level === "warning" ? "warn" : (e.level || "info"), source: e.source || "log", ts: Date.now(), text: String(e.text || "").slice(0, 1000) };
    } else return;
    const buf = cdpLogs.get(tabId);
    if (!buf) return; // not a tab we're capturing for (e.g. a cdpEval-only call)
    buf.push(entry);
    if (buf.length > 500) buf.splice(0, buf.length - 500);
  });
  _cdpListenersOn = true;
}
chrome.permissions?.onAdded?.addListener((p) => { if (p?.permissions?.includes?.("debugger")) ensureCdpListeners(); });
ensureCdpListeners(); // register now if the debugger permission is already granted

// Attach the debugger (idempotent) and enable Runtime + Log domains so we start
// receiving console/exception/Log events for this tab. Never throws into the
// reconcile loop — best-effort.
export async function startCdpConsole(tabId) {
  try {
    if (!chrome.debugger) return;
    if (!(await chrome.permissions.contains({ permissions: ["debugger"] }))) return;
    ensureCdpListeners(); // register the event buffer before enabling domains
    // Attach (idempotent): tolerate "already attached" (us in force/console mode
    // or DevTools open).
    try { await chrome.debugger.attach({ tabId }, "1.3"); }
    catch (e) { if (!/already|another debugger/i.test(e?.message || "")) return; }
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
    await chrome.debugger.sendCommand({ tabId }, "Log.enable");
    // Network capture (PART 7) is bundled under the same opt-in. Buffer sizes keep
    // recent response bodies retrievable via Network.getResponseBody without
    // unbounded memory. Enable is best-effort — console still works if it fails.
    try { await chrome.debugger.sendCommand({ tabId }, "Network.enable", { maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 5_000_000 }); if (!cdpNet.has(tabId)) cdpNet.set(tabId, new Map()); } catch {}
    cdpConsoleTabs.add(tabId);
    if (!cdpLogs.has(tabId)) cdpLogs.set(tabId, []);
  } catch {}
}

// Stop capturing + best-effort disable the domains, then detach ONLY IF no other
// CDP user still holds the tab. Always clears this tab's bookkeeping + buffer.
export async function stopCdpConsole(tabId) {
  cdpConsoleTabs.delete(tabId);
  try { await chrome.debugger.sendCommand({ tabId }, "Log.disable"); } catch {}
  try { await chrome.debugger.sendCommand({ tabId }, "Runtime.disable"); } catch {}
  try { await chrome.debugger.sendCommand({ tabId }, "Network.disable"); } catch {}
  if (!cdpHeld(tabId)) { try { await chrome.debugger.detach({ tabId }); } catch {} }
  cdpLogs.delete(tabId);
  cdpNet.delete(tabId);
}

// Stop capture on every tab (cdpConsole disabled / connection dropped).
export async function stopAllCdpConsole() {
  for (const tabId of [...cdpConsoleTabs]) await stopCdpConsole(tabId);
}
