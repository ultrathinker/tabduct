#!/usr/bin/env node
// Unit test for the PURE consent decision logic (no Chrome). Covers the
// security-critical cases from PROTOCOL.md §6a.

import { evaluate, denyMatch, originBlocked, visibleTabIds, hostOf, normalizeDenyRule } from "../extension/consent.js";

let fails = 0;
const eq = (a, b, m) => { const p = JSON.stringify(a) === JSON.stringify(b); console.log(`${p ? "ok" : "FAIL"}: ${m}${p ? "" : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`); if (!p) fails++; };
const code = (r) => (r.allow ? "ALLOW" : r.code);

const NONE = { tier: "none", allow: {}, denyOrigins: [] };
const ALL = { tier: "all", allow: {}, denyOrigins: ["*.bank.com", "mail.google.com"] };
const TABS = { tier: "tabs", allow: { "5": { host: "example.com", mode: "stickyOrigin" }, "7": { host: "a.com", mode: "anyOrigin" } }, denyOrigins: ["mail.google.com"] };

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
eq(evaluate(TABS, { tool: "get_page_content", tabId: 5, host: "evil.com" }).revoke, true, "tabs: drift flags revoke");
eq(code(evaluate(TABS, { tool: "get_page_content", tabId: 7, host: "elsewhere.com" })), "ALLOW", "tabs: anyOrigin tab allowed after nav");
eq(code(evaluate(TABS, { tool: "navigate", tabId: 999, host: "x.com" })), "NOT_SHARED", "tabs: unshared tab denied");
eq(code(evaluate(TABS, { tool: "close_tab", tabId: 5, host: "mail.google.com" })), "ORIGIN_DENIED", "tabs: denylist beats a shared tab");

// visibleTabIds (enumerate filtering — no leak)
const tabs = [{ id: 5, url: "https://example.com/" }, { id: 7, url: "https://elsewhere.com/" }, { id: 999, url: "https://secret.com/" }];
eq(visibleTabIds(NONE, tabs).map((t) => t.id), [], "none: nothing visible");
eq(visibleTabIds(TABS, tabs).map((t) => t.id).sort(), [5, 7], "tabs: only shared visible (5 sticky-ok, 7 anyOrigin)");
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

// anyOrigin grant (lockToDomain off → mode:"anyOrigin"): navigating to a different host stays allowed (no ORIGIN_DRIFT)
const ANYO = { tier: "tabs", allow: { "5": { host: "example.com", mode: "anyOrigin" } }, denyOrigins: [] };
eq(code(evaluate(ANYO, { tool: "get_page_content", tabId: 5, host: "elsewhere.com" })), "ALLOW", "anyOrigin: tab navigated to a different host still allowed");

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

console.log(fails ? `\nCONSENT TESTS FAILED (${fails})` : "\nCONSENT TESTS PASSED");
process.exit(fails ? 1 : 0);
