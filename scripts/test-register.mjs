#!/usr/bin/env node
// Native-messaging registration, the parts that need no registry and write nothing: which manifest each browser gets,
// where it would go, and that the Chrome side did not change when Firefox was added.

import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestBody, manifestDir, windowsRegKey, geckoId, extensionId } from "../hosts/node/src/register.js";

let fails = 0;
const eq = (a, b, m) => { const p = JSON.stringify(a) === JSON.stringify(b); console.log(`${p ? "ok" : "FAIL"}: ${m}${p ? "" : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`); if (!p) fails++; };

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const patch = JSON.parse(readFileSync(join(REPO, "firefox", "manifest.patch.json"), "utf8"));

const ff = JSON.parse(manifestBody("firefox"));
eq([ff.name, ff.type, ff.allowed_extensions, ff.allowed_origins], ["com.tabduct.host", "stdio", [patch.set.browser_specific_settings.gecko.id], undefined], "Firefox: the manifest allows the add-on by id (allowed_extensions), not by origin");
const ch = JSON.parse(manifestBody("chrome"));
eq([ch.allowed_origins, ch.allowed_extensions], [[`chrome-extension://${extensionId()}/`], undefined], "Chrome: unchanged, allowed by origin");
eq(ff.path, ch.path, "both start the same launcher");
eq(geckoId(), patch.set.browser_specific_settings.gecko.id, "geckoId() reads the id the Firefox build carries (one source for both)");

eq([windowsRegKey("firefox"), windowsRegKey("chrome"), windowsRegKey("edge")], ["HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tabduct.host", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tabduct.host", "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tabduct.host"], "Windows registry keys: Firefox has its own, the Chrome family is as before");
eq([manifestDir("firefox", "linux", "/home/u").replace(/\\/g, "/").replace(/^[A-Z]:/, ""), manifestDir("firefox", "darwin", "/Users/u").replace(/\\/g, "/").replace(/^[A-Z]:/, ""), manifestDir("firefox", "win32", "/x")], ["/home/u/.mozilla/native-messaging-hosts", "/Users/u/Library/Application Support/Mozilla/NativeMessagingHosts", null], "manifest folders: ~/.mozilla/native-messaging-hosts (Linux), Application Support/Mozilla (macOS), none on Windows (registry)");
eq([manifestDir("chrome", "linux", "/home/u").replace(/\\/g, "/").replace(/^[A-Z]:/, ""), manifestDir("chrome", "win32", "/x")], ["/home/u/.config/google-chrome/NativeMessagingHosts", null], "the Chrome folders are as before");

console.log(fails ? `\nREGISTER TESTS FAILED (${fails})` : "\nREGISTER TESTS PASSED");
process.exit(fails ? 1 : 0);
