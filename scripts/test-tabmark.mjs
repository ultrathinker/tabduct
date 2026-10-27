#!/usr/bin/env node
// The decision logic of the tab mark (extension/tabmark.js planMarks and helpers): pure, no browser.
import { planMarks, sameIcon, stripMark, normalizeMode, defaultMode, MARK_PREFIX, SETTLE_MS, REAPPLY_MAX, REAPPLY_WINDOW_MS } from "../extension/tabmark.js";

let fails = 0;
const eq = (a, b, m) => { const p = JSON.stringify(a) === JSON.stringify(b); console.log(`${p ? "ok" : "FAIL"}: ${m}${p ? "" : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`); if (!p) fails++; };

const T = (id, extra = {}) => ({ id, url: `https://s${id}.example/`, title: `t${id}`, favIconUrl: `https://s${id}.example/f.ico`, status: "complete", ...extra });
const NOW = 1_000_000;
const plan = (o) => planMarks({ mode: "icon", shared: new Set([1]), tabs: [T(1)], marks: {}, now: NOW, ...o });

// ---- helpers
eq([stripMark(MARK_PREFIX + "Inbox"), stripMark("Inbox"), stripMark(undefined)], ["Inbox", "Inbox", undefined], "stripMark takes the prefix off a title, and only the prefix");
eq([defaultMode(true), defaultMode(false), normalizeMode("title", true), normalizeMode("junk", false), normalizeMode(undefined, true)], ["off", "icon", "title", "icon", "off"], "the default is 'off' where a tab group exists (Chrome) and 'icon' where nothing else can show it (Firefox); junk falls back to the default");
const head = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAH"; // signature + a 32x32 RGBA header
const body = (n, c = "Q") => c.repeat(n);
eq([sameIcon(head + body(1600), head + body(1600)), sameIcon(head + body(1600, "R"), head + body(1650, "S")), sameIcon(head + body(1600), head + body(2400)), sameIcon("a", undefined)], [true, true, false, false], "sameIcon: the same PNG header and about the same length, even when the browser re-encoded the bytes after it; a much longer one, or junk, is not");
const otherHeader = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA"; // a 1x1 icon
eq(sameIcon(otherHeader + body(1600), head + body(1600)), false, "...and a PNG of another size is another icon");
const tail = body(80, "Z");

// ---- first marks
eq(plan({}), { remove: [], apply: [{ tabId: 1, how: "icon" }], seen: [] }, "a shared tab with no mark gets the icon mark");
eq(plan({ mode: "title" }).apply, [{ tabId: 1, how: "title" }], "...or the title mark in title mode");
eq(plan({ mode: "off" }), { remove: [], apply: [], seen: [] }, "mode off: nothing is marked");
for (const [what, extra] of [["a chrome:// page", { url: "chrome://settings" }], ["a discarded tab", { discarded: true }], ["a frozen tab", { frozen: true }], ["a tab still loading", { status: "loading" }], ["a file page", { url: "file:///x.html" }]]) {
  eq(plan({ tabs: [T(1, extra)] }).apply, [], `${what} is not marked (it cannot be scripted, or must not be woken)`);
}

// ---- keeping the mark
const markIcon = (o = {}) => ({ mode: "icon", dataUrl: "data:image/png;base64,MARK" + tail, at: NOW - 10_000, since: NOW - 10_000, tries: 0, intact: true, ...o });
eq(plan({ marks: { 1: markIcon() }, tabs: [T(1, { favIconUrl: "data:image/png;base64,MARK" + tail })] }), { remove: [], apply: [], seen: [1] }, "a mark that shows is left alone and reported as seen");
eq(plan({ marks: { 1: markIcon({ at: NOW - 500 }) } }).apply, [], "a mark put on half a second ago is not judged yet");
eq(plan({ marks: { 1: markIcon({ at: NOW - SETTLE_MS - 1, intact: false }) } }).apply, [{ tabId: 1, how: "title", fallback: true }], "an icon the page never showed (a strict policy) falls back to the title mark");
eq(plan({ marks: { 1: markIcon({ at: NOW - SETTLE_MS - 1, intact: true }) } }).apply, [{ tabId: 1, how: "icon" }], "an icon that showed and was undone (the page rewrote it) is put on again");
eq(plan({ marks: { 1: markIcon({ tries: REAPPLY_MAX, since: NOW - 1000 }) } }).apply, [], "a page that keeps undoing it is left alone after a few tries");
eq(plan({ marks: { 1: markIcon({ tries: REAPPLY_MAX, since: NOW - REAPPLY_WINDOW_MS - 1 }) } }).apply, [{ tabId: 1, how: "icon" }], "...for a while: the count starts again after the window");
const markTitle = (o = {}) => ({ mode: "title", at: NOW - 10_000, since: NOW - 10_000, tries: 0, intact: true, ...o });
eq(plan({ mode: "title", marks: { 1: markTitle() }, tabs: [T(1, { title: MARK_PREFIX + "t1" })] }).seen, [1], "title mode: a title that starts with the mark is intact");
eq(plan({ mode: "title", marks: { 1: markTitle() } }).apply, [{ tabId: 1, how: "title" }], "...and is marked again when the page rewrote it");
eq(plan({ mode: "icon", marks: { 1: markTitle({ fellBack: true }) }, tabs: [T(1, { title: MARK_PREFIX + "t1" })] }).remove, [], "a mark that fell back to the title stays while the setting says icon (it is not removed and redone every time)");

// ---- taking marks off
eq(plan({ shared: new Set(), marks: { 1: markIcon() } }).remove, [1], "unshared: the mark comes off");
eq(plan({ mode: "off", marks: { 1: markIcon() } }).remove, [1], "mode off: every mark comes off");
eq(plan({ tabs: [], marks: { 1: markIcon() } }).remove, [1], "the tab is gone: the entry is forgotten");
eq(plan({ mode: "title", marks: { 1: markIcon() } }), { remove: [1], apply: [{ tabId: 1, how: "title" }], seen: [] }, "another mode chosen: the old mark comes off, the new one goes on");
eq(plan({ shared: new Set([1, 2]), tabs: [T(1), T(2, { favIconUrl: "data:image/png;base64,MARK" + tail })], marks: { 2: markIcon() } }).apply, [{ tabId: 1, how: "icon" }], "several tabs: only the one without a mark is marked");

console.log(fails ? `\nTABMARK TESTS FAILED (${fails})` : "\nTABMARK TESTS PASSED");
process.exit(fails ? 1 : 0);
