// Tabduct extension — tool handlers.
//
// Each handler implements one tool from ../../protocol/tools.schema.json using
// chrome.tabs / chrome.scripting. Handlers are async and return a
// JSON-serializable result, or throw. To signal a specific wire error code,
// throw via err(CODE, message).

import { getState as getConsentState, originBlocked, hostOf, evaluateFrame } from "../consent.js";

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

// ---------------------------------------------------------------------------
// Pinned documents. Every page tool acts on ONE document that was probed, judged by
// consent.evaluateFrame and then targeted by its documentId — for the top frame exactly
// like for child frames (cross-origin iframes: embedded forms, widgets — which neither
// page JS nor CDP's top-level eval can reach). Host permissions already cover every
// frame, so this needs no new permission and no debugger.
//
// Why a documentId and not an in-page "location.host == the host the gate saw" check: a
// document never changes origin and dies with its page, so if the page navigates between
// the check and the action the injection simply fails — it can never land on a different
// (possibly blocked) origin. The old host comparison did the same job only when the host
// could not legitimately change; with lock-to-domain off it produced false ORIGIN_DRIFT on
// every redirect, and it needed a copy of the check inside every tool.
//
// `pin` (args._pin, set by the gate) is the host the tab was authorized on, or undefined
// when lock-to-domain is off: then only the origin filter applies to the page and frames.

// Runs inside a frame: what it is, and which top-level page it lives in.
// Self-contained (serialized by chrome.scripting). `ancestors` are the intermediate parents
// (nearest first, the top-level page excluded); `top` is the top-level page's origin.
export function probeFrame() {
  const a = location.ancestorOrigins ? Array.from(location.ancestorOrigins) : [];
  // `location.origin` is the origin of the document's URL: "null" for about:blank / srcdoc even
  // when the document INHERITED a real origin (a bank's window.open() + document.write popup).
  // `self.origin` is the document's own origin, so it wins whenever it is a real one.
  const own = self.origin && self.origin !== "null" ? self.origin : location.origin;
  return {
    url: location.href, origin: own, urlOrigin: location.origin, top: a.length ? a[a.length - 1] : own,
    ancestors: a.slice(0, -1),
    depth: a.length, title: document.title, width: innerWidth, height: innerHeight,
  };
}

// Consent verdict for one probed frame (the top frame included). Judged by the document's own
// origin, by the origin of its URL and by the host of its URL (all three must pass).
function frameVerdict(state, pin, f) {
  return evaluateFrame(state, {
    pin, topHost: hostOf(f.top), frameHost: hostOf(f.origin), frameUrlHost: hostOf(f.url),
    ancestorHosts: [...(f.ancestors || []).map(hostOf), ...[f.urlOrigin && f.urlOrigin !== f.origin ? hostOf(f.urlOrigin) : null].filter(Boolean)],
  });
}

// The reply to navigate describes the page the tab ENDED on. A redirect can end it on a page the
// caller has no right to see (a filtered-out site, or another origin than the one the lock pins
// the tab to): then say so without its address or title.
async function withholdIfOutside(info, pin) {
  const h = hostOf(info.url);
  if (!originBlocked(await getConsentState(), h) && (pin === undefined || h === pin)) return info;
  return { id: info.id, windowId: info.windowId, withheld: true, note: "the tab ended on a page outside what is shared (a redirect); its address and title are withheld" };
}

// executeScript with a readable error: a call that lands on a document that has just been
// replaced fails here, which is the safe outcome.
async function exec(target, details) {
  try { return await chrome.scripting.executeScript({ target, ...details }); }
  catch (e) { throw err("SCRIPT_ERROR", `${e?.message ?? e} (the page may have navigated or closed during the call - retry)`); }
}

// Every frame of a shared tab the consent policy lets the agent see, top first.
// Frames whose origin is filtered out are omitted, like unshared tabs; a drifted
// top-level page refuses the whole call.
async function framesOf(tabId, pin) {
  const results = await exec({ tabId, allFrames: true }, { func: probeFrame });
  const state = await getConsentState();
  const frames = [];
  for (const r of results || []) {
    if (!r?.result) continue;
    const d = frameVerdict(state, pin, r.result);
    if (d.code === "ORIGIN_DRIFT") throw err(d.code, d.message);
    if (d.allow) frames.push({ frameId: r.frameId, documentId: r.documentId, ...r.result });
  }
  return frames.sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : 0));
}

// Probe + judge one frame (0 = the page itself) and return its documentId.
async function pinFrame(tabId, frameId, pin) {
  if (!Number.isInteger(frameId) || frameId < 0) throw err("INVALID_ARGS", "frameId must be a non-negative integer (from list_frames)");
  let r, why = "";
  try { [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: probeFrame }); } catch (e) { why = e?.message ?? String(e); }
  if (!r?.result) {
    if (frameId === 0) throw Object.assign(err("SCRIPT_ERROR", `can't read this page${why ? `: ${why}` : ""}`), { transient: true });
    throw Object.assign(err("INVALID_ARGS", `no frame ${frameId} in this tab (it may have closed) - call list_frames`), { frameGone: true, transient: true });
  }
  const d = frameVerdict(await getConsentState(), pin, r.result);
  if (!d.allow) throw err(d.code, d.message);
  return r.documentId;
}

