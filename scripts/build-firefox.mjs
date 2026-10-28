#!/usr/bin/env node
// Builds the Firefox version of the extension from the one code base.
//
//   node scripts/build-firefox.mjs [--out <dir>] [--zip]
//
// extension/ is copied as it is and its manifest.json is patched with firefox/manifest.patch.json (what Firefox
// does differently: a module event page instead of a service worker, its own add-on id, no debugger /
// favicon permissions). Nothing in extension/ changes: Chrome keeps loading that folder.
//   --out  where to build (default dist/firefox). Files are overwritten, never deleted: a file left over from an earlier
//          build is only reported ("stale"), the person who owns the folder removes it.
//   --zip  also write dist/tabduct-firefox-<version>.xpi (a zip with manifest.json at its root) for installing in Firefox
//          Developer Edition / Nightly / ESR (about:addons -> Install Add-on From File, with xpinstall.signatures.required
//          off) or for uploading to addons.mozilla.org for signing.
// Test it without installing anything: about:debugging -> This Firefox -> Load Temporary Add-on -> dist/firefox/manifest.json.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- the manifest ---------------------------------------------------------------------------------------------
export function patchManifest(chrome, patch) {
  const m = JSON.parse(JSON.stringify(chrome));
  for (const k of patch.remove || []) delete m[k];
  if (patch.removePermissions) m.permissions = (m.permissions || []).filter((p) => !patch.removePermissions.includes(p));
  for (const [k, v] of Object.entries(patch.set || {})) m[k] = v;
  return m;
}

// ---- files ---------------------------------------------------------------------------------------------------
export function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

// ---- a minimal zip writer (deflate; names UTF-8) -------------------------------------------------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function zipFiles(entries) { // entries: [{ name, data: Buffer }]
  const local = [], central = []; let offset = 0;
  const d = new Date(2026, 0, 1); // a fixed timestamp keeps the build reproducible
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8"); const comp = deflateRawSync(data); const crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

// ---- the build ---------------------------------------------------------------------------------------------------
export function build({ repo = REPO, out, zip = false } = {}) {
  const src = join(repo, "extension");
  const patch = JSON.parse(readFileSync(join(repo, "firefox", "manifest.patch.json"), "utf8"));
  const manifest = patchManifest(JSON.parse(readFileSync(join(src, "manifest.json"), "utf8")), patch);
  out = resolve(out || join(repo, "dist", "firefox"));
  const files = listFiles(src).filter((f) => f !== "manifest.json" && f !== "key.pem");
  const entries = [{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") }];
  for (const f of files) entries.push({ name: f, data: readFileSync(join(src, f)) });
  for (const e of entries) { const p = join(out, e.name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, e.data); }
  const have = new Set(entries.map((e) => e.name));
  const stale = existsSync(out) ? listFiles(out).filter((f) => !have.has(f)) : [];
  let xpi = null;
  if (zip) { xpi = join(dirname(out), `tabduct-firefox-${manifest.version}.xpi`); writeFileSync(xpi, zipFiles(entries)); }
  return { out, manifest, files: entries.map((e) => e.name), stale, xpi };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  const r = build({ out: arg("--out"), zip: process.argv.includes("--zip") });
  console.log(`built Tabduct ${r.manifest.version} for Firefox: ${r.out} (${r.files.length} files)`);
  if (r.xpi) console.log(`xpi: ${r.xpi}`);
  if (r.stale.length) console.log(`note: not part of this build, left in place (remove them yourself if unwanted): ${r.stale.join(", ")}`);
}
