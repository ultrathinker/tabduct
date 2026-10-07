#!/usr/bin/env node
// Unit test for the PURE consent decision logic (no Chrome). Covers the
// security-critical cases from PROTOCOL.md §6a.

import { evaluate, denyMatch, originBlocked, visibleTabIds, pausedTabIds, hostOf, normalizeDenyRule, REQUIRED_CAP, cdpDecision, evaluateFrame, entryExpiresAt, tierExpiresAtOf, expiredGrants, repinGrants, moveGrant, restoreGrants, RESTORE_FRESH_MS } from "../extension/consent.js";

let fails = 0;
const eq = (a, b, m) => { const p = JSON.stringify(a) === JSON.stringify(b); console.log(`${p ? "ok" : "FAIL"}: ${m}${p ? "" : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`); if (!p) fails++; };
const code = (r) => (r.allow ? "ALLOW" : r.code);

const NONE = { tier: "none", allow: {}, denyOrigins: [] };
const ALL = { tier: "all", allow: {}, denyOrigins: ["*.bank.com", "mail.google.com"] };
const TABS = { tier: "tabs", allow: { "5": { host: "example.com" }, "7": { host: "a.com" } }, denyOrigins: ["mail.google.com"] };
const TABS_FREE = { ...TABS, lockToDomain: false }; // lock-to-domain switched off (live, global)

// hostOf
eq(hostOf("https://example.com/x?y"), "example.com", "hostOf parses host");
eq(hostOf("garbage"), null, "hostOf returns null on junk");

// denyMatch
eq(denyMatch(["*.bank.com"], "x.bank.com"), true, "wildcard matches subdomain");
eq(denyMatch(["*.bank.com"], "bank.com"), true, "wildcard matches apex");
eq(denyMatch(["*.bank.com"], "notbank.com"), false, "wildcard doesn't over-match");
eq(denyMatch(["mail.google.com"], "mail.google.com"), true, "exact host match");

// none tier
eq(code(evaluate(NONE, { tool: "navigate", tabId: 5, host: "example.com" })), "NOT_SHARED", "none: tab tool denied");
eq(code(evaluate(NONE, { tool: "open_tab" })), "NOT_SHARED", "none: open_tab denied (no foothold)");
// denylist must NOT be an oracle for unauthorized tabs (authorization is checked first)
eq(code(evaluate({ tier: "none", allow: {}, denyOrigins: ["mail.google.com"] }, { tool: "navigate", tabId: 5, host: "mail.google.com" })), "NOT_SHARED", "none: denylisted tab returns NOT_SHARED (no ORIGIN_DENIED leak)");
eq(code(evaluate({ tier: "tabs", allow: {}, denyOrigins: ["mail.google.com"] }, { tool: "navigate", tabId: 5, host: "mail.google.com" })), "NOT_SHARED", "tabs: unshared denylisted tab returns NOT_SHARED (no leak)");

// all tier + denylist override
eq(code(evaluate(ALL, { tool: "execute_script", tabId: 1, host: "anything.com" })), "ALLOW", "all: arbitrary tab allowed");
eq(code(evaluate(ALL, { tool: "execute_script", tabId: 2, host: "mail.google.com" })), "ORIGIN_DENIED", "all: denylist still blocks");
eq(code(evaluate(ALL, { tool: "execute_script", tabId: 3, host: "x.bank.com" })), "ORIGIN_DENIED", "all: wildcard denylist blocks");
eq(code(evaluate(ALL, { tool: "open_tab" })), "ALLOW", "all: open_tab allowed");