// Where a tool's injected function runs: one pinned document (the page, or a child frame).
async function injectionTarget(args) {
  const tabId = await resolveTabId(args);
  const frameId = args.frameId || 0;
  const documentId = await pinFrame(tabId, frameId, args._pin);
  return { tabId, frameId, target: { tabId, documentIds: [documentId] } };
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
      return withholdIfOutside(tabInfo(await chrome.tabs.get(tabId)), args._pin);
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
      const onUpd = (id, info) => { if (id === tabId && info.status === "complete") finish(resolve, "complete"); };
      const onRem = (id) => { if (id === tabId) finish(reject, err("TAB_NOT_FOUND", "tab closed during navigation")); };
      const timer = setTimeout(() => finish(resolve, "deadline"), 15000);
      chrome.tabs.onUpdated.addListener(onUpd);
      chrome.tabs.onRemoved.addListener(onRem);
    });
    await chrome.tabs.update(tabId, { url: args.url });
    const outcome = await done;
    const info = await withholdIfOutside(tabInfo(await chrome.tabs.get(tabId)), args._pin);
    // The deadline is not a failure of the navigation itself (slow SPAs, consoles that never
    // go idle), but it must not be reported as "complete" either: say what happened.
    if (info.withheld) return { ...info, completed: outcome === "complete" };
    return outcome === "complete" ? { ...info, completed: true }
      : { ...info, completed: false, note: "still loading after 15s; use wait_for (selector / urlContains / loadState) for what you need" };
  },

  async get_page_content(args) {
    const t = await injectionTarget(args);
    const format = args?.format ?? "text";
    // 0 used to mean "no limit": a huge DOM then exceeded the native-messaging frame cap and
    // the reply was dropped (a misleading TIMEOUT). Hard-cap it instead.
    const HARD = 8_000_000;
    const asked = args?.maxChars ?? 200000;
    const maxChars = asked > 0 ? Math.min(asked, HARD) : HARD;
    const results = await exec(t.target, {
      args: [format],
      func: (fmt) => {
        if (fmt === "html") return document.documentElement.innerHTML;
        if (fmt === "outerHTML") return document.documentElement.outerHTML;
        if (fmt === "textContent") return document.body ? document.body.textContent : "";
        return document.body ? document.body.innerText : "";
      },
    });
    const raw = results?.[0]?.result;
    const text = typeof raw === "string" ? raw : "";
    return { format, truncated: text.length > maxChars, content: text.slice(0, maxChars) };
  },

  async execute_script(args) {
    // CDP evaluates in the top frame only, so a child frame always runs via
    // chrome.scripting: an explicit engine:"cdp" is refused, developer mode's
    // force-CDP quietly doesn't apply (the result's `via` says what ran).
    if (args.frameId && args.engine === "cdp") throw err("INVALID_ARGS", "engine 'cdp' can't target a child frame - use engine 'auto' or 'scripting' with frameId");
    const t = await injectionTarget(args);
    const tabId = t.tabId;
    // Engine selection (PART 4). _engine/_allowCdp are injected by background's
    // gate from the user's CDP settings; default "auto" = chrome.scripting with a
    // CDP fallback only when CSP blocks AND the user opted in.
    const engine = t.frameId ? "scripting" : args._engine === "cdp" || args._engine === "scripting" ? args._engine : "auto";
    const allowCdp = !!args._allowCdp;
    const callArgs = args.args ?? [];

    if (engine === "cdp") return cdpEval(tabId, args.code, callArgs, args._pin, { hold: !!args._cdpAlways });

    const runScripting = async () => {
      // Runs in the page's MAIN world, in the pinned document. Arbitrary-string eval is
      // subject to the PAGE's CSP; on strict-CSP sites it surfaces cleanly as CSP_BLOCKED. The
      // CSP-proof fallback is CDP (cdpEval) when the user opts in; the real
      // roadmap fix is chrome.userScripts. (ISOLATED world was removed: extension
      // MV3 CSP forbids eval there, so it could never succeed.)
      let results;
      try {
        results = await chrome.scripting.executeScript({
          target: t.target,
          world: "MAIN",
          args: [args.code, callArgs],
          func: (code, callArgs) => {
            try {
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
      if (t.frameId && e?.code === "CSP_BLOCKED") throw err("CSP_BLOCKED", `${e.message} - this frame's CSP blocks eval and CDP can't reach child frames; use get_dom_snapshot / click / type / get_page_content with frameId (CSP-safe)`);
      // "auto": on a CSP block, fall back to CDP if the user opted in; otherwise
      // surface CSP_BLOCKED with a hint pointing at the opt-in.
      if (engine === "auto" && e?.code === "CSP_BLOCKED") {
        if (allowCdp) return cdpEval(tabId, args.code, callArgs, args._pin, { hold: false });
        throw err("CSP_BLOCKED", `${e.message} - enable 'Allow CDP eval' in the Tabduct popup and retry`);
      }
      throw e;
    }
  },

  async screenshot(args) {
    const tabId = await resolveTabId(args);
    let tab = await chrome.tabs.get(tabId);
    const pin = args._pin;
    const format = args?.format === "jpeg" ? "jpeg" : "png";
    const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
    // captureVisibleTab only sees the window's ACTIVE tab.
    if (!tab.active) {
      if (!args?.activate) throw err("INVALID_ARGS", `tab ${tabId} is not active; captureVisibleTab only sees the active tab - pass activate:true or activate_tab first`);
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      tab = await chrome.tabs.get(tabId);
    }

    // Optionally scroll a selector/offset into view first, then capture the viewport.
    if (args.selector || typeof args.scrollTo === "number") {
      await scrollTab(tabId, pin, args.selector || null, typeof args.scrollTo === "number" ? args.scrollTo : null);
    }
    const opts = { format };
    if (format === "jpeg" && typeof args?.quality === "number") opts.quality = args.quality;
    // captureVisibleTab is WINDOW-scoped — it grabs whatever tab is active in the
    // window at capture time, not `tabId`. A focus change (concurrent invoke or the
    // user switching tabs) could otherwise leak an UNshared tab's pixels. Assert the
    // authorized tab is the active one immediately before AND after the capture.
    const activeIs = async () => (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0]?.id;
    if (await activeIs() !== tabId) throw err("INTERNAL", "target tab is not the active tab; retry");
    // The capture is of PIXELS: whatever is rendered goes to the agent, including visible
    // iframes. Re-check the page (it could have self-navigated since the gate) AND refuse
    // when the page shows a frame of a site the origin filter excludes. A manual capture the
    // USER triggers from the popup (_manual) is theirs to take.
    if (!args._manual) await assertCapturable(tabId, pin);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, opts);
    if (await activeIs() !== tabId) throw err("INTERNAL", "active tab changed during capture; retry");
    // The page can change between the check above and the instant the pixels were taken (a frame
    // that was 0x0 or absent gets shown, the document navigates): look again AFTERWARDS and drop
    // the image if the page is no longer one we would have let through. Best effort - a frame
    // shown and hidden again entirely inside the capture cannot be seen from here.
    if (!args._manual) await assertCapturable(tabId, pin);
    return { mimeType, dataUrl };
  },

  // CSP-safe interaction/wait tools (PART 1) + console capture (PART 2).
  // All run via chrome.scripting.executeScript({target, func, args}) — i.e.
  // INJECTED FUNCTIONS, never string eval — so page CSP (which blocks string
  // eval) does not stop them. Each runs in the document that injectionTarget pinned
  // (probed, consent-checked, targeted by documentId).

  async wait_for(args) {
    // At least one condition is required (no field is individually required in
    // the schema, so enforce the "at least one" rule here).
    if (!args.selector && !args.text && !args.urlContains && !args.loadState) throw err("INVALID_ARGS", "wait_for needs at least one of selector, text, urlContains, loadState");
    if (args.loadState && args.loadState !== "complete") throw err("INVALID_ARGS", "loadState must be 'complete'");
    const _t = Number(args.timeoutMs); const timeoutMs = Math.min(_t > 0 ? _t : 10000, 25000); // default 10s, cap 25s
    const selector = args.selector || null, urlContains = args.urlContains || null, loadState = args.loadState || null;
    const text = typeof args.text === "string" && args.text ? args.text : null;
    const start = Date.now();
    // Poll ~every 250ms (bounded by timeoutMs). Each poll RE-PINS the document: waiting often
    // spans a redirect or the frame's own navigation (a submitted form), which replaces the
    // document — a page/frame briefly between documents is not an error, just "not yet" (and the
    // new document is judged afresh: lock-to-domain on → ORIGIN_DRIFT, off → only the filter).
    let lastErr = null;
    const check = async () => {
      let t;
      try { t = await injectionTarget(args); } catch (e) { if (e.transient) { lastErr = e.message; return null; } throw e; }
      let results;
      try {
        results = await chrome.scripting.executeScript({
          target: t.target,
          args: [selector, urlContains, loadState, text],
          func: (sel, urlContains, loadState, text) => {
            if (sel) { let el; try { el = document.querySelector(sel); } catch (e) { return { __badselector: String((e && e.message) || e) }; } if (el) return { matched: true }; }
            if (urlContains && location.href.includes(urlContains)) return { matched: true };
            if (loadState && document.readyState === loadState) return { matched: true };
            if (text && (document.body?.innerText ?? "").includes(text)) return { matched: true };
            return { matched: false };
          },
        });
      } catch (e) { lastErr = e?.message ?? String(e); return null; } // pinned document replaced mid-poll
      return results?.[0]?.result;
    };
    while (Date.now() - start < timeoutMs) {
      const r = await check();
      if (r && r.__badselector) throw err("INVALID_ARGS", `invalid CSS selector: ${r.__badselector}`);
      if (r && r.matched) return { matched: true, waitedMs: Date.now() - start };
      await new Promise((res) => setTimeout(res, 250));
    }
    throw err("TIMEOUT", `wait_for timed out after ${timeoutMs}ms${lastErr ? ` (last error: ${lastErr})` : ""}`);
  },

  async click(args) {
    if (!args.selector) throw err("INVALID_ARGS", "click requires a selector");
    if (args.trusted) return trustedClick(args);
    const t = await injectionTarget(args);
    const results = await exec(t.target, {
      args: [args.selector],
      func: (sel) => {
        let el; try { el = document.querySelector(sel); } catch (e) { return { __badselector: String((e && e.message) || e) }; }
        if (!el) return { __notfound: true };
        if (typeof el.click !== "function") return { __notclickable: true };
        el.scrollIntoView({ block: "center" });
        el.click();
        return { ok: true };
      },
    });
    const r = results?.[0]?.result;
    if (!r) throw err("SCRIPT_ERROR", "no result frame (target unavailable?)");
    if (r.__badselector) throw err("INVALID_ARGS", `invalid CSS selector: ${r.__badselector}`);
    if (r.__notfound) throw err("SCRIPT_ERROR", `no element matches ${args.selector}`);
    if (r.__notclickable) throw err("SCRIPT_ERROR", `element ${args.selector} is not clickable`);
    return { clicked: true, selector: args.selector };
  },

  async type(args) {
    if (typeof args.text !== "string") throw err("INVALID_ARGS", "type requires text");
    if (args.trusted) return trustedType(args); // a selector is optional here: omit it to type into whatever has focus
    if (!args.selector) throw err("INVALID_ARGS", "type requires a selector");
    const clear = !!args.clear;
    const t = await injectionTarget(args);
    const results = await exec(t.target, {
      args: [args.selector, args.text, clear],
      func: (sel, text, clear) => {
        let el; try { el = document.querySelector(sel); } catch (e) { return { __badselector: String((e && e.message) || e) }; }
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
        } else if (tag === "select") {
          // Choose the option by value or visible text — never rewrite the element's children.
          const want = text.trim();
          const opt = [...el.options].find((o) => o.value === text) || [...el.options].find((o) => o.text.trim() === want);
          if (!opt) return { __nooption: true, options: [...el.options].slice(0, 30).map((o) => o.text.trim()) };
          el.value = opt.value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (el.isContentEditable) {
          // Editing through the browser's own insertText path fires beforeinput/input like a user would.
          const sel2 = getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          if (!clear) range.collapse(false);
          sel2.removeAllRanges(); sel2.addRange(range);
          let done = false;
          try { done = document.execCommand("insertText", false, text); } catch {}
          if (!done) {
            el.textContent = clear ? text : (el.textContent || "") + text;
            el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
          }
        } else {
          return { __noteditable: true, tag };
        }
        return { ok: true };
      },
    });
    const r = results?.[0]?.result;
    if (!r) throw err("SCRIPT_ERROR", "no result frame (target unavailable?)");
    if (r.__badselector) throw err("INVALID_ARGS", `invalid CSS selector: ${r.__badselector}`);
    if (r.__notfound) throw err("SCRIPT_ERROR", `no element matches ${args.selector}`);
    if (r.__nooption) throw err("INVALID_ARGS", `no <option> matches ${JSON.stringify(args.text)}; options: ${r.options.join(" | ")}`);
    if (r.__noteditable) throw err("INVALID_ARGS", `<${r.tag}> is not editable - type works on input, textarea, select and contenteditable elements`);
    return { typed: true, selector: args.selector };
  },

  // Trusted (isTrusted) keyboard input through CDP: Enter in a terminal, Tab, Escape, arrows,
  // Ctrl+C... See "Trusted input" below.
  async press_key(args) { return pressKey(args); },

  async get_dom_snapshot(args) {
    const t = await injectionTarget(args);
    const _m = Number(args.maxChars); const maxChars = Math.min(_m > 0 ? _m : 40000, 200000); // default 40000, hard cap 200000
    const outline = (target) => exec(target, { args: [maxChars], func: outlineDom });
    const r = (await outline(t.target))?.[0]?.result;
    if (!r) return { snapshot: "", truncated: false };
    if (t.frameId || r.truncated) return r;
    // The top-level page: append each visible child frame's outline under a header
    // naming its frameId, so an embedded (often cross-origin) form shows up in the
    // one call an agent makes to find its targets. Frames are pinned by documentId
    // and consent-filtered by framesOf; one that vanishes meanwhile is just skipped.
    const kids = (await framesOf(t.tabId, args._pin)).filter((f) => f.frameId !== 0 && f.width > 0 && f.height > 0);
    const outs = await Promise.all(kids.map((f) => outline({ tabId: t.tabId, documentIds: [f.documentId] }).catch(() => null)));
    const sections = [r.snapshot];
    kids.forEach((f, i) => {
      const s = outs[i]?.[0]?.result?.snapshot;
      if (s) sections.push(`--- frame ${f.frameId} (${hostOf(f.origin) ?? f.url}) - pass frameId:${f.frameId} to target it ---\n${s}`);
    });
    const snapshot = sections.filter(Boolean).join("\n");
    return snapshot.length > maxChars ? { snapshot: snapshot.slice(0, maxChars), truncated: true } : { snapshot, truncated: false };
  },

  async get_console_logs(args) {
    const t = await injectionTarget(args);
    const tabId = t.tabId;
    const clear = !!args.clear;
    // CDP capture path: when console capture is attached to this tab we return the
    // FULL buffer (console.* + uncaught exceptions + browser Log entries), recorded
    // continuously since attach — not just since this call. Falls back to the
    // injected monkeypatch below when CDP capture is off. The buffer is the top
    // frame's; a child frame always uses the injected hook.
    if (!t.frameId && cdpConsoleTabs.has(tabId)) {
      // The CDP buffer keeps filling across a navigation, so re-check where the tab is NOW
      // (and where it is headed) before handing anything over...
      await assertNetOrigin(tabId, args._pin);
      // ...and never hand over lines that came from a document of a filtered-out origin (a
      // same-site iframe of a blocked host logs into the same buffer).
      const state = await getConsentState();
      const buf = cdpLogs.get(tabId);
      const logs = (buf ? buf : []).filter((e) => !consoleEntryBlocked(state, e)).map(({ url, origin, ...rest }) => rest);
      if (clear) cdpLogs.set(tabId, []); // keep a (now empty) buffer: dropping it would silently stop the capture
      return { logs, source: "cdp", note: "captured via CDP (console + exceptions + browser log entries)" };
    }
    // MAIN world: we must patch the PAGE's console object (ISOLATED world has its
    // own console and would capture nothing). Re-installs on each call, so a
    // page navigation (which wipes the hook) is recovered automatically.
    const results = await exec(t.target, {
      world: "MAIN",
      args: [clear],
      func: (clear) => {
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
    return { logs: r?.logs || [], source: "inject", note: "capture starts when first requested; earlier logs may be missing" };
  },

  async list_frames(args) {
    const tabId = await resolveTabId(args);
    const frames = await framesOf(tabId, args._pin);
    return {
      frames: frames.map(({ frameId, url, title, depth, width, height }) => ({ frameId, url, title, depth, width, height })),
      note: "frameId 0 is the page itself; pass another frameId to get_dom_snapshot/get_page_content/click/type/wait_for/execute_script/get_console_logs to act inside that frame",
    };
  },

  // Network inspection (PART 7) — read the CDP-captured request log for a shared
  // tab. Bundled under the SAME opt-in as console capture (cdpConsole): when that
  // is on, background's reconcile enables the Network domain on each shared tab and
  // buffers requests into cdpNet (see ensureCdpListeners + startCdpConsole). No
  // separate consent gate: capture only runs while the tab is attached, and these
  // tools are "read" (allowed in read-only). Origin re-checked like get_console_logs.
  async list_network_requests(args) {
    const tabId = await resolveTabId(args);
    if (!cdpConsoleTabs.has(tabId)) return { requests: [], source: "off", note: "network capture is off - enable 'Capture console, errors & network via CDP' in the Tabduct popup (Advanced)" };
    await assertNetOrigin(tabId, args._pin);
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
    // back to an allowed one. (assertNetOrigin only guards the CURRENT url.) A request that
    // was redirected is judged by EVERY hop, not just where it ended up.
    const cstate = await getConsentState();
    list = list.filter((r) => !recordBlocked(cstate, r));
    const total = list.length;
    const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500);
    const requests = list.slice(-limit).map(netSummary); // newest-last; take the newest `limit`
    if (args.clear && m) m.clear();
    return { requests, total, returned: requests.length, source: "cdp" };
  },

  async get_network_request(args) {
    const tabId = await resolveTabId(args);
    if (!args.requestId || typeof args.requestId !== "string") throw err("INVALID_ARGS", "get_network_request requires a string requestId");
    if (!cdpConsoleTabs.has(tabId)) throw err("CDP_NOT_PERMITTED", "network capture is off - enable 'Capture console, errors & network via CDP' in the Tabduct popup (Advanced)");
    await assertNetOrigin(tabId, args._pin);
    const rec = cdpNet.get(tabId)?.get(args.requestId);
    if (!rec) throw err("SCRIPT_ERROR", `no captured request with id ${args.requestId} (it may have been evicted from the buffer)`);
    // Denylist over historical buffered data (M1) — same reasoning as list_network_requests.
    const cstate = await getConsentState();
    if (recordBlocked(cstate, rec)) throw err("ORIGIN_DENIED", "destination not allowed by consent policy");
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
    const { docUrl, ...request } = rec;
    return { request, body, bodyBase64, bodyTruncated, bodyError };
  },
};

// get_dom_snapshot's injected walker (self-contained: serialized by chrome.scripting).
// Emits a compact outline of the visible interactive/structural elements — enough
// to pick click/type selectors on CSP sites without arbitrary JS.
function outlineDom(maxChars) {
  const SEL = "a,button,input,textarea,select,summary,[role],label,h1,h2,h3,h4,h5,h6,nav,form,fieldset,legend,optgroup,option,video,audio,canvas,table,thead,tbody,th,td,li,datalist,output,iframe";
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
  // An iframe has no text of its own: label it by its src (its content is outlined
  // separately, under its frameId).
  const labelOf = (el) => (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name"))) || (el.nodeName === "IFRAME" ? el.src : (el.textContent || "").trim());
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
}

// Is a buffered console line from a document of a filtered-out origin? Judged by the execution
// context's origin AND the call-frame / resource URL. A line whose source can't be established
// at all (an opaque origin, no URL) is dropped while any filter is active: fail closed.
export function consoleEntryBlocked(state, e) {
  if (state.originMode !== "allow" && !(state.denyOrigins || []).length) return false; // nothing is filtered
  const hosts = [e.origin, e.url].map((u) => (u ? hostOf(u) : null));
  if (hosts.some((h) => h && originBlocked(state, h))) return true;
  return hosts.every((h) => !h);
}

// Origin re-check for the CDP-buffer tools: the buffer keeps filling across a navigation,
// so a tab that wandered off its shared origin (lock on) or onto a filtered-out origin
// could otherwise leak that origin's traffic. Checks the committed URL AND a PENDING
// (not-yet-committed) navigation — during a pending nav `tab.url` still shows the old
// authorized origin while CDP already buffers requests for the new destination.
async function assertNetOrigin(tabId, pin) {
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch {}
  const state = await getConsentState();
  const cur = hostOf(tab?.url);
  const pending = tab?.pendingUrl ? hostOf(tab.pendingUrl) : null;
  if (pin !== undefined && (cur !== pin || (pending && pending !== pin))) throw err("ORIGIN_DRIFT", "tab navigated away from the authorized origin");
  if (originBlocked(state, cur) || (pending && originBlocked(state, pending))) throw err("ORIGIN_DENIED", "destination not allowed by consent policy");
}

// Before a screenshot: the page must still be the authorized one, and no VISIBLE frame may
// belong to a site the origin filter excludes (its pixels would be in the image).
async function assertCapturable(tabId, pin) {
  const results = await exec({ tabId, allFrames: true }, { func: probeFrame });
  const state = await getConsentState();
  let sawTop = false;
  for (const r of results || []) {
    const f = r?.result;
    if (!f) continue;
    if (r.frameId === 0) {
      sawTop = true;
      const d = frameVerdict(state, pin, f);
      if (!d.allow) throw err(d.code, d.message);
    } else if (f.width > 0 && f.height > 0) {
      const d = frameVerdict(state, undefined, f);
      if (!d.allow) throw err("ORIGIN_DENIED", "the page shows a frame of a site excluded by the origin filter; refusing to capture it");
    }
  }
  if (!sawTop) throw err("SCRIPT_ERROR", "can't verify the page before capturing it");
}

// A buffered network record is blocked when ANY hop of it (final URL or an earlier redirect
// hop) is on a filtered-out origin.
function recordBlocked(state, rec) {
  if (originBlocked(state, hostOf(rec.url))) return true;
  // ...or when the DOCUMENT that issued it is (a same-site frame of a blocked host fetching from a
  // neutral API host): its Referer / Authorization headers would otherwise be handed over.
  if (rec.docUrl && originBlocked(state, hostOf(rec.docUrl))) return true;
  return (rec.redirects || []).some((h) => originBlocked(state, hostOf(h.url)));
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

// Scroll a selector/offset into view before a viewport capture (in the pinned top document).
async function scrollTab(tabId, pin, selector, y) {
  const documentId = await pinFrame(tabId, 0, pin);
  const r = (await exec({ tabId, documentIds: [documentId] }, {
    args: [selector, y],
    func: (sel, y) => {
      if (sel) {
        let el; try { el = document.querySelector(sel); } catch (e) { return { __badselector: String((e && e.message) || e) }; }
        if (!el) return { __notfound: true };
        el.scrollIntoView({ block: "center", inline: "center" });
      } else if (y != null) window.scrollTo(0, y);
      return { ok: true };
    },
  }))?.[0]?.result;
  if (r?.__badselector) throw err("INVALID_ARGS", `invalid CSS selector: ${r.__badselector}`);
  if (r?.__notfound) throw err("SCRIPT_ERROR", `no element matches ${selector}`);
  await new Promise((res) => setTimeout(res, 150)); // let it paint/settle
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
// Tabs whose "is being debugged" banner the USER dismissed: capture is not re-armed on them
// until a CDP setting is changed deliberately (background clears this set then).
export const cdpUserCancelled = new Set();
const cdpLogs = new Map(); // tabId -> ring buffer array (cap 500 entries)
const cdpContexts = new Map(); // tabId -> Map(executionContextId -> {origin, uniqueId, frameId, isDefault}): which document each JS context belongs to
const CTX_CAP = 2000;
// Network capture (PART 7): per-tab Map(requestId -> record), insertion-ordered so
// listing newest-last is just iteration order. Filled by the Network.* branch of
// ensureCdpListeners while the tab is captured (same lifecycle as cdpLogs). Capped
// at NET_CAP requests per tab (oldest evicted).
const cdpNet = new Map(); // tabId -> Map(requestId -> record)
const NET_CAP = 300;

// CDP evaluation is bound to ONE JavaScript context of the page: the browser tells us which
// document each context belongs to (its real origin, not something the page can report about
// itself), we judge that origin, and Runtime.evaluate then runs INSIDE that very context
// (`uniqueContextId`). A context dies with its document, so if the page navigates between the
// check and the evaluation the call fails (ORIGIN_DRIFT) instead of running in a different,
// possibly blocked, document - the same guarantee the scripting path gets from documentId.
// Nothing about the consent rules is sent into the page, and nothing the page can overwrite
// (Array.prototype, URL, ...) takes part in the decision.

// Pure verdict for the origin of the context a CDP call is about to run in. `pin` = the host the
// tab is pinned to (lock-to-domain on; null = a blank page) or undefined (lock off / "Everything":
// then only the origin filter applies). Returns null (allowed) or { code, message }.
export function judgeContext(state, pin, origin) {
  const host = hostOf(origin); // "null" / "" (opaque) -> null
  if (pin !== undefined && host !== pin) return { code: "ORIGIN_DRIFT", message: "tab navigated away from the authorized origin" };
  if (originBlocked(state, host)) return { code: "ORIGIN_DENIED", message: "destination not allowed by consent policy" };
  return null;
}

// The default (main-world) context of the tab's top frame, from the context map the Runtime
// domain keeps filled. Retries briefly: the context events of a document that has just committed
// can trail the frame tree by a few milliseconds.
async function topContext(send, tabId) {
  const topId = (await send("Page.getFrameTree"))?.frameTree?.frame?.id;
  for (let i = 0; i < 8; i++) {
    let best = null;
    for (const [id, c] of cdpContexts.get(tabId) || []) if (c.isDefault && c.frameId === topId && c.uniqueId && (!best || id > best.id)) best = { id, ...c };
    if (best) return best;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw err("SCRIPT_ERROR", "can't find the page's JavaScript context (is the tab still loading?) - retry");
}

// Evals on one tab run one after another: they share the Runtime domain (and its context map).
// A script that never finishes (awaits a frame of a hidden page, a dialog is open, a promise nobody
// resolves) must not block every later eval on that tab: after the deadline the debugger is detached
// (which makes the pending command fail), the caller gets an error and the queue moves on.
// Limits are mutable for the tests; both stay under the hub's 20 s per-call budget so the agent gets
// OUR explanation instead of the hub's bare TIMEOUT.
export const evalDeadline = { ms: 17000, queueMs: 8000 }; // a script's own run time; how long a caller waits behind another script
export const callDeadline = { ms: 18000 }; // any tool call (wait_for: its own wait plus 3 s)

// What a hung call usually means. A page that is waiting for the user cannot answer anything.
const BLOCKED_HINT = "A page that is waiting for the user cannot answer: a 'Leave site?' prompt after a reload or a navigation, an alert or a print dialog, or a tab Chrome has frozen after a long time in the background. Look at the browser window (with 'Wake the browser' on it is brought forward), answer the dialog there and retry.";
const stuck = (code, message) => Object.assign(err(code, message), { stuck: true }); // `stuck`: the caller of the tool may raise the window

// `usedMs`: time the call has already spent (a thaw before it) - the budget is for the whole call, so the agent still gets OUR answer.
export function withCallDeadline(tool, args, work, usedMs = 0) {
  const ms = tool === "wait_for" ? Math.min(Number(args?.timeoutMs) > 0 ? Number(args.timeoutMs) : 10000, 25000) + 3000 : callDeadline.ms;
  let timer;
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(stuck("TIMEOUT", `the page did not answer ${tool} within ${Math.round(ms / 1000)} s. ${BLOCKED_HINT}`)), Math.max(Math.min(1000, ms), ms - usedMs)); });
  work.catch(() => {}); // when the guard wins, the late outcome of the abandoned call is not an unhandled rejection
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}

function withDeadline(tabId, work) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      cdpAttached.delete(tabId);
      chrome.debugger.detach({ tabId }).catch(() => {});
      reject(stuck("SCRIPT_ERROR", `the script did not finish within ${Math.round(evalDeadline.ms / 1000)} s and was stopped. Code that waits for an animation frame never completes in a hidden or minimized window. ${BLOCKED_HINT}`));
    }, evalDeadline.ms);
  });
  work.catch(() => {}); // when the guard wins, the late failure of the detached call is not an unhandled rejection
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}
const evalChain = new Map(); // tabId -> tail promise (settles when everything submitted so far has finished)
const evalRunning = new Map(); // tabId -> when the script that is running now started
export function cdpEval(tabId, code, callArgs, pin, opts = {}) {
  const prev = evalChain.get(tabId);
  const run = (async () => {
    if (prev) { // something is ahead of us: wait for it, but not behind a script that is stuck
      let timer;
      const late = new Promise((res) => { timer = setTimeout(() => res("late"), evalDeadline.queueMs); });
      const first = await Promise.race([prev.then(() => "go"), late]);
      clearTimeout(timer);
      if (first === "late") {
        const since = evalRunning.get(tabId);
        throw stuck("SCRIPT_ERROR", `another script on this tab ${since ? `has been running for ${Math.round((Date.now() - since) / 1000)} s and` : "is ahead of this call and"} has not finished. ${BLOCKED_HINT}`);
      }
    }
    evalRunning.set(tabId, Date.now());
    try { return await withDeadline(tabId, cdpEvalNow(tabId, code, callArgs, pin, opts)); }
    finally { evalRunning.delete(tabId); }
  })();
  // The next caller waits for BOTH the one ahead and this one, even when this one gave up waiting:
  // scripts on a tab still never run side by side.
  const tail = Promise.allSettled([prev, run]).then(() => {});
  evalChain.set(tabId, tail);
  tail.then(() => { if (evalChain.get(tabId) === tail) evalChain.delete(tabId); });
  return run;
}

async function cdpEvalNow(tabId, code, callArgs, pin, { hold } = {}) {
  const state = await getConsentState();
  return cdpWith(tabId, { hold }, async (send) => {
    // Console capture keeps Runtime enabled (and the map current) on its own; otherwise enable it
    // for this call - that re-announces every live context - and switch it off again afterwards.
    const ours = !cdpConsoleTabs.has(tabId);
    if (ours) { cdpContexts.delete(tabId); try { await send("Runtime.disable"); } catch {} } // start from a clean slate: a fresh enable re-announces every context
    try {
      await send("Runtime.enable");
      const ctx = await topContext(send, tabId);
      const bad = judgeContext(state, pin, ctx.origin);
      if (bad) { cdpAttached.delete(tabId); throw err(bad.code, bad.message); } // drop any force-hold so the finally detaches this tab
      // The agent's code `return`s its value inside the async IIFE; `args` is by name.
      // allowUnsafeEvalBlockedByCSP lets eval run even under a strict page CSP.
      let r;
      try {
        r = await send("Runtime.evaluate", {
          expression: `(async()=>{ const args = ${JSON.stringify(callArgs)}; ${code} })()`,
          uniqueContextId: ctx.uniqueId, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true, userGesture: false,
        });
      } catch (e) {
        if (/context|not found|navigat/i.test(e?.message || "")) { cdpAttached.delete(tabId); throw err("ORIGIN_DRIFT", "the page navigated while the call was starting; nothing ran in the new page - retry"); }
        throw e;
      }
      if (r?.exceptionDetails) {
        const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval failed";
        throw err("SCRIPT_ERROR", msg);
      }
      const value = r?.result?.value;
      // Same 8MB cap as the scripting path so a huge return can't drop the reply.
      const CAP = 8_000_000;
      let s; try { s = JSON.stringify(value); } catch { s = undefined; }
      if (s !== undefined && s.length > CAP) return { result: s.slice(0, CAP), truncated: true, note: "result truncated to 8MB", via: "cdp" };
      return { result: value, via: "cdp" };
    } finally {
      if (ours && !cdpConsoleTabs.has(tabId)) { try { await send("Runtime.disable"); } catch {} cdpContexts.delete(tabId); }
    }
  });
}

// A page Chrome has FROZEN (hidden and silent for a long time, mostly under Energy Saver) runs nothing: every
// scripting call and every CDP evaluation to it hangs until it is thawed. `tab.frozen` says so, and the
// debugger can thaw it without touching the window (Page.setWebLifecycleState "active"; verified in a real
// Chrome, window stays minimized). Needs the debugger opt-in ("Allow CDP eval"). Returns what happened.
//
// The debugger stays attached after the thaw (until the call is over plus `thawLinger`): Chrome does not freeze
// a page a DevTools session is inspecting. 1.7.0 detached right after the thaw, and a tab frozen by Chrome itself
// (not by hand) still hung; the likely reason is that the page froze again once the session ended.
//
// 1.7.1 showed (on a tab Chrome had frozen by itself) that the thaw can fail while the very same command works on a
// tab frozen from chrome://discards. So several ways are tried in turn, and what each one did is kept as a short
// trace that goes into the error text of a call that still hangs. That trace is how the cause gets found.
export const thawWait = { polls: 10, pollMs: 100, settleMs: 200 }; // mutable for the tests: how long to watch a try, and how long "thawed" must hold
const thawTrace = new Map(); // tabId -> what the last thaw did, step by step
export const thawTraceOf = (tabId) => thawTrace.get(tabId) ?? "";
const THAW_STEPS = [
  ["active", async (send) => { await send("Page.setWebLifecycleState", { state: "active" }); }],
  // Chrome ignores "active" for a page it does not think was set to "frozen" through this command: set it, then lift it.
  ["frozen, then active", async (send) => { await send("Page.setWebLifecycleState", { state: "frozen" }); await send("Page.setWebLifecycleState", { state: "active" }); }],
  ["Page.enable, then active", async (send) => { await send("Page.enable"); await send("Page.setWebLifecycleState", { state: "active" }); }],
];
// Watches `tab.frozen` after one try: thawed (and stayed so for settleMs), frozen again, or no change.
async function watchThaw(tabId) {
  const t0 = Date.now(); let thawedAt = null;
  for (let i = 0; i < thawWait.polls; i++) {
    let frozen; try { frozen = (await chrome.tabs.get(tabId)).frozen === true; } catch { return { gone: true, text: "the tab is gone" }; }
    const ms = Date.now() - t0;
    if (!frozen && thawedAt == null) thawedAt = ms;
    else if (frozen && thawedAt != null) return { ok: false, text: `thawed at ${thawedAt} ms, frozen again at ${ms} ms` };
    if (thawedAt != null && ms - thawedAt >= thawWait.settleMs) return { ok: true, text: `thawed at ${thawedAt} ms` };
    await new Promise((r) => setTimeout(r, thawWait.pollMs));
  }
  return thawedAt != null ? { ok: true, text: `thawed at ${thawedAt} ms` } : { ok: false, text: `still frozen after ${Date.now() - t0} ms` };
}
export const thawLinger = { ms: 20000 }; // how long the debugger stays on a thawed tab after its last call
const thawHold = new Map(); // tabId -> linger timer (null while a call is using the tab)
function holdThaw(tabId) { clearTimeout(thawHold.get(tabId)); thawHold.set(tabId, null); }
async function dropThaw(tabId) {
  clearTimeout(thawHold.get(tabId));
  thawHold.delete(tabId);
  if (!cdpHeld(tabId)) { try { await chrome.debugger.detach({ tabId }); } catch {} }
}
// The call is over: the debugger stays a little longer (the next call usually follows), then goes.
export function releaseThaw(tabId) {
  if (!thawHold.has(tabId)) return;
  clearTimeout(thawHold.get(tabId));
  thawHold.set(tabId, setTimeout(() => { dropThaw(tabId); }, thawLinger.ms));
}
export async function thawIfFrozen(tabId) {
  let tab; try { tab = await chrome.tabs.get(tabId); } catch { return "no-tab"; }
  thawTrace.delete(tabId);
  if (tab.frozen !== true) return "not-frozen";
  const trace = [];
  for (const [i, [name, run]] of THAW_STEPS.entries()) {
    try { await cdpWith(tabId, {}, async (send) => { holdThaw(tabId); await run(send); }); }
    catch (e) {
      trace.push(`${name}: ${e?.message ?? e}`);
      thawTrace.set(tabId, trace.join("; "));
      if (i === 0) { await dropThaw(tabId); return "failed"; }
      break; // a later try could not even run: the earlier ones are already in the trace
    }
    const w = await watchThaw(tabId);
    trace.push(`${name}: ${w.text}`);
    thawTrace.set(tabId, trace.join("; "));
    if (w.gone) return "no-tab";
    if (w.ok) return "thawed";
  }
  return "still-frozen";
}

// Run `fn(send)` with the debugger attached to the tab (attach is idempotent; the session is
// detached afterwards unless force mode / console capture / another in-flight call holds it).
// `send(method, params)` is chrome.debugger.sendCommand bound to the tab.
async function cdpWith(tabId, { hold = false } = {}, fn) {
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
    return await fn((method, params) => chrome.debugger.sendCommand({ tabId }, method, params));
  } finally {
    const n = (cdpInFlight.get(tabId) || 1) - 1;
    if (n <= 0) cdpInFlight.delete(tabId); else cdpInFlight.set(tabId, n);
    // Detach unless force mode / console capture / another in-flight call holds it.
    if (!cdpHeld(tabId)) { try { await chrome.debugger.detach({ tabId }); } catch {} }
  }
}

