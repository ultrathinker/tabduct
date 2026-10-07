// Tabduct extension — per-tab consent (Feature B).
//
// THE security boundary. Default-deny. Tiers: "none" | "tabs" | "all".
// Grants live in chrome.storage.session (die with the browser) and are mirrored to
// chrome.storage.local so an extension Reload/update can restore them (see
// restoreGrants). The origin denylist lives in chrome.storage.local (persists;
// overrides even "all"). v2 adds per-tab capabilities (read vs execute) and TTL expiry.
// See docs/DESIGN-consent-and-multibrowser.md and PROTOCOL.md §6/§6a.
//
// evaluate()/evaluateFrame()/visibleTabIds()/restoreGrants() and the other pure
// helpers have NO chrome refs and are unit-tested (scripts/test-consent.mjs). All
// mutators are SERIALIZED so read-modify-write on chrome.storage is atomic (no
// lost-revoke races); scripts/test-store.mjs drives them against a mock `chrome`.

// ---------------------------------------------------------------------------
// Pure decision logic

export const ENUMERATE = new Set(["list_tabs", "get_active_tab"]);
export const CREATE = new Set(["open_tab"]);

// Least capability each tool needs. "read" tools don't mutate the page/tab.
export const REQUIRED_CAP = {
  get_page_content: "read", screenshot: "read",
  navigate: "execute", execute_script: "execute", close_tab: "execute", activate_tab: "execute", open_tab: "execute",
  // CSP-safe interaction/wait tools (PART 1) + console capture (PART 2):
  // waits/reads are "read" (no page mutation); click/type mutate → "execute".
  wait_for: "read", get_dom_snapshot: "read", get_console_logs: "read",
  // Network inspection (PART 7): pure reads of the CDP-captured request log.
  list_network_requests: "read", get_network_request: "read",
  click: "execute", type: "execute",
  list_frames: "read",
  press_key: "execute", // trusted keyboard input (CDP); also needs the CDP opt-in, see background.js gate
};

// Hostname only (drops port), lowercased by URL, trailing FQDN dot stripped —
// so "mail.google.com", "mail.google.com.", and "mail.google.com:8443" all
// normalize to the same value the denylist compares against. blob:/filesystem:
// URLs carry their origin inside the path ("blob:https://bank.com/<id>") and have
// no hostname of their own — resolve it, or a blocked site's blob document would
// look host-less and slip past the filter.
export function hostOf(url) {
  try {
    const u = new URL(url);
    let h = u.hostname;
    if (!h && (u.protocol === "blob:" || u.protocol === "filesystem:")) { try { h = new URL(u.pathname).hostname; } catch {} }
    return h ? h.replace(/\.$/, "") : null;
  } catch { return null; }
}

// Normalize a user-entered deny rule to a bare hostname (or "*.host"), so
// pasting "https://mail.google.com/" or "MAIL.google.com." still works.
export function normalizeDenyRule(r) {
  r = String(r || "").trim().toLowerCase();
  if (!r) return null;
  const wild = r.startsWith("*.");
  let body = wild ? r.slice(2) : r;
  // Always through the URL parser, exactly like hostOf() does for the hosts it compares against:
  // an internationalized rule (a domain in a non-Latin script) must become its punycode form or it would never match.
  try { body = new URL(body.includes("://") ? body : "http://" + body).hostname; } catch { return null; }
  body = body.replace(/\.$/, "");
  return body ? (wild ? "*." : "") + body : null;
}

export function denyMatch(denyOrigins, host) {
  if (!host) return false;
  return (denyOrigins || []).some((rule) => {
    if (rule.startsWith("*.")) { const base = rule.slice(2); return host === base || host.endsWith("." + base); }
    return host === rule;
  });
}

// Access decision over the single origin list, honoring MODE (block vs allow).
// Reuses denyMatch as the primitive. block mode: blocked iff host is on the
// list. allow mode: allowed ONLY if host matches the list; a null host
// (about:blank/unknown) is blocked so allow mode never becomes a wildcard.
export function originBlocked(state, host) {
  if (state.originMode === "allow") return host == null ? true : !denyMatch(state.denyOrigins, host);
  return denyMatch(state.denyOrigins, host);
}

const deny = (code, message) => ({ allow: false, code, message });