// tabs tier
eq(code(evaluate(TABS, { tool: "get_page_content", tabId: 5, host: "example.com" })), "ALLOW", "tabs: shared tab on its origin allowed");
eq(code(evaluate(TABS, { tool: "get_page_content", tabId: 5, host: "evil.com" })), "ORIGIN_DRIFT", "tabs: sticky drift blocked");
eq(evaluate(TABS, { tool: "get_page_content", tabId: 5, host: "evil.com" }).revoke, undefined, "tabs: drift PAUSES the grant, it does not revoke it");
eq(code(evaluate(TABS, { tool: "get_page_content", tabId: 5, host: "example.com" })), "ALLOW", "tabs: access resumes when the tab is back on the shared origin");
eq(code(evaluate(TABS, { tool: "get_page_content", tabId: 7, host: "elsewhere.com" })), "ORIGIN_DRIFT", "tabs: lock on (default) pins every grant");
eq(code(evaluate(TABS_FREE, { tool: "get_page_content", tabId: 7, host: "elsewhere.com" })), "ALLOW", "tabs: lock OFF frees already-shared tabs (live setting)");
eq(code(evaluate(TABS_FREE, { tool: "get_page_content", tabId: 5, host: "mail.google.com" })), "ORIGIN_DENIED", "tabs: denylist still beats a free tab");
eq(code(evaluate({ ...TABS_FREE, lockToDomain: true }, { tool: "get_page_content", tabId: 7, host: "elsewhere.com" })), "ORIGIN_DRIFT", "tabs: lock back ON pins again");
// lock-to-domain refuses a navigation that would cut the agent's own access, BEFORE it happens
eq(code(evaluate(TABS, { tool: "navigate", tabId: 5, host: "example.com", destHost: "other.com" })), "ORIGIN_DENIED", "tabs+lock: navigate off the shared origin refused up front");
eq(code(evaluate(TABS, { tool: "navigate", tabId: 5, host: "example.com", destHost: "example.com" })), "ALLOW", "tabs+lock: navigate within the shared origin allowed");
eq(code(evaluate(TABS_FREE, { tool: "navigate", tabId: 5, host: "example.com", destHost: "other.com" })), "ALLOW", "tabs, lock off: navigate anywhere (filter permitting)");
eq(code(evaluate(ALL, { tool: "navigate", tabId: 1, host: "a.com", destHost: "b.com" })), "ALLOW", "all: no pin, navigate allowed");
eq(code(evaluate(TABS, { tool: "navigate", tabId: 999, host: "x.com" })), "NOT_SHARED", "tabs: unshared tab denied");
eq(code(evaluate(TABS, { tool: "close_tab", tabId: 5, host: "mail.google.com" })), "ORIGIN_DENIED", "tabs: denylist beats a shared tab");

// visibleTabIds (enumerate filtering — no leak)
const tabs = [{ id: 5, url: "https://example.com/" }, { id: 7, url: "https://elsewhere.com/" }, { id: 999, url: "https://secret.com/" }];
eq(visibleTabIds(NONE, tabs).map((t) => t.id), [], "none: nothing visible");
eq(visibleTabIds(TABS, tabs).map((t) => t.id).sort(), [5], "tabs: only shared visible (5 on its origin; 7 drifted → hidden)");
eq(visibleTabIds(TABS_FREE, tabs).map((t) => t.id).sort(), [5, 7], "tabs, lock off: both shared tabs visible");
eq(pausedTabIds(TABS, tabs).map((t) => t.id), [7], "tabs: the drifted shared tab is listed as paused");
eq(pausedTabIds(TABS_FREE, tabs).map((t) => t.id), [], "tabs, lock off: nothing paused");
eq(visibleTabIds({ tier: "tabs", allow: { "5": { host: "example.com", mode: "stickyOrigin" } }, denyOrigins: [] }, [{ id: 5, url: "https://drifted.com/" }]).map((t) => t.id), [], "tabs: drifted sticky tab hidden from list");
eq(visibleTabIds(ALL, [{ id: 1, url: "https://mail.google.com/" }, { id: 2, url: "https://ok.com/" }]).map((t) => t.id), [2], "all: denylisted tab hidden");

// null-host (about:blank/data:) sticky grants must NOT become wildcards (HIGH-3 fix)
const TABSNULL = { tier: "tabs", allow: { "9": { host: null, mode: "stickyOrigin" } }, denyOrigins: [] };
eq(code(evaluate(TABSNULL, { tool: "execute_script", tabId: 9, host: null })), "ALLOW", "null-host grant ok while still blank");
eq(code(evaluate(TABSNULL, { tool: "execute_script", tabId: 9, host: "real.com" })), "ORIGIN_DRIFT", "null-host grant drifts on reaching a real origin");
eq(visibleTabIds(TABSNULL, [{ id: 9, url: "https://real.com/" }]).map((t) => t.id), [], "null-host tab hidden after navigating to a real origin");
eq(visibleTabIds(TABSNULL, [{ id: 9, url: "about:blank" }]).map((t) => t.id), [9], "null-host tab visible while blank");