// ---------------------------------------------------------------------------
// Trusted input (CDP Input.*). xterm.js terminals (AWS CloudShell), Cloudscape / Material
// dropdowns and canvas or rich-text editors react only to events the BROWSER itself created
// (isTrusted): a scripted el.click() or an `input` event does nothing there. These calls need
// the same opt-in as CDP eval ('Allow CDP eval' on, read-only off; the gate sets `_trusted`),
// work on the page and — for typing and keys — inside cross-origin frames, and refuse while
// the page shows a frame of a site the origin filter excludes (focus and coordinates are
// browser-level, so they could otherwise end up in that frame).

const KEY_NAMES = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" }, tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 }, esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 }, delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " }, " ": { key: " ", code: "Space", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 }, arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }, arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 }, end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 }, pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  insert: { key: "Insert", code: "Insert", vk: 45 },
};

// A key name (Enter, Tab, Escape, Backspace, Delete, Space, Arrow*, Home/End, PageUp/PageDown,
// F1-F12, or one character) + modifiers (ctrl/alt/shift/meta) → the fields CDP's
// Input.dispatchKeyEvent wants. PURE (unit-tested). Returns null for an unknown key.
export function keyDescriptor(key, modifiers) {
  const mods = (Array.isArray(modifiers) ? modifiers : []).map((m) => String(m).toLowerCase());
  const bits = (mods.includes("alt") ? 1 : 0) | (mods.includes("ctrl") || mods.includes("control") ? 2 : 0)
    | (mods.includes("meta") || mods.includes("cmd") ? 4 : 0) | (mods.includes("shift") ? 8 : 0);
  const k = String(key ?? "");
  if (!k) return null;
  let d = KEY_NAMES[k.toLowerCase()] || KEY_NAMES[k];
  const f = /^f([1-9]|1[0-2])$/i.exec(k);
  if (!d && f) d = { key: `F${f[1]}`, code: `F${f[1]}`, vk: 111 + Number(f[1]) };
  if (!d && [...k].length === 1) {
    const up = k.toUpperCase();
    if (/[a-z]/i.test(k)) d = { key: k, code: `Key${up}`, vk: up.charCodeAt(0), text: k };
    else if (/[0-9]/.test(k)) d = { key: k, code: `Digit${k}`, vk: k.charCodeAt(0), text: k };
    else d = { key: k, code: "", vk: 0, text: k };
  }
  if (!d) return null;
  // Printable text only when no ctrl/alt/meta is held (Ctrl+C is a command, not the letter c).
  const text = d.text !== undefined && !(bits & 7) ? d.text : undefined;
  return { key: d.key, code: d.code, windowsVirtualKeyCode: d.vk, text, modifiers: bits };
}