// lock-to-domain is a LIVE global setting (state.lockToDomain, default on): turning it
// off frees every already-shared tab at once, turning it on pins them again (see
// repinGrants). A grant only remembers the host it was shared on.
function driftsSticky(entry, host, state) {
  if (state?.lockToDomain === false) return false;
  if (entry.host == null) return host != null; // blank-tab grant drifts on any real origin
  return entry.host !== host;
}

// Expiry is LIVE too: the global TTL (state.ttlMs) is counted from the later of when the
// tab was shared and when the TTL setting last changed (state.ttlSetAt), so enabling or
// changing it covers tabs that are already shared without instantly expiring ones shared
// long ago. An explicit entry.expiresAt (legacy / tests) wins.
function ttlExpiry(sinceMs, state) {
  const ttl = Number(state?.ttlMs) || 0;
  if (ttl <= 0 || sinceMs == null) return null;
  return Math.max(sinceMs, state.ttlSetAt || 0) + ttl;
}
export function entryExpiresAt(entry, state) { return entry.expiresAt != null ? entry.expiresAt : ttlExpiry(entry.sharedAt, state); }
export function tierExpiresAtOf(state) { return state.tierExpiresAt != null ? state.tierExpiresAt : ttlExpiry(state.tierSetAt, state); }
function isExpired(entry, now, state) { const e = entryExpiresAt(entry, state); return e != null && now != null && now > e; }
function tierExpired(state, now) { const e = tierExpiresAtOf(state); return e != null && now != null && now > e; }

export function evaluate(state, { tool, tabId, host, now, needCap, destHost }) {
  // Denied replies use GENERIC messages — never echo an unshared/denylisted
  // tab's host back to the agent (that would be an info leak).
  // read-only is a GLOBAL setting (state.readOnly): write tools are blocked in
  // every tier, and applies live to already-shared tabs.
  const need = needCap || REQUIRED_CAP[tool] || "execute";
  const writeBlocked = state.readOnly && need !== "read";
  const capDeny = () => deny("CAP_NOT_GRANTED", `sharing is read-only; "${tool}" needs write access`);

  if (CREATE.has(tool)) {
    if (state.tier === "none") return deny("NOT_SHARED", "sharing is off");
    if (writeBlocked) return capDeny();
    return { allow: true };
  }
  // Authorization is checked BEFORE the denylist so that probing an unauthorized
  // tab never distinguishes "denylisted" from "not shared" — otherwise the reply
  // codes become an oracle for denylist membership / open-tab origins (brute-force
  // tabId with the token, even while sharing is off). Denylist still overrides for
  // authorized contexts (all-tier + shared tabs).
  if (state.tier === "none") return deny("NOT_SHARED", "sharing is off");
  if (state.tier === "all") {
    if (tierExpired(state, now)) return deny("NOT_SHARED", "share expired");
    if (originBlocked(state, host)) return deny("ORIGIN_DENIED", "destination not allowed by consent policy");
    if (writeBlocked) return capDeny();
    return { allow: true };
  }
  const entry = state.allow?.[String(tabId)];
  if (!entry) return deny("NOT_SHARED", "tab is not shared");
  if (isExpired(entry, now, state)) return { allow: false, code: "NOT_SHARED", message: "share expired", revoke: true };
  if (originBlocked(state, host)) return deny("ORIGIN_DENIED", "destination not allowed by consent policy");
  // A tab that wandered off its shared origin is PAUSED, not unshared: the call is refused
  // and the tab is hidden from list_tabs, but the grant stays, so access resumes by itself
  // when the tab is back on that origin (or the lock is switched off).
  if (driftsSticky(entry, host, state)) return deny("ORIGIN_DRIFT", "this tab is no longer on the origin it was shared on (lock-to-domain); it stays shared and works again when it returns there, or when the user turns the lock off in the Tabduct popup");
  // With the lock on, refuse a navigation that would leave the shared origin BEFORE it
  // happens — otherwise the agent cuts its own access with one call.
  // (A blank tab - host null - counts too: the navigation would drift it to a real origin and
  // pause it at once, so say so up front instead of letting the agent cut its own access.)
  if (destHost !== undefined && state.lockToDomain !== false && destHost !== entry.host) {
    return deny("ORIGIN_DENIED", "lock-to-domain is on: this navigation would leave the origin the tab was shared on. Ask the user to turn the lock off in the Tabduct popup, or use open_tab");
  }
  if (writeBlocked) return capDeny();
  return { allow: true };
}