// read-only is a GLOBAL toggle (state.readOnly) — applies across every tier
const RO = { tier: "tabs", readOnly: true, allow: { "3": { host: "x.com", mode: "stickyOrigin" } }, denyOrigins: [] };
eq(code(evaluate(RO, { tool: "get_page_content", tabId: 3, host: "x.com" })), "ALLOW", "read-only: read tool allowed");
eq(code(evaluate(RO, { tool: "screenshot", tabId: 3, host: "x.com" })), "ALLOW", "read-only: screenshot allowed");
eq(code(evaluate(RO, { tool: "execute_script", tabId: 3, host: "x.com" })), "CAP_NOT_GRANTED", "read-only: execute denied");
eq(code(evaluate(RO, { tool: "navigate", tabId: 3, host: "x.com" })), "CAP_NOT_GRANTED", "read-only: navigate denied");
// read-only enforced in "all" tier and for open_tab too
const ROALL = { tier: "all", readOnly: true, allow: {}, denyOrigins: [] };
eq(code(evaluate(ROALL, { tool: "get_page_content", tabId: 1, host: "x.com" })), "ALLOW", "read-only all: read allowed");
eq(code(evaluate(ROALL, { tool: "execute_script", tabId: 1, host: "x.com" })), "CAP_NOT_GRANTED", "read-only all: execute denied");
eq(code(evaluate(ROALL, { tool: "open_tab" })), "CAP_NOT_GRANTED", "read-only: open_tab denied");

// v2: TTL expiry
const EXP = { tier: "tabs", allow: { "4": { host: "x.com", mode: "stickyOrigin", caps: ["read", "execute"], expiresAt: 1000 } }, denyOrigins: [] };
eq(code(evaluate(EXP, { tool: "execute_script", tabId: 4, host: "x.com", now: 2000 })), "NOT_SHARED", "expired grant denied");
eq(evaluate(EXP, { tool: "execute_script", tabId: 4, host: "x.com", now: 2000 }).revoke, true, "expired grant flags revoke");
eq(code(evaluate(EXP, { tool: "execute_script", tabId: 4, host: "x.com", now: 500 })), "ALLOW", "not-yet-expired grant allowed");
eq(visibleTabIds(EXP, [{ id: 4, url: "https://x.com/" }], 2000).map((t) => t.id), [], "expired tab hidden from list");

// "all" tier with a global TTL (tierExpiresAt)
const ALLEXP = { tier: "all", allow: {}, denyOrigins: [], tierExpiresAt: 1000 };
eq(code(evaluate(ALLEXP, { tool: "execute_script", tabId: 1, host: "x.com", now: 500 })), "ALLOW", "all+ttl: allowed before expiry");
eq(code(evaluate(ALLEXP, { tool: "execute_script", tabId: 1, host: "x.com", now: 2000 })), "NOT_SHARED", "all+ttl: denied after expiry");
eq(visibleTabIds(ALLEXP, [{ id: 1, url: "https://x.com/" }], 2000).map((t) => t.id), [], "all+ttl: nothing visible after expiry");
eq(visibleTabIds(ALLEXP, [{ id: 1, url: "https://x.com/" }], 500).map((t) => t.id), [1], "all+ttl: visible before expiry");

