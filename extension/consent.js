// Tabduct extension — per-tab consent (Feature B).
//
// THE security boundary. Default-deny. Tiers: "none" | "tabs" | "all".
// Grants live in chrome.storage.session (die with the browser). The origin
// denylist lives in chrome.storage.local (persists; overrides even "all").
// v2 adds per-tab capabilities (read vs execute) and TTL expiry.
// See docs/DESIGN-consent-and-multibrowser.md and PROTOCOL.md §6/§6a.
//
// evaluate()/denyMatch()/visibleTabIds() are PURE (no chrome refs) and
// unit-tested (scripts/test-consent.mjs). All mutators are SERIALIZED so
// read-modify-write on chrome.storage is atomic (no lost-revoke races).

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
  click: "execute", type: "execute",
};

// Hostname only (drops port), lowercased by URL, trailing FQDN dot stripped —
// so "mail.google.com", "mail.google.com.", and "mail.google.com:8443" all
// normalize to the same value the denylist compares against.
export function hostOf(url) {
  try { const h = new URL(url).hostname; return h ? h.replace(/\.$/, "") : null; } catch { return null; }
}

// Normalize a user-entered deny rule to a bare hostname (or "*.host"), so
// pasting "https://mail.google.com/" or "MAIL.google.com." still works.
export function normalizeDenyRule(r) {
  r = String(r || "").trim().toLowerCase();
  if (!r) return null;
  const wild = r.startsWith("*.");
  let body = wild ? r.slice(2) : r;
  if (body.includes("/") || body.includes("://")) { try { body = new URL(body.includes("://") ? body : "http://" + body).hostname; } catch {} }
  body = body.replace(/:\d+$/, "").replace(/\.$/, "");
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

function driftsSticky(entry, host) {
  if (entry.mode === "anyOrigin") return false;
  if (entry.host == null) return host != null; // blank-tab grant drifts on any real origin
  return entry.host !== host;
}
function isExpired(entry, now) { return entry.expiresAt != null && now != null && now > entry.expiresAt; }

export function evaluate(state, { tool, tabId, host, now, needCap }) {
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
    if (state.tierExpiresAt != null && now != null && now > state.tierExpiresAt) return deny("NOT_SHARED", "share expired");
    if (originBlocked(state, host)) return deny("ORIGIN_DENIED", "destination not allowed by consent policy");
    if (writeBlocked) return capDeny();
    return { allow: true };
  }
  const entry = state.allow?.[String(tabId)];
  if (!entry) return deny("NOT_SHARED", "tab is not shared");
  if (isExpired(entry, now)) return { allow: false, code: "NOT_SHARED", message: "share expired", revoke: true };
  if (originBlocked(state, host)) return deny("ORIGIN_DENIED", "destination not allowed by consent policy");
  if (driftsSticky(entry, host)) return { allow: false, code: "ORIGIN_DRIFT", message: "tab navigated away from the shared origin; access revoked", revoke: true };
  if (writeBlocked) return capDeny();
  return { allow: true };
}