// Frame decision — PURE, unit-tested. evaluate() authorizes the TAB; this decides
// whether one frame inside that already-authorized tab may be touched, from what
// the frame itself reports. Rules:
//  - when the tab is PINNED (lock-to-domain on: `pin` is the host it was authorized on,
//    possibly null for a blank tab), the tab's top-level page must still be that origin;
//    a frame seen through a drifted page is refused, never read. `pin: undefined` = no pin;
//  - the FRAME's origin must pass the origin filter — judged by its own origin, by the host
//    of its URL, and by every intermediate ancestor — so a blocked site embedded as an
//    iframe stays untouchable even when the frame is sandboxed (opaque origin) or nested
//    inside another blocked frame.
// lockToDomain governs where the TAB goes and is deliberately not applied to frames: an
// embedded form on the shared page is part of what the user shared. A frame with an
// opaque origin (sandboxed) has a null host: fine in block mode (unless its URL or an
// ancestor is blocked), refused in allow mode — the same rule as a null-host tab.
export function evaluateFrame(state, { pin, topHost, frameHost, frameUrlHost, ancestorHosts }) {
  if (pin !== undefined && topHost !== pin) return deny("ORIGIN_DRIFT", "tab navigated away from the authorized origin");
  const hosts = [frameHost];
  if (frameUrlHost) hosts.push(frameUrlHost);
  for (const a of ancestorHosts || []) hosts.push(a);
  if (hosts.some((h) => originBlocked(state, h))) return deny("ORIGIN_DENIED", "frame not allowed by consent policy");
  return { allow: true };
}

export function visibleTabIds(state, tabs, now) {
  if (state.tier === "all") {
    if (tierExpired(state, now)) return [];
    return tabs.filter((t) => !originBlocked(state, hostOf(t.url)));
  }
  if (state.tier === "none") return [];
  return tabs.filter((t) => {
    const entry = state.allow?.[String(t.id)];
    if (!entry || isExpired(entry, now, state)) return false;
    const host = hostOf(t.url);
    if (originBlocked(state, host)) return false;
    if (driftsSticky(entry, host, state)) return false;
    return true;
  });
}

// Tabs that hold a grant but are PAUSED because they left the shared origin, or sit on an origin
// the filter excludes (the grant comes back when they return): the popup lists them so a dormant
// grant is never invisible to the user - it is the user's own view, not the agent's.
export function pausedTabIds(state, tabs, now) {
  if (state.tier !== "tabs") return [];
  return tabs.filter((t) => {
    const entry = state.allow?.[String(t.id)];
    if (!entry || isExpired(entry, now, state)) return false;
    const host = hostOf(t.url);
    return originBlocked(state, host) || driftsSticky(entry, host, state);
  });
}

// One-click presets over the ordinary settings (the user sees the flags change; there is no
// second source of truth to evaluate). They never touch the origin list/mode or the frame rule.
//  full — "let the agent work freely on what I shared": lock off, read-only off, no auto-expire,
//         CDP eval on (trusted input needs it). Continuous console/network capture (which keeps the
//         browser's "being debugged" banner up) and "always use CDP" stay as they are.
//  safe — back to the safe side of what "full" opened up: lock on, all CDP options off. It does NOT
//         touch read-only or the expiry time: pressing a "safe" button must never switch a
//         restriction the user set off (read-only, a TTL) - those are changed individually.
export function presetOptions(name) {
  if (name === "full") return { lockToDomain: false, readOnly: false, ttlMs: 0, allowCdp: true };
  if (name === "safe") return { lockToDomain: true, allowCdp: false, cdpAlways: false, cdpConsole: false };
  return null;
}
// Does the current state match the "full" preset? (drives the header indicator)
export function isFullAccess(state) {
  return state.lockToDomain === false && !state.readOnly && !(Number(state.ttlMs) > 0) && state.allowCdp === true;
}

// CDP eval gating (PART 4) — PURE (no chrome refs), unit-tested.
// Decides whether execute_script may use the CDP engine, from the user's two
// global CDP settings + the requested engine. cdpAlways implies allowCdp (it is
// ignored when allowCdp is false). Force/engine=cdp requires BOTH allowCdp AND
// not read-only; otherwise the gate refuses CDP (CDP_NOT_PERMITTED) BEFORE the
// debugger is attached. Returns { permitted, engine } (engine = the effective
// engine to run: "auto" | "scripting" | "cdp").
export function cdpDecision(state, { engine } = {}) {
  const allowCdp = state.allowCdp === true;
  const cdpAlways = allowCdp && state.cdpAlways === true; // cdpAlways implies allowCdp
  const req = engine === "scripting" || engine === "cdp" ? engine : "auto";
  const effective = cdpAlways ? "cdp" : req;
  if (effective !== "cdp") return { permitted: true, engine: effective };
  if (!allowCdp || state.readOnly) return { permitted: false, engine: effective, code: "CDP_NOT_PERMITTED" };
  return { permitted: true, engine: "cdp" };
}