async function pressKeyCdp(send, d, count = 1, between) {
  for (let i = 0; i < count; i++) {
    if (i > 0 && between) await between(); // a key (Enter) may have submitted the page: look again before the next one
    await send("Input.dispatchKeyEvent", { type: d.text !== undefined ? "keyDown" : "rawKeyDown", modifiers: d.modifiers, key: d.key, code: d.code, windowsVirtualKeyCode: d.windowsVirtualKeyCode, ...(d.text !== undefined ? { text: d.text, unmodifiedText: d.text } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: d.modifiers, key: d.key, code: d.code, windowsVirtualKeyCode: d.windowsVirtualKeyCode });
  }
}

// The browser's own view of the page, asked over the very CDP session that is about to send the
// input (the pre-attach checks above ran some milliseconds - an attach - earlier): the top frame
// must still pass the pin / origin filter, and NO frame of the page, visible or not, may belong
// to a filtered-out site (input goes to wherever the browser's focus is, including a 0x0 frame).
// Returns the top frame's loaderId so a multi-key press can notice a navigation between keys.
async function assertTreeAllowed(send, pin) {
  const state = await getConsentState();
  const root = (await send("Page.getFrameTree"))?.frameTree;
  const top = root?.frame;
  if (!top) throw err("SCRIPT_ERROR", "can't read the page's frame tree");
  const d = evaluateFrame(state, { pin, topHost: hostOf(top.securityOrigin), frameHost: hostOf(top.securityOrigin), frameUrlHost: hostOf(top.url), ancestorHosts: [] });
  if (!d.allow) throw err(d.code, d.message);
  const walk = (node, ancestors) => {
    for (const c of node.childFrames || []) {
      const h = hostOf(c.frame?.securityOrigin);
      const v = evaluateFrame(state, { pin: undefined, topHost: null, frameHost: h, frameUrlHost: hostOf(c.frame?.url), ancestorHosts: ancestors });
      if (!v.allow) throw err("ORIGIN_DENIED", "the page contains a frame of a site excluded by the origin filter; refusing trusted input");
      walk(c, [...ancestors, h]);
    }
  };
  walk(root, []);
  return top.loaderId;
}

// Judge + pin the target document and make sure nothing filtered is on screen.
async function prepareTrusted(args) {
  if (!args._trusted) throw err("CDP_NOT_PERMITTED", "trusted input drives the page through the browser's debugger: turn on 'Allow CDP eval' in the Tabduct popup (and turn read-only off)");
  const t = await injectionTarget(args);
  await assertCapturable(t.tabId, args._pin);
  return t;
}

// Injected: find the element (or take the one already focused), focus it, optionally select its
// content so the next insertText replaces it. Self-contained.
function focusElement(sel, clear) {
  let el;
  if (sel) {
    try { el = document.querySelector(sel); } catch (e) { return { __badselector: String((e && e.message) || e) }; }
    if (!el) return { __notfound: true };
  } else {
    el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return { __nofocus: true };
  }
  try { el.scrollIntoView?.({ block: "center", inline: "center" }); } catch {}
  try { el.focus?.({ preventScroll: true }); } catch {}
  const focused = document.activeElement === el || el.contains(document.activeElement);
  if (clear) {
    try {
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") el.select();
      else if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const g = getSelection(); g.removeAllRanges(); g.addRange(r); }
      else document.execCommand("selectAll");
    } catch {}
  }
  return { ok: true, focused, hasFocus: document.hasFocus(), tag: (el.tagName || "").toLowerCase() };
}