// originBlocked: MODE (block default vs allow) over the single origin list
const OBLK = { denyOrigins: ["mail.google.com", "*.bank.com"], originMode: "block" };
eq(originBlocked(OBLK, "mail.google.com"), true, "originBlocked block: listed host blocked");
eq(originBlocked(OBLK, "x.bank.com"), true, "originBlocked block: wildcard listed host blocked");
eq(originBlocked(OBLK, "example.com"), false, "originBlocked block: unlisted host allowed");
eq(originBlocked(OBLK, null), false, "originBlocked block: null host not blocked");
const OALLOW = { denyOrigins: ["mail.google.com", "*.bank.com"], originMode: "allow" };
eq(originBlocked(OALLOW, "mail.google.com"), false, "originBlocked allow: listed host allowed");
eq(originBlocked(OALLOW, "x.bank.com"), false, "originBlocked allow: wildcard listed host allowed");
eq(originBlocked(OALLOW, "example.com"), true, "originBlocked allow: unlisted host blocked");
eq(originBlocked(OALLOW, null), true, "originBlocked allow: null host blocked");

// evaluate() in ALLOW mode: tier "all"
const ALLOW_ALL = { tier: "all", allow: {}, denyOrigins: ["example.com"], originMode: "allow" };
eq(code(evaluate(ALLOW_ALL, { tool: "execute_script", tabId: 1, host: "notlisted.com" })), "ORIGIN_DENIED", "allow all: host not on allow list denied");
eq(code(evaluate(ALLOW_ALL, { tool: "execute_script", tabId: 2, host: "example.com" })), "ALLOW", "allow all: host on allow list allowed");

// evaluate() in ALLOW mode: tier "tabs" — a SHARED tab whose host is NOT on the allow list
const ALLOW_TABS_OFF = { tier: "tabs", allow: { "5": { host: "drifted.com", mode: "stickyOrigin" } }, denyOrigins: ["example.com"], originMode: "allow" };
eq(code(evaluate(ALLOW_TABS_OFF, { tool: "get_page_content", tabId: 5, host: "drifted.com" })), "ORIGIN_DENIED", "allow tabs: shared host not on allow list denied");
const ALLOW_TABS_ON = { tier: "tabs", allow: { "5": { host: "example.com", mode: "stickyOrigin" } }, denyOrigins: ["example.com"], originMode: "allow" };
eq(code(evaluate(ALLOW_TABS_ON, { tool: "get_page_content", tabId: 5, host: "example.com" })), "ALLOW", "allow tabs: shared host on allow list allowed");

// visibleTabIds() in ALLOW mode: only allow-listed tabs visible
const ALLOW_VIS = { tier: "all", allow: {}, denyOrigins: ["ok.com"], originMode: "allow" };
eq(visibleTabIds(ALLOW_VIS, [{ id: 1, url: "https://ok.com/" }, { id: 2, url: "https://secret.com/" }]).map((t) => t.id), [1], "allow all: only allow-listed tab visible");

// lockToDomain off: navigating to a different host stays allowed (no ORIGIN_DRIFT)
const ANYO = { tier: "tabs", lockToDomain: false, allow: { "5": { host: "example.com" } }, denyOrigins: [] };
eq(code(evaluate(ANYO, { tool: "get_page_content", tabId: 5, host: "elsewhere.com" })), "ALLOW", "lock off: tab navigated to a different host still allowed");

// final: host normalization closes denylist bypasses (port + trailing FQDN dot)
eq(hostOf("https://mail.google.com./"), "mail.google.com", "hostOf strips trailing dot");
eq(hostOf("https://bank.com:8443/x"), "bank.com", "hostOf drops port");
eq(denyMatch(["*.bank.com"], hostOf("https://x.bank.com:8443/")), true, "port variant blocked by wildcard");
eq(denyMatch(["mail.google.com"], hostOf("https://mail.google.com./")), true, "trailing-dot variant blocked");
eq(normalizeDenyRule("https://Mail.Google.com/inbox"), "mail.google.com", "normalize rule: strip scheme/path + lowercase");
eq(normalizeDenyRule("*.BANK.com:8443"), "*.bank.com", "normalize rule: wildcard + strip port");

// final: needCap override (screenshot+activate needs execute on a read-only tab)
const ROSHOT = { tier: "tabs", readOnly: true, allow: { "8": { host: "x.com", mode: "stickyOrigin" } }, denyOrigins: [] };
eq(code(evaluate(ROSHOT, { tool: "screenshot", tabId: 8, host: "x.com" })), "ALLOW", "read-only: plain screenshot allowed");
eq(code(evaluate(ROSHOT, { tool: "screenshot", tabId: 8, host: "x.com", needCap: "execute" })), "CAP_NOT_GRANTED", "read-only: screenshot+activate denied");

