// Which browser runs the extension, and what it offers. One code base serves Chrome and the browsers built on it
// (Edge, Brave, Opera, Vivaldi) and Firefox; what only one of them has is asked here, at call time, never assumed.
//
//   debugger  Chrome has chrome.debugger (the DevTools protocol): trusted input, press_key, CDP eval, console and
//             network capture through CDP, thawing a frozen page. Firefox has no such API: those features are off.
//   tabGroups Chrome can name and colour a tab group (the "⚡" group). Firefox cannot: the group is not made.

export function isFirefox() {
  try { return chrome.runtime.getURL("").startsWith("moz-extension:"); } catch { return false; }
}
export const browserName = () => (isFirefox() ? "firefox" : "chromium");
export const browserTitle = () => (isFirefox() ? "Firefox" : "Chrome");
export const hasDebugger = () => typeof chrome.debugger?.attach === "function";
export const hasTabGroups = () => typeof chrome.tabGroups?.update === "function";

// The consent state as this browser can honour it: where there is no debugger the CDP options are off, whatever was stored
// (a profile synced from Chrome, or a stored value from an older build), so every later check sees one consistent picture.
export function withPlatform(state) {
  return hasDebugger() ? state : { ...state, allowCdp: false, cdpAlways: false, cdpConsole: false };
}