// Injected: does this document hold the keyboard focus right now?
function pageHasFocus() { return document.hasFocus(); }

// Injected: where is the element's centre, in the MAIN frame's viewport (what CDP wants)?
// Checks that nothing covers it, and walks same-process parent frames; a cross-origin frame
// can't be located from inside.
function locateElement(sel) {
  let el; try { el = document.querySelector(sel); } catch (e) { return { __badselector: String((e && e.message) || e) }; }
  if (!el) return { __notfound: true };
  try { el.scrollIntoView({ block: "center", inline: "center" }); } catch {}
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { __invisible: true };
  let x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  const ok = hit && (hit === el || el.contains(hit) || (hit.closest && hit.closest("label")?.control === el));
  if (!ok) return { __covered: hit && hit.tagName ? hit.tagName.toLowerCase() + (hit.id ? `#${hit.id}` : "") : "nothing" };
  let w = window;
  while (w !== w.top) {
    let fe = null; try { fe = w.frameElement; } catch {}
    if (!fe) return { __crossOrigin: true };
    const fr = fe.getBoundingClientRect(), cs = getComputedStyle(fe);
    x += fr.left + fe.clientLeft + (parseFloat(cs.paddingLeft) || 0);
    y += fr.top + fe.clientTop + (parseFloat(cs.paddingTop) || 0);
    w = w.parent;
    // The real click lands on whatever is topmost at this point of the OUTER page: an overlay on
    // an ancestor document (over the iframe) would take it, so check every level, not just the
    // innermost one.
    const above = w.document.elementFromPoint(x, y);
    if (above !== fe) return { __covered: above && above.tagName ? above.tagName.toLowerCase() + (above.id ? `#${above.id}` : "") : "nothing" };
  }
  return { ok: true, x, y, tag: el.tagName.toLowerCase() };
}