// PART 1/2 tools: REQUIRED_CAP tiers — read tools allowed under read-only, execute tools denied.
eq(REQUIRED_CAP.click, "execute", "REQUIRED_CAP: click needs execute");
eq(REQUIRED_CAP.type, "execute", "REQUIRED_CAP: type needs execute");
eq(REQUIRED_CAP.wait_for, "read", "REQUIRED_CAP: wait_for needs read");
eq(REQUIRED_CAP.get_dom_snapshot, "read", "REQUIRED_CAP: get_dom_snapshot needs read");
eq(REQUIRED_CAP.get_console_logs, "read", "REQUIRED_CAP: get_console_logs needs read");
const ROTOOLS = { tier: "tabs", readOnly: true, allow: { "3": { host: "x.com", mode: "stickyOrigin" } }, denyOrigins: [] };
eq(code(evaluate(ROTOOLS, { tool: "wait_for", tabId: 3, host: "x.com" })), "ALLOW", "read-only: wait_for allowed");
eq(code(evaluate(ROTOOLS, { tool: "get_dom_snapshot", tabId: 3, host: "x.com" })), "ALLOW", "read-only: get_dom_snapshot allowed");
eq(code(evaluate(ROTOOLS, { tool: "get_console_logs", tabId: 3, host: "x.com" })), "ALLOW", "read-only: get_console_logs allowed");
eq(code(evaluate(ROTOOLS, { tool: "click", tabId: 3, host: "x.com" })), "CAP_NOT_GRANTED", "read-only: click denied");
eq(code(evaluate(ROTOOLS, { tool: "type", tabId: 3, host: "x.com" })), "CAP_NOT_GRANTED", "read-only: type denied");
// execute tools allowed when not read-only
const RWTOOLS = { tier: "tabs", allow: { "3": { host: "x.com", mode: "stickyOrigin" } }, denyOrigins: [] };
eq(code(evaluate(RWTOOLS, { tool: "click", tabId: 3, host: "x.com" })), "ALLOW", "read-write: click allowed");
eq(code(evaluate(RWTOOLS, { tool: "type", tabId: 3, host: "x.com" })), "ALLOW", "read-write: type allowed");

// PART 4: cdpDecision() — pure CDP gating (engine selection + permit rules).
// cdpAlways implies allowCdp; force/always CDP requires allowCdp AND not read-only.
eq(cdpDecision({ allowCdp: false }, { engine: "auto" }).engine, "auto", "cdp: auto when cdp off");
eq(cdpDecision({ allowCdp: false }, { engine: "cdp" }).permitted, false, "cdp: force-cdp refused when cdp off");
eq(cdpDecision({ allowCdp: false }, { engine: "cdp" }).code, "CDP_NOT_PERMITTED", "cdp: force-cdp → CDP_NOT_PERMITTED");
eq(cdpDecision({ allowCdp: true }, { engine: "cdp" }).permitted, true, "cdp: force-cdp allowed when cdp on");
eq(cdpDecision({ allowCdp: true }, { engine: "cdp" }).engine, "cdp", "cdp: force-cdp effective engine cdp");
eq(cdpDecision({ allowCdp: true, readOnly: true }, { engine: "cdp" }).permitted, false, "cdp: force-cdp refused under read-only");
eq(cdpDecision({ allowCdp: true, cdpAlways: true }, { engine: "auto" }).engine, "cdp", "cdp: cdpAlways overrides auto → cdp");
eq(cdpDecision({ allowCdp: true, cdpAlways: true }, { engine: "scripting" }).engine, "cdp", "cdp: cdpAlways overrides scripting → cdp");
eq(cdpDecision({ allowCdp: true, cdpAlways: true }, { engine: "auto" }).permitted, true, "cdp: cdpAlways permitted when cdp on");
// cdpAlways is IGNORED when allowCdp is false (never silently enable CDP)
eq(cdpDecision({ allowCdp: false, cdpAlways: true }, { engine: "auto" }).engine, "auto", "cdp: cdpAlways ignored when cdp off");
eq(cdpDecision({ allowCdp: false, cdpAlways: true }, { engine: "auto" }).permitted, true, "cdp: non-cdp auto still permitted when cdp off");
// scripting engine is always permitted (no CDP involved) regardless of settings
eq(cdpDecision({ allowCdp: false }, { engine: "scripting" }), { permitted: true, engine: "scripting" }, "cdp: scripting always permitted");
eq(cdpDecision({ allowCdp: false, readOnly: true }, { engine: "scripting" }).permitted, true, "cdp: scripting permitted under read-only (consent handles the cap)");
// unknown engine normalizes to auto
eq(cdpDecision({ allowCdp: false }, { engine: "weird" }).engine, "auto", "cdp: unknown engine → auto");
eq(cdpDecision({ allowCdp: false }, {}).engine, "auto", "cdp: missing engine → auto");