// ---------------------------------------------------------------------------
// Pure grant bookkeeping — unit-tested; the store below only adds storage I/O.

// Which grants have expired? → { tier: bool (the "Everything" share), ids: [tabId...] }.
export function expiredGrants(state, now) {
  const ids = [];
  for (const [k, e] of Object.entries(state.allow || {})) if (isExpired(e, now, state)) ids.push(k);
  return { tier: state.tier === "all" && tierExpired(state, now), ids };
}

// Re-pin every grant to the host its tab is on NOW (used when the user switches the lock
// ON: "lock" means "stay where the tab is now"). Grants whose tab no longer exists are
// dropped. tabs = chrome.tabs.query({}) result.
export function repinGrants(allow, tabs) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const out = {};
  for (const [k, e] of Object.entries(allow || {})) {
    const t = byId.get(Number(k));
    if (!t) continue;
    out[k] = { ...e, host: hostOf(t.url) };
  }
  return out;
}

// The lock is being switched OFF: paused tabs (grants whose tab left its shared site) come back to
// life on wherever they are now. That is wanted for a tab that moved within the same site
// (console.aws.amazon.com -> us-east-1.console.aws.amazon.com) but not for one the USER took
// elsewhere (a work page -> their webmail): those grants are released instead. `related` =
// same host or one a sub-domain of the other. Returns the new allow map (or null: nothing to drop).
export function releasePausedGrants(state, tabs, now) {
  const related = (a, b) => !!a && !!b && (a === b || a.endsWith("." + b) || b.endsWith("." + a));
  const allow = { ...(state.allow || {}) };
  let dropped = false;
  for (const t of pausedTabIds({ ...state, lockToDomain: true }, tabs, now)) {
    if (related(hostOf(t.url), allow[String(t.id)]?.host)) continue;
    delete allow[String(t.id)]; dropped = true;
  }
  return dropped ? allow : null;
}

// Chrome replaced a tab id with another (prerender / instant): carry the grant over.
// Returns the new allow map, or null when `fromId` held no grant.
export function moveGrant(allow, fromId, toId) {
  const k = String(fromId);
  if (!allow || !allow[k]) return null;
  const out = { ...allow };
  out[String(toId)] = out[k];
  delete out[k];
  return out;
}

// Restore grants after an extension Reload/update. A pure function of what we mirrored
// before the reload and what the browser looks like now. Tab ids are REUSED across browser
// sessions, so a grant is only restored for a tab that still exists AND is still on the
// host it was shared on (and still passes the filter and TTL); the mirror itself must be
// fresh (its heartbeat is refreshed every minute while the extension runs, so a reload
// finds it seconds old, while stale leftovers from an earlier session are ignored).
export const RESTORE_FRESH_MS = 5 * 60 * 1000;
export function restoreGrants(mirror, tabs, now, state) {
  if (!mirror || typeof mirror !== "object" || typeof mirror.aliveAt !== "number") return null;
  if (now - mirror.aliveAt > RESTORE_FRESH_MS) return null;
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const allow = {};
  for (const [k, e] of Object.entries(mirror.allow || {})) {
    if (!e || typeof e !== "object") continue;
    const t = byId.get(Number(k));
    if (!t) continue;
    const host = hostOf(t.url);
    if (host !== (e.host ?? null)) continue;
    if (originBlocked(state, host)) continue;
    if (isExpired(e, now, state)) continue;
    allow[k] = e;
  }
  let tier = mirror.tier === "tabs" || mirror.tier === "all" ? mirror.tier : "none";
  const tierSetAt = typeof mirror.tierSetAt === "number" ? mirror.tierSetAt : null;
  if (tier === "all" && tierExpired({ ...state, tierSetAt, tierExpiresAt: null }, now)) tier = "none";
  if (tier === "none") return { tier, allow: {}, tierSetAt: null };
  return { tier, allow, tierSetAt: tier === "all" ? tierSetAt : null };
}

// ---------------------------------------------------------------------------
// Chrome-bound store — mutators serialized via `serial()`