function focusProblem(r, args) {
  if (!r) return err("SCRIPT_ERROR", "no result frame (target unavailable?)");
  if (r.__badselector) return err("INVALID_ARGS", `invalid CSS selector: ${r.__badselector}`);
  if (r.__notfound) return err("SCRIPT_ERROR", `no element matches ${args.selector}`);
  if (r.__nofocus) return err("INVALID_ARGS", "no element has focus: pass a selector, or click the target first (click with trusted:true)");
  if (!r.focused) return err("INVALID_ARGS", `${args.selector} (<${r.tag}>) did not take focus: it is not focusable. Click it first (click with trusted:true), target the real input inside it (a terminal's helper textarea, e.g. .xterm-helper-textarea), or omit selector to type into whatever is focused`);
  return null;
}

// Input.* events go to the browser's focused frame, not to the frame the call named. When the
// agent names a child frame but no selector, the keys/text would land wherever the focus really
// is (another frame, judged by nobody): insist that the named frame is the one holding it.
function frameMustHoldFocus(args, r) {
  if (args.selector || !args.frameId || r.hasFocus) return;
  throw err("INVALID_ARGS", `frame ${args.frameId} does not hold the keyboard focus, so the input would go to another frame: pass a selector for an element inside it, or click into it first (click with trusted:true)`);
}

