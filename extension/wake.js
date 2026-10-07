// Wake a sleeping shared tab so the tools that depend on rendering and focus can work.
//
// A minimized window, a window covered by others, or a background tab is "hidden" to Chrome: the page
// stops drawing (no animation frames, no repaint of a terminal or a dropdown), reports no focus, and
// cannot be screenshotted. Reading the DOM or sending input still works, but the page is stale, which
// is what an agent sees as "nothing happened". With the "Wake the browser" setting on (the default)
// the extension brings the window forward for the call and puts it back afterwards:
//   - a MINIMIZED window is focused (Chrome restores it), used, and minimized again after a short idle
//     period; Windows then hands the focus back to the app the user was in.
//   - a normal window that is not focused but hidden (covered by other windows, or the shared tab is
//     in the background) is raised and its tab activated; the previously active tab is put back.
//   - a window the user is working in (focused) is never touched: there the page is already visible.
// Chrome offers no way to render a hidden page, so raising the window is the only honest option; an
// extension also cannot lower a window or return focus to another application, which is why a
// minimized window is minimized again and a covered one is left on top.
// Never touches a discarded tab: activating it would reload the page and lose its state.

export const WAKE_TOOLS = new Set(["screenshot", "type", "click", "press_key", "get_page_content", "get_dom_snapshot"]);

// Timing is configurable so the tests do not have to wait.
export const timing = { idleMs: 2500, pollMs: 50, maxWaitMs: 800, settleMs: 150 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const awake = new Map(); // windowId -> { windowId, minimized, prevActive, busy, timer }

// Only the visibility is read from the page, nothing else; a page that cannot be probed counts as visible.
async function isHidden(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.visibilityState });
    return r?.result === "hidden";
  } catch { return false; }
}

async function untilVisible(tabId) {
  for (let waited = 0; waited < timing.maxWaitMs; waited += timing.pollMs) {
    if (!(await isHidden(tabId))) break;
    await sleep(timing.pollMs);
  }
  await sleep(timing.settleMs); // let the page flush what it had queued while it was hidden
}

// Returns a handle for release(), or null when nothing had to be done.
export async function wake(tabId) {
  let tab, win;
  try { tab = await chrome.tabs.get(tabId); win = await chrome.windows.get(tab.windowId); } catch { return null; }
  if (tab.discarded) {
    const e = new Error(`tab ${tabId} was unloaded by Chrome to save memory (Memory Saver); showing it would reload the page and lose its state - open the tab yourself first`);
    e.code = "SCRIPT_ERROR";
    throw e;
  }
  const held = awake.get(win.id);
  if (held) { // a burst of calls: one wake for all of them
    clearTimeout(held.timer);
    held.busy++;
    if (!tab.active) await chrome.tabs.update(tabId, { active: true });
    return held;
  }
  const minimized = win.state === "minimized";
  if (!minimized) {
    if (win.focused) return null; // the user is in this window: the page is visible
    if (tab.active && !(await isHidden(tabId))) return null; // visible next to what the user is doing
  }
  let prevActive = null;
  if (!tab.active) {
    try { prevActive = (await chrome.tabs.query({ active: true, windowId: win.id }))[0]?.id ?? null; } catch {}
    await chrome.tabs.update(tabId, { active: true });
  }
  await chrome.windows.update(win.id, { focused: true });
  await untilVisible(tabId);
  const rec = { windowId: win.id, minimized, prevActive, busy: 1, timer: null };
  awake.set(win.id, rec);
  return rec;
}

// Call when the tool call is over (also after a failure). The window goes back after an idle period.
export function release(rec) {
  if (!rec) return;
  rec.busy = Math.max(0, rec.busy - 1);
  if (rec.busy > 0) return;
  clearTimeout(rec.timer);
  rec.timer = setTimeout(() => restore(rec), timing.idleMs);
}

async function restore(rec) {
  if (rec.busy > 0 || awake.get(rec.windowId) !== rec) return;
  awake.delete(rec.windowId);
  try { if (rec.prevActive != null) await chrome.tabs.update(rec.prevActive, { active: true }); } catch {} // tab closed meanwhile
  try { if (rec.minimized) await chrome.windows.update(rec.windowId, { state: "minimized" }); } catch {} // window closed meanwhile
}