export function visibleTabIds(state, tabs, now) {
  if (state.tier === "all") {
    if (state.tierExpiresAt != null && now != null && now > state.tierExpiresAt) return [];
    return tabs.filter((t) => !originBlocked(state, hostOf(t.url)));
  }
  if (state.tier === "none") return [];
  return tabs.filter((t) => {
    const entry = state.allow?.[String(t.id)];
    if (!entry || isExpired(entry, now)) return false;
    const host = hostOf(t.url);
    if (originBlocked(state, host)) return false;
    if (driftsSticky(entry, host)) return false;
    return true;
  });
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
// Chrome-bound store — mutators serialized via `serial()`

const FULL_CAPS = ["read", "execute"];

let mux = Promise.resolve();
function serial(fn) { const r = mux.then(fn); mux = r.then(() => {}, () => {}); return r; }

export async function getState() {
  // Read both stores in one shot so a concurrent mutator can't yield a mixed snapshot.
  const [sess, loc] = await Promise.all([
    chrome.storage.session.get("consent"),
    chrome.storage.local.get(["denyOrigins", "shareReadOnly", "shareTtlMs", "originMode", "lockToDomain", "allowCdp", "cdpAlways", "cdpConsole"]),
  ]);
  const s = sess.consent ?? { tier: "none", allow: {} };
  const { denyOrigins = [], shareReadOnly = false, shareTtlMs = 0 } = loc;
  return {
    tier: s.tier ?? "none", allow: s.allow ?? {}, tierExpiresAt: s.tierExpiresAt ?? null,
    denyOrigins, readOnly: !!shareReadOnly, ttlMs: Number(shareTtlMs) || 0,
    originMode: loc.originMode === "allow" ? "allow" : "block", // "block" default → list is a denylist
    lockToDomain: loc.lockToDomain !== false, // default true: shared tabs can't navigate to other origins
    // CDP settings (PART 4) — all DEFAULT FALSE (storage.local, opt-in from the popup).
    // cdpConsole is only effective when allowCdp is true (ignored otherwise, same as cdpAlways).
    allowCdp: !!loc.allowCdp, cdpAlways: !!loc.cdpAlways, cdpConsole: !!loc.cdpConsole,
  };
}
async function saveConsent(next) {
  await chrome.storage.session.set({ consent: { tier: next.tier, allow: next.allow, tierExpiresAt: next.tierExpiresAt ?? null } });
}
function grant(tab, opts = {}) {
  return {
    host: hostOf(tab.url),
    mode: opts.lockToDomain === false ? "anyOrigin" : "stickyOrigin", // lockToDomain off → free to navigate anywhere
    caps: FULL_CAPS, // read-only is enforced globally in evaluate(), not per-entry
    expiresAt: opts.ttlMs ? Date.now() + opts.ttlMs : undefined,
    sharedAt: Date.now(),
  };
}

export function setTier(tier) {
  if (tier === "none") return revokeAll();
  return serial(async () => {
    const st = await getState();
    const tierExpiresAt = tier === "all" && st.ttlMs ? Date.now() + st.ttlMs : null;
    await saveConsent({ tier, allow: st.allow, tierExpiresAt });
    return getState();
  });
}
export function shareTab(tabId) {
  return serial(async () => {
    const tab = await chrome.tabs.get(tabId);
    const st = await getState();
    st.allow[String(tabId)] = grant(tab, { ttlMs: st.ttlMs, lockToDomain: st.lockToDomain });
    await saveConsent({ tier: st.tier === "all" ? "all" : "tabs", allow: st.allow, tierExpiresAt: st.tierExpiresAt });
    return getState();
  });
}
// Global share defaults (apply to every tab, not per-tab). Persisted in storage.local.
// Also carries the CDP opt-ins (allowCdp / cdpAlways / cdpConsole) — all DEFAULT FALSE.
export function setShareOptions({ readOnly, ttlMs, lockToDomain, noAutoShareOpened, allowCdp, cdpAlways, cdpConsole } = {}) {
  return serial(async () => {
    const patch = {};
    if (readOnly !== undefined) patch.shareReadOnly = !!readOnly;
    if (ttlMs !== undefined) patch.shareTtlMs = Number(ttlMs) || 0;
    if (lockToDomain !== undefined) patch.lockToDomain = !!lockToDomain;
    if (noAutoShareOpened !== undefined) patch.noAutoShareOpened = !!noAutoShareOpened;
    if (allowCdp !== undefined) patch.allowCdp = !!allowCdp;
    if (cdpAlways !== undefined) patch.cdpAlways = !!cdpAlways;
    if (cdpConsole !== undefined) patch.cdpConsole = !!cdpConsole;
    await chrome.storage.local.set(patch);
    return getState();
  });
}
export function unshareTab(tabId) {
  return serial(async () => { const st = await getState(); delete st.allow[String(tabId)]; await saveConsent({ tier: st.tier, allow: st.allow }); return getState(); });
}
export function revokeAll() {
  return serial(async () => { await saveConsent({ tier: "none", allow: {} }); return getState(); });
}
export function autoShareCreated(tab) {
  return serial(async () => {
    const st = await getState();
    if (st.tier !== "tabs") return;
    st.allow[String(tab.id)] = grant(tab, { ttlMs: st.ttlMs, lockToDomain: st.lockToDomain });
    await saveConsent({ tier: "tabs", allow: st.allow });
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
    const now = Date.now();
    // "Everything" tier with a global TTL: expire the whole share.
    if (st.tier === "all" && st.tierExpiresAt != null && now > st.tierExpiresAt) {
      await saveConsent({ tier: "none", allow: {}, tierExpiresAt: null });
      return true;
    }
    let changed = false;
    for (const [k, e] of Object.entries(st.allow)) if (e.expiresAt != null && now > e.expiresAt) { delete st.allow[k]; changed = true; }
    if (changed) await saveConsent({ tier: st.tier, allow: st.allow, tierExpiresAt: st.tierExpiresAt });
    return changed;
  });
}