async function trustedType(args) {
  const t = await prepareTrusted(args);
  const clear = !!args.clear;
  const r = (await exec(t.target, { args: [args.selector || null, clear], func: focusElement }))?.[0]?.result;
  const bad = focusProblem(r, args);
  if (bad) throw bad;
  frameMustHoldFocus(args, r);
  await cdpWith(t.tabId, {}, async (send) => {
    await assertTreeAllowed(send, args._pin);
    if (args.text === "") { if (clear) await pressKeyCdp(send, keyDescriptor("Delete")); }
    else await send("Input.insertText", { text: args.text });
  });
  // `hasFocus` was read right after focus(): a frame in another process (CloudShell) or a window that
  // was only just brought forward reports it a moment later. Look again before telling the agent the page is asleep.
  let hasFocus = r.hasFocus;
  if (!hasFocus) {
    await new Promise((res) => setTimeout(res, 150));
    hasFocus = (await exec(t.target, { func: pageHasFocus }).catch(() => null))?.[0]?.result === true;
  }
  return { typed: true, trusted: true, selector: args.selector ?? null, ...(hasFocus ? {} : { warning: "the page did not report focus: its tab or window is in the background or minimized, so the input was sent but the page may not have handled it or redrawn yet. Show the tab (or turn on 'Wake the browser' in the Tabduct popup) and read the result again" }) };
}