// Frames: evaluateFrame() — one frame inside an ALREADY-authorized tab.
// The page must still be the authorized origin; the frame's own origin must pass the
// origin filter; lockToDomain does not apply (an embedded form is part of the page).
const BLOCKF = { denyOrigins: ["*.bank.com"] };
const ALLOWF = { originMode: "allow", denyOrigins: ["shop.com", "*.hsforms.net"] };
eq(REQUIRED_CAP.list_frames, "read", "REQUIRED_CAP: list_frames needs read");
eq(code(evaluate(ROTOOLS, { tool: "list_frames", tabId: 3, host: "x.com" })), "ALLOW", "read-only: list_frames allowed");
eq(code(evaluateFrame(BLOCKF, { pin: "shop.com", topHost: "shop.com", frameHost: "js-eu1.hsforms.net" })), "ALLOW", "frame: cross-origin frame on the shared page allowed");
eq(code(evaluateFrame(BLOCKF, { pin: "shop.com", topHost: "shop.com", frameHost: "pay.bank.com" })), "ORIGIN_DENIED", "frame: blocked site embedded as iframe stays blocked");
eq(code(evaluateFrame(BLOCKF, { pin: "shop.com", topHost: "evil.com", frameHost: "js-eu1.hsforms.net" })), "ORIGIN_DRIFT", "frame: page drifted away → refused");
eq(code(evaluateFrame(BLOCKF, { pin: "shop.com", topHost: "evil.com", frameHost: "pay.bank.com" })), "ORIGIN_DRIFT", "frame: drift is checked before the filter");
eq(code(evaluateFrame(BLOCKF, { pin: "shop.com", topHost: "shop.com", frameHost: "shop.com" })), "ALLOW", "frame: the page itself (frame 0) allowed");
eq(code(evaluateFrame(BLOCKF, { pin: "shop.com", topHost: "shop.com", frameHost: null })), "ALLOW", "frame: opaque-origin frame allowed in block mode");
eq(code(evaluateFrame(ALLOWF, { pin: "shop.com", topHost: "shop.com", frameHost: "js-eu1.hsforms.net" })), "ALLOW", "frame: allow mode — listed frame site allowed");
eq(code(evaluateFrame(ALLOWF, { pin: "shop.com", topHost: "shop.com", frameHost: "ads.tracker.com" })), "ORIGIN_DENIED", "frame: allow mode — unlisted frame site denied");
eq(code(evaluateFrame(ALLOWF, { pin: "shop.com", topHost: "shop.com", frameHost: null })), "ORIGIN_DENIED", "frame: allow mode — opaque-origin frame denied (no wildcard)");
eq(code(evaluateFrame(BLOCKF, { topHost: "anything.com", frameHost: "x.com" })), "ALLOW", "frame: not pinned (lock off) → only the filter applies");
eq(code(evaluateFrame(BLOCKF, { pin: null, topHost: "anything.com", frameHost: "x.com" })), "ORIGIN_DRIFT", "frame: blank-page grant (pin null) drifts on a real origin");
eq(code(evaluateFrame(BLOCKF, { pin: null, topHost: null, frameHost: null })), "ALLOW", "frame: blank page still blank → allowed");
eq(evaluateFrame(BLOCKF, { pin: "shop.com", topHost: "shop.com", frameHost: "pay.bank.com" }).message?.includes("bank") ?? true, false, "frame: denial never echoes the frame host");

