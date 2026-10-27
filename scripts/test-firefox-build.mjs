#!/usr/bin/env node
// The Firefox build (scripts/build-firefox.mjs): the manifest is the Chrome one with exactly the patched differences,
// every file of extension/ arrives, and the .xpi is a valid zip with manifest.json at its root. No browser needed.
// (Loading the build into a real Firefox is scripts/e2e-firefox.mjs.)

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { build, listFiles, patchManifest, zipFiles } from "./build-firefox.mjs";

let fails = 0;
const eq = (a, b, m) => { const p = JSON.stringify(a) === JSON.stringify(b); console.log(`${p ? "ok" : "FAIL"}: ${m}${p ? "" : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`); if (!p) fails++; };

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromeMf = JSON.parse(readFileSync(join(REPO, "extension", "manifest.json"), "utf8"));
const patch = JSON.parse(readFileSync(join(REPO, "firefox", "manifest.patch.json"), "utf8"));

// ---- the pure patch ----
{
  const m = patchManifest({ key: "K", minimum_chrome_version: "116", permissions: ["tabs", "debugger", "storage", "favicon", "tabGroups"], background: { service_worker: "b.js" }, name: "X" }, patch);
  eq([m.key, m.minimum_chrome_version, m.permissions, m.background, m.name], [undefined, undefined, ["tabs", "storage"], { scripts: ["background.js"], type: "module" }, "X"], "patchManifest: drops the Chrome-only keys and permissions, sets the event page, keeps the rest");
  eq(/^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/.test(m.browser_specific_settings.gecko.id), true, "the add-on id is a GUID in braces (it never changes once published)");
}

// ---- the real build ----
const out = join(mkdtempSync(join(tmpdir(), "tabduct-ff-")), "firefox");
const r = build({ out, zip: true });
const mf = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
eq([mf.version, mf.manifest_version, mf.name], [chromeMf.version, 3, "Tabduct"], "the Firefox build has the Chrome version number and is MV3");
eq([mf.key, mf.minimum_chrome_version, mf.background.service_worker], [undefined, undefined, undefined], "no Chrome key, Chrome minimum version or service worker");
eq([mf.background.scripts, mf.background.type], [["background.js"], "module"], "a module event page");
eq(mf.permissions, chromeMf.permissions.filter((p) => !["debugger", "favicon", "tabGroups"].includes(p)), "permissions: the Chrome ones minus debugger, favicon and tabGroups (a permission added for Chrome reaches Firefox)");
eq([mf.host_permissions, mf.commands, mf.action, mf.icons], [chromeMf.host_permissions, chromeMf.commands, chromeMf.action, chromeMf.icons], "host permissions, shortcut, toolbar button and icons are the Chrome ones");
const srcFiles = listFiles(join(REPO, "extension")).filter((f) => f !== "manifest.json" && f !== "key.pem");
eq(srcFiles.filter((f) => !existsSync(join(out, f))), [], "every file of extension/ arrived");
eq(r.stale, [], "nothing stale in a fresh build folder");
const need = [mf.action.default_popup, ...Object.values(mf.icons), mf.background.scripts[0]];
eq(need.filter((f) => !existsSync(join(out, f))), [], "every file the manifest points at exists");
eq(readFileSync(join(out, "background.js"), "utf8") === readFileSync(join(REPO, "extension", "background.js"), "utf8"), true, "the code is the same bytes as extension/ (one code base, no fork)");

// ---- the .xpi ----
{
  const z = readFileSync(r.xpi);
  const eocd = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = z.readUInt16LE(eocd + 10); let p = z.readUInt32LE(eocd + 16);
  const names = [], data = {};
  for (let i = 0; i < n; i++) {
    const comp = z.readUInt32LE(p + 20), nameLen = z.readUInt16LE(p + 28), extraLen = z.readUInt16LE(p + 30), cmtLen = z.readUInt16LE(p + 32), off = z.readUInt32LE(p + 42);
    const name = z.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lNameLen = z.readUInt16LE(off + 26), lExtraLen = z.readUInt16LE(off + 28);
    const body = inflateRawSync(z.subarray(off + 30 + lNameLen + lExtraLen, off + 30 + lNameLen + lExtraLen + comp));
    names.push(name); data[name] = body;
    p += 46 + nameLen + extraLen + cmtLen;
  }
  eq([names.length, names[0]], [r.files.length, "manifest.json"], "the .xpi holds every file, manifest.json first (at its root)");
  eq(JSON.parse(data["manifest.json"]).browser_specific_settings.gecko.id, mf.browser_specific_settings.gecko.id, "...with the patched manifest");
  eq(data["background.js"].equals(readFileSync(join(out, "background.js"))), true, "...and the files inflate to the original bytes (crc and sizes are right)");
  eq(r.xpi.endsWith(`tabduct-firefox-${mf.version}.xpi`), true, "named after the version");
}

// ---- building again over an existing folder deletes nothing ----
{
  const again = build({ out });
  eq(again.stale, [], "a second build over the same folder overwrites in place");
}

console.log(fails ? `\nFIREFOX BUILD TESTS FAILED (${fails})` : "\nFIREFOX BUILD TESTS PASSED");
process.exit(fails ? 1 : 0);