const FULL_CAPS = ["read", "execute"];

let mux = Promise.resolve();
function serial(fn) { const r = mux.then(fn); mux = r.then(() => {}, () => {}); return r; }

export async function getState() {
  // Read both stores in one shot so a concurrent mutator can't yield a mixed snapshot.
  const [sess, loc] = await Promise.all([
    chrome.storage.session.get("consent"),
    chrome.storage.local.get(["denyOrigins", "shareReadOnly", "shareTtlMs", "shareTtlSetAt", "originMode", "lockToDomain", "allowCdp", "cdpAlways", "cdpConsole"]),
  ]);
  const s = sess.consent ?? { tier: "none", allow: {} };
  const { shareReadOnly = false, shareTtlMs = 0 } = loc;
  // Rules saved by an older build may not be in the current normal form (IDN): normalize on read.
  const denyOrigins = [...new Set((Array.isArray(loc.denyOrigins) ? loc.denyOrigins : []).map(normalizeDenyRule).filter(Boolean))];
  return {
    tier: s.tier ?? "none", allow: s.allow ?? {}, tierSetAt: s.tierSetAt ?? null,
    denyOrigins, readOnly: !!shareReadOnly, ttlMs: Number(shareTtlMs) || 0, ttlSetAt: Number(loc.shareTtlSetAt) || 0,
    originMode: loc.originMode === "allow" ? "allow" : "block", // "block" default → list is a denylist
    lockToDomain: loc.lockToDomain !== false, // default true: shared tabs can't navigate to other origins
    // CDP settings (PART 4) — all DEFAULT FALSE (storage.local, opt-in from the popup).
    // cdpConsole is only effective when allowCdp is true (ignored otherwise, same as cdpAlways).
    allowCdp: !!loc.allowCdp, cdpAlways: !!loc.cdpAlways, cdpConsole: !!loc.cdpConsole,
  };
}
// Persist the WHOLE consent record. Mutators always pass the full state they read (never a
// hand-picked subset), so a field they don't touch — e.g. the "Everything" share's start
// time — can't be wiped by an unrelated mutation.
async function saveConsent(st) {
  const consent = { tier: st.tier, allow: st.allow, tierSetAt: st.tierSetAt ?? null };
  await chrome.storage.session.set({ consent });
  // Mirror to storage.local (survives an extension Reload, unlike storage.session); the
  // heartbeat (aliveAt) lets restoreGrants tell a reload from a stale leftover.
  await chrome.storage.local.set({ allowMirror: { ...consent, aliveAt: Date.now() } });
}
function grant(tab) {
  return {
    host: hostOf(tab.url),
    caps: FULL_CAPS, // read-only is enforced globally in evaluate(), not per-entry
    sharedAt: Date.now(), // TTL and lock-to-domain are applied LIVE from global settings
  };
}