// blob:/filesystem: documents carry their origin in the path — a blocked site's blob must not look host-less
eq(hostOf("blob:https://bank.com/3f2a-uuid"), "bank.com", "hostOf: blob: resolves the embedded origin");
eq(hostOf("filesystem:https://Bank.com:8443/temporary/x"), "bank.com", "hostOf: filesystem: resolves the embedded origin");
eq(hostOf("blob:null/3f2a"), null, "hostOf: opaque-origin blob stays host-less");
eq(hostOf("about:blank"), null, "hostOf: about:blank is host-less");
eq(hostOf("data:text/html,hi"), null, "hostOf: data: is host-less");
eq(visibleTabIds(ALL, [{ id: 1, url: "blob:https://x.bank.com/abc" }, { id: 2, url: "blob:https://ok.com/abc" }]).map((t) => t.id), [2], "all: a blocked site's blob: tab is hidden");
eq(code(evaluate(ALL, { tool: "get_page_content", tabId: 1, host: hostOf("blob:https://x.bank.com/abc") })), "ORIGIN_DENIED", "all: a blocked site's blob: document is denied");

// OPUS-6: a sandboxed frame (opaque origin) and a frame nested in a blocked frame are still judged
eq(code(evaluateFrame(BLOCKF, { pin: "shop.com", topHost: "shop.com", frameHost: null, frameUrlHost: "pay.bank.com" })), "ORIGIN_DENIED", "frame: sandboxed frame is blocked by the host of its URL");
eq(code(evaluateFrame(BLOCKF, { pin: "shop.com", topHost: "shop.com", frameHost: null, frameUrlHost: null, ancestorHosts: ["pay.bank.com"] })), "ORIGIN_DENIED", "frame: a frame nested inside a blocked frame is blocked");
eq(code(evaluateFrame(BLOCKF, { pin: "shop.com", topHost: "shop.com", frameHost: "js.hsforms.net", frameUrlHost: "js.hsforms.net", ancestorHosts: ["ads.example.net"] })), "ALLOW", "frame: harmless nesting stays allowed");
eq(code(evaluateFrame(ALLOWF, { pin: "shop.com", topHost: "shop.com", frameHost: "js-eu1.hsforms.net", frameUrlHost: null, ancestorHosts: ["ads.tracker.com"] })), "ORIGIN_DENIED", "frame: allow mode — a frame inside a non-listed frame is denied");
eq(code(evaluateFrame(ALLOWF, { pin: "shop.com", topHost: "shop.com", frameHost: "shop.com", frameUrlHost: null })), "ALLOW", "frame: about:blank-style frame inheriting an allowed origin passes in allow mode");

// OPUS-2: TTL is LIVE — counted from the later of share time and the moment the setting changed
const TTLS = { tier: "tabs", ttlMs: 1000, ttlSetAt: 0, allow: { "4": { host: "x.com", sharedAt: 5000 } }, denyOrigins: [] };
eq(entryExpiresAt(TTLS.allow["4"], TTLS), 6000, "ttl: expiry = sharedAt + ttl");
eq(code(evaluate(TTLS, { tool: "execute_script", tabId: 4, host: "x.com", now: 5500 })), "ALLOW", "ttl: live — within ttl");
eq(code(evaluate(TTLS, { tool: "execute_script", tabId: 4, host: "x.com", now: 6500 })), "NOT_SHARED", "ttl: live — past ttl");
eq(code(evaluate({ ...TTLS, ttlMs: 0 }, { tool: "execute_script", tabId: 4, host: "x.com", now: 9e9 })), "ALLOW", "ttl: turning the setting off removes expiry from already-shared tabs");
eq(entryExpiresAt(TTLS.allow["4"], { ...TTLS, ttlSetAt: 8000 }), 9000, "ttl: changing the setting restarts the clock for existing shares (no instant expiry)");
eq(expiredGrants(TTLS, 6500), { tier: false, ids: ["4"] }, "expiredGrants: lists expired tab grants");
const TIERTTL = { tier: "all", ttlMs: 1000, ttlSetAt: 0, tierSetAt: 2000, allow: {}, denyOrigins: [] };
eq(tierExpiresAtOf(TIERTTL), 3000, "ttl: 'Everything' share expiry derived from tierSetAt");
eq(code(evaluate(TIERTTL, { tool: "execute_script", tabId: 1, host: "x.com", now: 3500 })), "NOT_SHARED", "ttl: 'Everything' share expires");
eq(expiredGrants(TIERTTL, 3500).tier, true, "expiredGrants: flags the expired 'Everything' share");

