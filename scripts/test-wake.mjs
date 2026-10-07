#!/usr/bin/env node
// Black-box tests of extension/wake.js against a mock chrome.windows / chrome.tabs / chrome.scripting.
// What this guards: a hidden window (minimized, covered, background tab) is brought forward for the
// call and put back afterwards; a window the user is working in is never touched; a burst of calls
// wakes once and restores once; a discarded tab is refused instead of being reloaded.

let fails = 0;
const eq = (a, b, m) => { const p = JSON.stringify(a) === JSON.stringify(b); console.log(`${p ? "ok" : "FAIL"}: ${m}${p ? "" : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`); if (!p) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mock browser: one window (id 9) with tabs 1 (active) and 2 ----------------------------
let WIN, TABS, HIDDEN, LOG;
const reset = (win, tabs, hidden = false) => { WIN = { id: 9, state: "normal", focused: false, ...win }; TABS = tabs; HIDDEN = hidden; LOG = []; };
const tab = (id, extra = {}) => ({ id, windowId: 9, active: false, discarded: false, ...extra });
globalThis.chrome = {
  tabs: {
    async get(id) { const t = TABS.find((x) => x.id === id); if (!t) throw new Error("No tab"); return { ...t }; },
    async query(q) { return TABS.filter((t) => (q.active === undefined || t.active === q.active) && (q.windowId === undefined || t.windowId === q.windowId)).map((t) => ({ ...t })); },
    async update(id, p) { LOG.push(`tab ${id} ${JSON.stringify(p)}`); if (p.active) { for (const t of TABS) t.active = t.id === id; WIN.focused ||= false; } return {}; },
  },
  windows: {
    async get(id) { if (id !== WIN.id) throw new Error("No window"); return { ...WIN }; },
    async update(id, p) {
      LOG.push(`win ${JSON.stringify(p)}`);
      if (p.focused) { WIN.focused = true; if (WIN.state === "minimized") WIN.state = "normal"; HIDDEN = false; }
      if (p.state) { WIN.state = p.state; if (p.state === "minimized") { WIN.focused = false; HIDDEN = true; } }
      return {};
    },
  },
  scripting: { async executeScript() { return [{ result: HIDDEN ? "hidden" : "visible" }]; } },
};
const W = await import("../extension/wake.js");
Object.assign(W.timing, { idleMs: 40, pollMs: 5, maxWaitMs: 100, settleMs: 5 });

// 1. minimized window: focused, used, then minimized again
reset({ state: "minimized" }, [tab(1, { active: true }), tab(2)], true);
let rec = await W.wake(1);
eq(LOG, ['win {"focused":true}'], "minimized window is focused (Chrome restores it), no tab switch needed");
eq(WIN.state, "normal", "...and is visible for the call");
W.release(rec);
await sleep(80);
eq(LOG.at(-1), 'win {"state":"minimized"}', "after the idle period the window is minimized again");

// 2. minimized window whose shared tab is in the background: tab activated, previous tab put back
reset({ state: "minimized" }, [tab(1, { active: true }), tab(2)], true);
rec = await W.wake(2);
eq(LOG, ['tab 2 {"active":true}', 'win {"focused":true}'], "the shared tab is made active, then the window focused");
W.release(rec);
await sleep(80);
eq(LOG.slice(2), ['tab 1 {"active":true}', 'win {"state":"minimized"}'], "restore: previous tab first, then minimize");

// 3. the user is in this window: nothing is touched, even for a background tab
reset({ focused: true }, [tab(1, { active: true }), tab(2)], false);
eq(await W.wake(2), null, "focused window: no wake");
eq(LOG, [], "focused window: no calls at all");

// 4. unfocused window, shared tab visible (next to what the user is doing): nothing is touched
reset({ focused: false }, [tab(1, { active: true })], false);
eq(await W.wake(1), null, "unfocused but visible: no wake");
eq(LOG, [], "unfocused but visible: no calls");

// 5. unfocused window covered by others: raised, left raised (not minimized before), previous tab untouched
reset({ focused: false }, [tab(1, { active: true })], true);
rec = await W.wake(1);
eq(LOG, ['win {"focused":true}'], "covered window is raised");
W.release(rec);
await sleep(80);
eq(LOG, ['win {"focused":true}'], "a window that was not minimized is not minimized afterwards");

// 6. unfocused window with the shared tab in the background: tab shown, previous one restored
reset({ focused: false }, [tab(1, { active: true }), tab(2)], true);
rec = await W.wake(2);
W.release(rec);
await sleep(80);
eq(LOG, ['tab 2 {"active":true}', 'win {"focused":true}', 'tab 1 {"active":true}'], "background tab: shown for the call, previous tab restored");

// 7. a burst of calls wakes once and restores once
reset({ state: "minimized" }, [tab(1, { active: true })], true);
const a = await W.wake(1);
const b = await W.wake(1);
eq(a === b, true, "second call during the burst shares the wake");
W.release(a);
await sleep(20);
W.release(b); // the second release restarts the idle timer
await sleep(20);
eq(LOG.filter((l) => l.includes("minimized")).length, 0, "no restore while a call is still using the window");
await sleep(60);
eq(LOG.filter((l) => l.includes("focused")).length, 1, "burst: window focused once");
eq(LOG.filter((l) => l.includes("minimized")).length, 1, "burst: window minimized once");

// 8. a call during the idle period cancels the pending restore
reset({ state: "minimized" }, [tab(1, { active: true })], true);
const c = await W.wake(1); W.release(c);
await sleep(15);
const d = await W.wake(1);
await sleep(60);
eq(LOG.filter((l) => l.includes("minimized")).length, 0, "restore is postponed while a new call holds the window");
W.release(d);
await sleep(80);
eq(LOG.filter((l) => l.includes("minimized")).length, 1, "...and happens after the last call");

// 9. discarded tab: refused with a clear message, nothing activated
reset({ state: "minimized" }, [tab(1, { active: true, discarded: true })], true);
let err = null; try { await W.wake(1); } catch (e) { err = e; }
eq([err?.code, /unloaded|memory/i.test(err?.message || ""), LOG.length], ["SCRIPT_ERROR", true, 0], "discarded tab: clear error, window and tab untouched");

// 10. window or tab gone / restore after the window closed: no throw
reset({ state: "minimized" }, [tab(1, { active: true })], true);
eq(await W.wake(77), null, "unknown tab: no wake");
rec = await W.wake(1); W.release(rec);
WIN.id = 123; // window closed meanwhile
await sleep(80);
eq(true, true, "restore of a closed window does not throw");

console.log(fails ? `\n${fails} FAILED` : "\nall wake tests passed");
process.exit(fails ? 1 : 0);