export function setTier(tier) {
  if (tier === "none") return revokeAll();
  return serial(async () => {
    const st = await getState();
    await saveConsent({ tier, allow: st.allow, tierSetAt: tier === "all" ? Date.now() : null });
    return getState();
  });
}
export function shareTab(tabId) {
  return serial(async () => {
    const tab = await chrome.tabs.get(tabId);
    const st = await getState();
    st.allow[String(tabId)] = grant(tab);
    await saveConsent({ ...st, tier: st.tier === "all" ? "all" : "tabs" });
    return getState();
  });
}
// Global share defaults (apply to every tab, live — not per-tab). Persisted in storage.local.
// Also carries the CDP opt-ins (allowCdp / cdpAlways / cdpConsole) — all DEFAULT FALSE.
export function setShareOptions({ readOnly, ttlMs, lockToDomain, noAutoShareOpened, allowCdp, cdpAlways, cdpConsole, unshareOnGroupLeave } = {}) {
  return serial(async () => {
    const prev = await getState();
    const patch = {};
    if (readOnly !== undefined) patch.shareReadOnly = !!readOnly;
    if (ttlMs !== undefined) {
      const ttl = Number(ttlMs) || 0;
      patch.shareTtlMs = ttl;
      if (ttl !== prev.ttlMs) patch.shareTtlSetAt = Date.now(); // restart the clock of existing shares
    }
    if (lockToDomain !== undefined) patch.lockToDomain = !!lockToDomain;
    if (noAutoShareOpened !== undefined) patch.noAutoShareOpened = !!noAutoShareOpened;
    if (allowCdp !== undefined) patch.allowCdp = !!allowCdp;
    if (cdpAlways !== undefined) patch.cdpAlways = !!cdpAlways;
    if (cdpConsole !== undefined) patch.cdpConsole = !!cdpConsole;
    if (unshareOnGroupLeave !== undefined) patch.unshareOnGroupLeave = !!unshareOnGroupLeave;
    // Lock switched OFF: free the tabs paused on a related site, release those the user moved elsewhere.
    if (lockToDomain === false && prev.lockToDomain !== false && prev.tier === "tabs" && Object.keys(prev.allow).length) {
      const allow = releasePausedGrants(prev, await chrome.tabs.query({}), Date.now());
      if (allow) await saveConsent({ tier: prev.tier, allow, tierSetAt: prev.tierSetAt });
    }
    await chrome.storage.local.set(patch);
    // Lock switched ON: pin every already-shared tab to the host it is on right now.
    if (lockToDomain === true && prev.lockToDomain === false && Object.keys(prev.allow).length) {
      const st = await getState();
      await saveConsent({ ...st, allow: repinGrants(st.allow, await chrome.tabs.query({})) });
    }
    return getState();
  });
}
export function unshareTab(tabId) {
  return serial(async () => { const st = await getState(); delete st.allow[String(tabId)]; await saveConsent(st); return getState(); });
}
export function revokeAll() {
  return serial(async () => { await saveConsent({ tier: "none", allow: {}, tierSetAt: null }); return getState(); });
}
export function autoShareCreated(tab) {
  return serial(async () => {
    const st = await getState();
    if (st.tier !== "tabs") return;
    st.allow[String(tab.id)] = grant(tab);
    await saveConsent(st);
  });
}
export function setDenyOrigins(list) {
  return serial(async () => {
    const norm = [...new Set((list || []).map(normalizeDenyRule).filter(Boolean))];
    await chrome.storage.local.set({ denyOrigins: norm });
    return getState();
  });
}
// Sweep expired grants (called by a periodic alarm). Returns true if any were removed.
export function sweepExpired() {
  return serial(async () => {
    const st = await getState();
    const exp = expiredGrants(st, Date.now());
    // "Everything" tier with a global TTL: expire the whole share.
    if (exp.tier) { await saveConsent({ tier: "none", allow: {}, tierSetAt: null }); return true; }
    if (!exp.ids.length) return false;
    for (const k of exp.ids) delete st.allow[k];
    await saveConsent(st);
    return true;
  });
}

// chrome.tabs.onReplaced: carry the grant from the old tab id to the new one.
export function replaceTabId(removedId, addedId) {
  return serial(async () => {
    const st = await getState();
    const allow = moveGrant(st.allow, removedId, addedId);
    if (!allow) return false;
    await saveConsent({ ...st, allow });
    return true;
  });
}

// Extension Reload/update: bring the mirrored grants back (only when nothing is shared yet).
// Returns how many tab grants were restored (or 1 for a restored "Everything" share).
export function restoreFromMirror(tabs, now = Date.now()) {
  return serial(async () => {
    const st = await getState();
    if (st.tier !== "none" || Object.keys(st.allow).length) return 0; // something already shared — leave it alone
    const { allowMirror } = await chrome.storage.local.get("allowMirror");
    const r = restoreGrants(allowMirror, tabs, now, st);
    if (!r || (r.tier === "none")) return 0;
    await saveConsent(r);
    return r.tier === "all" ? 1 : Object.keys(r.allow).length;
  });
}
// Heartbeat: refreshed every minute by the alarm so a Reload finds a fresh mirror.
export function touchMirror() {
  return serial(async () => {
    const { allowMirror } = await chrome.storage.local.get("allowMirror");
    if (allowMirror) await chrome.storage.local.set({ allowMirror: { ...allowMirror, aliveAt: Date.now() } });
  });
}
// Browser restart: grants die with the session, and so must their mirror.
export function clearMirror() { return chrome.storage.local.remove("allowMirror"); }
// The browser has just started. Chrome delivers runtime.onInstalled("update") together with
// onStartup when an update is applied at start-up, in either order: an `update` that ran first
// would have restored last session's grants from a still-fresh mirror. Queued with the other
// mutators, this runs after such a restore and ends with nothing shared and no mirror (and
// before it, the restore finds no mirror).
export function browserStarted() {
  return serial(async () => {
    await chrome.storage.session.remove("consent");
    await chrome.storage.local.remove("allowMirror");
  });
}