async function trustedClick(args) {
  const t = await prepareTrusted(args);
  const r = (await exec(t.target, { args: [args.selector], func: locateElement }))?.[0]?.result;
  if (!r) throw err("SCRIPT_ERROR", "no result frame (target unavailable?)");
  if (r.__badselector) throw err("INVALID_ARGS", `invalid CSS selector: ${r.__badselector}`);
  if (r.__notfound) throw err("SCRIPT_ERROR", `no element matches ${args.selector}`);
  if (r.__invisible) throw err("INVALID_ARGS", `${args.selector} has no size on screen (hidden?)`);
  if (r.__covered) throw err("INVALID_ARGS", `${args.selector} is covered by <${r.__covered}> at its centre; a real click would hit that instead. Scroll/close the overlay first`);
  if (r.__crossOrigin) throw err("INVALID_ARGS", "can't work out where an element of a cross-origin frame is on screen. Focus it another way (click its container) and use type / press_key, which work inside cross-origin frames");
  await cdpWith(t.tabId, {}, async (send) => {
    await assertTreeAllowed(send, args._pin);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", buttons: 0, clickCount: 1 });
  });
  return { clicked: true, trusted: true, selector: args.selector, x: Math.round(r.x), y: Math.round(r.y) };
}

async function pressKey(args) {
  const d = keyDescriptor(args.key, args.modifiers);
  if (!d) throw err("INVALID_ARGS", `unknown key ${JSON.stringify(args.key)}: use Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12 or a single character (modifiers: ctrl, alt, shift, meta)`);
  // A trusted Ctrl/Cmd+V or Shift+Insert is the browser's own Paste command: it would hand the agent
  // whatever is on the USER's clipboard (a copied password, a 2FA code). Page scripts cannot do
  // that, so neither can this tool; text goes in through `type`.
  if ((d.code === "KeyV" && (d.modifiers & 6)) || (d.key === "Insert" && (d.modifiers & 8))) {
    throw err("INVALID_ARGS", "paste shortcuts are refused: they would read the user's clipboard. Use type with trusted:true to enter text");
  }
  const count = Math.min(Math.max(Math.trunc(Number(args.count)) || 1, 1), 100);
  const t = await prepareTrusted(args);
  // With a selector the element is focused first. Without one the keys go to whatever holds the
  // focus - and when a frameId was named, that has to be THAT frame (see frameMustHoldFocus).
  if (args.selector || args.frameId) {
    const r = (await exec(t.target, { args: [args.selector || null, false], func: focusElement }))?.[0]?.result;
    const bad = focusProblem(r, args);
    if (bad) throw bad;
    frameMustHoldFocus(args, r);
  }
  await cdpWith(t.tabId, {}, async (send) => {
    const loader = await assertTreeAllowed(send, args._pin);
    await pressKeyCdp(send, d, count, async () => {
      const now = (await send("Page.getFrameTree"))?.frameTree?.frame;
      if (!now || now.loaderId !== loader) throw err("ORIGIN_DRIFT", "the page navigated in the middle of the key presses; the rest were not sent");
    });
  });
  return { pressed: true, key: args.key, modifiers: args.modifiers ?? [], count };
}

// A tab is "held" attached if EITHER cdpEval force mode (cdpAttached) OR console
// capture (cdpConsoleTabs) still needs the debugger session. Used to gate detach
// so one CDP user never detaches another's session out from under it.
function cdpHeld(tabId) { return cdpAttached.has(tabId) || cdpConsoleTabs.has(tabId) || thawHold.has(tabId) || (cdpInFlight.get(tabId) || 0) > 0; }

// Detach one tab + forget it (tab close, consent revoke, ORIGIN_DRIFT, onDetach).
// Only actually detaches when no CDP user still holds the tab; always forgets it.
export async function detachCdpTab(tabId) {
  cdpAttached.delete(tabId);
  clearTimeout(thawHold.get(tabId)); thawHold.delete(tabId); thawTrace.delete(tabId);
  cdpConsoleTabs.delete(tabId);
  cdpLogs.delete(tabId);
  cdpContexts.delete(tabId);
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
  const ids = new Set([...cdpAttached, ...cdpConsoleTabs, ...thawHold.keys()]);
  for (const id of ids) { try { await chrome.debugger.detach({ tabId: id }); } catch {} }
  for (const t of thawHold.values()) clearTimeout(t);
  thawHold.clear();
  cdpAttached.clear();
  cdpConsoleTabs.clear();
  cdpLogs.clear();
  cdpContexts.clear();
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
          resourceType: params.type || prev?.resourceType || "Other", requestHeaders: req.headers || {}, docUrl: params.documentURL || prev?.docUrl,
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
    // Remember which origin each JS execution context belongs to (a context id is stable for the
    // life of its document): a console line carries only the id, and neither a call-frame URL nor
    // the page URL says where a line from an about:blank / data: / srcdoc frame came from.
    if (method === "Runtime.executionContextCreated") {
      const c = params?.context;
      if (c && typeof c.id === "number") {
        let m = cdpContexts.get(tabId); if (!m) cdpContexts.set(tabId, m = new Map());
        m.set(c.id, { origin: typeof c.origin === "string" ? c.origin : "", uniqueId: c.uniqueId, frameId: c.auxData?.frameId, isDefault: c.auxData?.isDefault === true });
        if (m.size > CTX_CAP) m.delete(m.keys().next().value);
      }
      return;
    }
    if (method === "Runtime.executionContextDestroyed") { cdpContexts.get(tabId)?.delete(params?.executionContextId); return; }
    if (method === "Runtime.executionContextsCleared") { cdpContexts.get(tabId)?.clear(); return; }
    const ctxOrigin = (id) => (typeof id === "number" ? cdpContexts.get(tabId)?.get(id)?.origin : undefined);
    let entry;
    if (method === "Runtime.consoleAPICalled") {
      const t = params.type; // log|warning|error|info|debug|…
      const level = t === "warning" ? "warn" : (t === "error" ? "error" : (t === "info" ? "info" : (t === "debug" ? "debug" : "log")));
      entry = { level, source: "console", ts: Date.now(), text: ((params.args || []).map(fmtCdpArg).join(" ")).slice(0, 1000), url: params.stackTrace?.callFrames?.[0]?.url, origin: ctxOrigin(params.executionContextId) };
    } else if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails;
      entry = { level: "error", source: "exception", ts: Date.now(), text: String(d?.exception?.description || d?.text || "uncaught exception").slice(0, 1000), url: d?.url || d?.stackTrace?.callFrames?.[0]?.url, origin: ctxOrigin(d?.executionContextId) };
    } else if (method === "Log.entryAdded") {
      const e = params.entry || {};
      entry = { level: e.level === "warning" ? "warn" : (e.level || "info"), source: e.source || "log", ts: Date.now(), text: String(e.text || "").slice(0, 1000), url: e.url };
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
    if (cdpUserCancelled.has(tabId)) return; // the user closed this tab's debugging banner
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
  cdpContexts.delete(tabId);
  cdpNet.delete(tabId);
}

// Stop capture on every tab (cdpConsole disabled / connection dropped).
export async function stopAllCdpConsole() {
  for (const tabId of [...cdpConsoleTabs]) await stopCdpConsole(tabId);
}
