// A visible mark on a shared tab, in the browser's own tab strip.
//
// Chrome can put shared tabs into a named, coloured "⚡" tab group. Firefox cannot name or colour a group from an extension, and a tab has no
// other property the extension may set, so the page's own icon and title are what is left: the tab shows the site's icon with a green ring and
// dot ("icon"), or the title gets a "⚡ " in front ("title"). The extension toolbar icon (a green dot on the shared tab) needs none of this and
// the page cannot see it; these two change the page's <link rel=icon> / document.title, which the page CAN see. That is the price, and why the
// mode is a setting ("off" switches it all off).
//
//   icon   falls back to "title" on a page whose Content-Security-Policy refuses the new icon (Firefox applies img-src to a page's icons);
//   a page with no icon link of its own gets the title mark: once an icon is set, a browser keeps showing it until the page reloads (Firefox ignores
//   a removed or emptied link), so an icon mark on such a page could never be taken off;
//   a page that rewrites its icon or title again is marked again, at most a few times (a site that animates its icon is left alone);
//   Everything-mode shares every tab: none of them is marked; nothing is marked while the extension is not connected;
//   the page's own icon links and title are put back when the tab is unshared, the mode is changed, or the extension is stopped.
//   Marks are remembered in storage.local (tdMarks) so that a reloaded extension can still take its marks off.

export const MARK_PREFIX = "⚡ ";
export const MODES = ["icon", "title", "off"];
export const stripMark = (title) => (typeof title === "string" && title.startsWith(MARK_PREFIX) ? title.slice(MARK_PREFIX.length) : title);
// Chrome has its tab group; Firefox has nothing else to show, so there the icon mark is the default.
export const defaultMode = (hasTabGroups) => (hasTabGroups ? "off" : "icon");
export const normalizeMode = (v, hasTabGroups) => (MODES.includes(v) ? v : defaultMode(hasTabGroups));

export const SETTLE_MS = 2500; // how long a fresh mark gets before it counts as "not taken"
export const REAPPLY_MAX = 6;  // a page that undoes the mark this many times is left alone
export const REAPPLY_WINDOW_MS = 5 * 60 * 1000;

// Do two data URLs show the same picture? A browser may hand a data URL back RE-ENCODED (Firefox does: same picture, other bytes, a few percent longer),
// so compare what survives: a PNG data URL with the same header (signature, size, colour type) and about the same length.
const PNG_URL = "data:image/png;base64,";
export const sameIcon = (a, b) => typeof a === "string" && typeof b === "string" && a.startsWith(PNG_URL) && b.startsWith(PNG_URL)
  && a.slice(0, PNG_URL.length + 34) === b.slice(0, PNG_URL.length + 34) && Math.abs(a.length - b.length) <= b.length * 0.1;
const markable = (t) => !!t && /^https?:/i.test(t.url || "") && !t.discarded && !t.frozen && t.status !== "loading";
const intact = (m, t) => (m.mode === "icon" ? sameIcon(t.favIconUrl, m.dataUrl) : typeof t.title === "string" && t.title.startsWith(MARK_PREFIX));

// What to do now - PURE, unit-tested.
//   mode    "icon" | "title" | "off"      shared  Set of tab ids that are shared (tier "tabs", connected)
//   tabs    chrome.tabs.query({}) result    marks   { [tabId]: { mode, dataUrl?, at, tries, since, intact } } as remembered
// Returns { remove: [tabId...] (take the mark off; the entry is forgotten), apply: [{ tabId, how: "icon"|"title", fallback? }], seen: [tabId...] (the mark is showing) }.
export function planMarks({ mode, shared, tabs, marks, now }) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const remove = [], apply = [], seen = [];
  const want = new Set(mode === "off" ? [] : [...shared]);
  for (const k of Object.keys(marks)) {
    const id = Number(k);
    if (!want.has(id) || !byId.has(id)) remove.push(id);               // unshared, mode off, or the tab is gone
    else if (marks[k].mode !== mode && !marks[k].fellBack) remove.push(id); // another mode was chosen: take the old mark off first (it is applied again below)
  }
  for (const id of want) {
    const t = byId.get(id);
    if (!markable(t)) continue;
    const m = marks[String(id)];
    if (!m || remove.includes(id)) { apply.push({ tabId: id, how: mode }); continue; }
    if (intact(m, t)) { seen.push(id); continue; }
    if (now - m.at < SETTLE_MS) continue;                               // too soon to judge
    if (m.mode === "icon" && !m.intact) { apply.push({ tabId: id, how: "title", fallback: true }); continue; } // the page refused the icon: the title instead
    const since = now - (m.since ?? m.at) > REAPPLY_WINDOW_MS ? now : (m.since ?? m.at);
    const tries = since === now ? 0 : m.tries ?? 0;
    if (tries >= REAPPLY_MAX) continue;                                  // it keeps undoing the mark: leave it alone
    apply.push({ tabId: id, how: m.mode });
  }
  return { remove, apply, seen };
}

// ---- in the page (these run INSIDE the tab, so they must not refer to anything outside themselves) ------------------------------------------
function pageSetIcon(dataUrl) {
  const links = [...document.querySelectorAll('link[rel~="icon"]')];
  if (!links.length) return { none: true }; // nothing of the page's own to change back: not marked by icon
  const orig = links.map((l) => ({ href: l.getAttribute("href"), type: l.getAttribute("type"), sizes: l.getAttribute("sizes") }));
  for (const l of links) { l.removeAttribute("type"); l.removeAttribute("sizes"); l.setAttribute("href", dataUrl); }
  return { orig };
}
function pageRestoreIcon(state, dataUrl) {
  const links = [...document.querySelectorAll('link[rel~="icon"]')].filter((l) => l.getAttribute("href") === dataUrl);
  links.forEach((l, i) => {
    const o = state.orig[i] || state.orig[0]; if (!o) return;
    if (o.href === null) l.removeAttribute("href"); else l.setAttribute("href", o.href);
    if (o.type !== null) l.setAttribute("type", o.type);
    if (o.sizes !== null) l.setAttribute("sizes", o.sizes);
  });
  return links.length;
}
function pageSetTitle(prefix) { if (!document.title.startsWith(prefix)) document.title = prefix + document.title; return document.title; }
function pageUnsetTitle(prefix) { if (document.title.startsWith(prefix)) document.title = document.title.slice(prefix.length); return document.title; }

