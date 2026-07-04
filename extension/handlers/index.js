// Tabduct extension — tool handlers.
//
// Each handler implements one tool from ../../protocol/tools.schema.json using
// chrome.tabs / chrome.scripting. Handlers are async and return a
// JSON-serializable result, or throw. To signal a specific wire error code,
// throw via err(CODE, message).

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
    // Runs in the page's MAIN world. Arbitrary-string eval is subject to the
    // PAGE's CSP; on strict-CSP sites it surfaces cleanly as CSP_BLOCKED. The
    // CSP-proof path (chrome.userScripts) is on the roadmap. (ISOLATED world was
    // removed: extension MV3 CSP forbids eval there, so it could never succeed.)
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [args.code, args.args ?? [], args._authHost ?? null],
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
    if (s !== undefined && s.length > CAP) return { result: s.slice(0, CAP), truncated: true, note: "result truncated to 8MB" };
    return { result: wrapped.value };
  },

  async screenshot(args) {
    const tabId = await resolveTabId(args);
    let tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      if (!args?.activate) {
        throw err("INVALID_ARGS", `tab ${tabId} is not active; captureVisibleTab only sees the active tab — pass activate:true or activate_tab first`);
      }
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      tab = await chrome.tabs.get(tabId);
    }
    const format = args?.format ?? "png";
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
    return { mimeType: format === "jpeg" ? "image/jpeg" : "image/png", dataUrl };
  },
};