// B1 helper: switching the lock ON re-pins every grant to the host its tab is on now (and drops dead tabs)
eq(repinGrants({ "5": { host: "a.com", sharedAt: 1 }, "6": { host: "b.com" } }, [{ id: 5, url: "https://c.com/x" }]), { "5": { host: "c.com", sharedAt: 1 } }, "repinGrants: follows the tab's current host, drops closed tabs");

// B5: Chrome replaced a tab id
eq(moveGrant({ "10": { host: "a.com" }, "11": { host: "b.com" } }, 10, 24), { "11": { host: "b.com" }, "24": { host: "a.com" } }, "moveGrant: grant follows the new tab id");
eq(moveGrant({ "11": { host: "b.com" } }, 10, 24), null, "moveGrant: nothing to move for an unshared tab");

// B7: restore after an extension Reload — fresh mirror, tab still exists AND still on the shared host
const NOW = 1_000_000;
const MIRROR = { tier: "tabs", tierSetAt: null, aliveAt: NOW - 30_000, allow: { "5": { host: "a.com", sharedAt: NOW - 9000 }, "6": { host: "b.com", sharedAt: NOW - 9000 }, "7": { host: "c.com", sharedAt: NOW - 9000 } } };
const LIVE = [{ id: 5, url: "https://a.com/p" }, { id: 6, url: "https://other.com/" }];
eq(restoreGrants(MIRROR, LIVE, NOW, { denyOrigins: [] })?.allow, { "5": MIRROR.allow["5"] }, "restore: only tabs that exist AND are still on the shared host (ids are reused across sessions)");
eq(restoreGrants({ ...MIRROR, aliveAt: NOW - RESTORE_FRESH_MS - 1 }, LIVE, NOW, { denyOrigins: [] }), null, "restore: a stale mirror (earlier session) is ignored");
eq(restoreGrants(null, LIVE, NOW, { denyOrigins: [] }), null, "restore: no mirror → nothing");
eq(restoreGrants(MIRROR, LIVE, NOW, { denyOrigins: ["a.com"] })?.allow, {}, "restore: the origin filter still wins");
eq(restoreGrants(MIRROR, LIVE, NOW, { denyOrigins: [], ttlMs: 5000, ttlSetAt: 0 })?.allow, {}, "restore: expired grants (live TTL) are not restored");
eq(restoreGrants({ tier: "all", tierSetAt: NOW - 1000, aliveAt: NOW - 1000, allow: {} }, LIVE, NOW, { denyOrigins: [] }), { tier: "all", allow: {}, tierSetAt: NOW - 1000 }, "restore: the 'Everything' share comes back too");
eq(restoreGrants({ tier: "all", tierSetAt: NOW - 9000, aliveAt: NOW - 1000, allow: {} }, LIVE, NOW, { denyOrigins: [], ttlMs: 5000, ttlSetAt: 0 })?.tier, "none", "restore: an expired 'Everything' share is not resurrected");
eq(restoreGrants({ tier: "weird", aliveAt: NOW, allow: { "5": { host: "a.com" } } }, LIVE, NOW, { denyOrigins: [] })?.tier, "none", "restore: unknown tier → none, grants dropped");

console.log(fails ? `\nCONSENT TESTS FAILED (${fails})` : "\nCONSENT TESTS PASSED");
process.exit(fails ? 1 : 0);