// ---- the icon: the site's own, with a green ring and dot ------------------------------------------------------------------------------------
async function composeIcon(origUrl) {
  const S = 32; const c = new OffscreenCanvas(S, S); const ctx = c.getContext("2d");
  let bmp = null;
  try { if (origUrl) { const r = await fetch(origUrl); bmp = await createImageBitmap(await r.blob()); } } catch { bmp = null; } // an SVG icon or an unreadable one: the plain globe below
  if (bmp) ctx.drawImage(bmp, 1, 1, S - 2, S - 2);
  else { ctx.fillStyle = "#9aa0a6"; ctx.beginPath(); ctx.arc(S / 2, S / 2, 12, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(S / 2, S / 2, 5, 12, 0, 0, Math.PI * 2); ctx.moveTo(4, S / 2); ctx.lineTo(S - 4, S / 2); ctx.stroke(); }
  ctx.lineWidth = 3; ctx.strokeStyle = "#1fa452"; ctx.beginPath(); ctx.roundRect(1.5, 1.5, S - 3, S - 3, 7); ctx.stroke(); // the ring
  ctx.beginPath(); ctx.arc(24, 24, 7, 0, Math.PI * 2); ctx.fillStyle = "#1fa452"; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = "#ffffff"; ctx.stroke(); // the dot
  const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
  let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return "data:image/png;base64," + btoa(bin);
}

// ---- doing it --------------------------------------------------------------------------------------------------------------------------------------
const within = (p, ms = 4000) => { p.catch?.(() => {}); return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]); };
const run = async (tabId, func, args) => (await within(chrome.scripting.executeScript({ target: { tabId }, func, args })))?.[0]?.result;

async function loadMarks() { return (await chrome.storage.local.get("tdMarks")).tdMarks ?? {}; }
async function saveMarks(m) { await chrome.storage.local.set({ tdMarks: m }); }

async function takeOff(tabId, m) {
  try {
    if (m.mode === "icon" && m.state) await run(tabId, pageRestoreIcon, [m.state, m.dataUrl]);
    if (m.mode === "title") await run(tabId, pageUnsetTitle, [MARK_PREFIX]);
  } catch { /* the tab is gone, frozen or navigated: its page is new anyway */ }
}

let queue = Promise.resolve(); let pending = false; let latest = null;
// Called by refreshBadges with what is shared right now. A burst of calls is one run that uses the NEWEST state (an unshare must not be
// lost behind a stale queued run). `recheck` runs again a little after a mark was put on, to see whether the page took it.
export function applyTabMarks(args) {
  latest = args;
  if (pending) return queue; pending = true;
  queue = queue.then(async () => {
    pending = false;
    const { mode, shared, tabs, tier, connected, recheck } = latest;
    const marks = await loadMarks();
    const eff = tier === "tabs" && connected ? mode : "off"; // Everything-mode marks nothing; nothing is marked while stopped
    const plan = planMarks({ mode: eff, shared: tier === "tabs" && connected ? shared : new Set(), tabs, marks, now: Date.now() });
    let dirty = false;
    for (const id of plan.seen) if (marks[id] && !marks[id].intact) { marks[id].intact = true; dirty = true; }
    for (const id of plan.remove) { const m = marks[id]; if (m) await takeOff(id, m); delete marks[id]; dirty = true; }
    for (const a of plan.apply) {
      const t = tabs.find((x) => x.id === a.tabId); const old = marks[a.tabId];
      try {
        if (old && a.fallback) await takeOff(a.tabId, old);           // the icon did not take: put its links back, then the title
        else if (old && old.mode === a.how && old.mode === "icon") await takeOff(a.tabId, old); // re-marking: restore first so the originals are the page's own
        const now = Date.now();
        const base = old && !a.fallback && old.mode === a.how ? { since: old.since ?? old.at, tries: (old.tries ?? 0) + 1 } : { since: now, tries: 0 };
        if (a.how === "icon") {
          const dataUrl = await composeIcon(t?.favIconUrl);
          const state = await run(a.tabId, pageSetIcon, [dataUrl]);
          if (state?.none) { await run(a.tabId, pageSetTitle, [MARK_PREFIX]); marks[a.tabId] = { mode: "title", at: now, intact: false, fellBack: true, ...base }; } // no icon link of its own: the title instead
          else marks[a.tabId] = { mode: "icon", dataUrl, state, at: now, intact: false, ...base };
        } else {
          await run(a.tabId, pageSetTitle, [MARK_PREFIX]);
          marks[a.tabId] = { mode: "title", at: now, intact: false, fellBack: !!a.fallback, ...base };
        }
        dirty = true;
      } catch { /* a page we may not script (a store page, a PDF viewer, a closed tab): not marked, not an error */ }
    }
    if (dirty) await saveMarks(marks);
    if (plan.apply.length && recheck) setTimeout(recheck, SETTLE_MS + 300);
  }).catch(() => {});
  return queue;
}
export const markedTabIds = async () => new Set(Object.keys(await loadMarks()).map(Number));
