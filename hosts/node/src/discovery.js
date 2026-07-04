// Tabduct Node host — instance discovery (Feature A, Phase 1).
//
// Each running host writes its OWN file under ~/.tabduct/instances/<id>.json
// (per-instance files → no shared-file write race). Written on open, removed on
// clean shutdown. Entries carry `pid`; readAll() and a self-heal-on-write drop
// entries whose process is gone (survives SIGKILL/crash/power loss). Files are
// 0600 and the dir 0700 (they hold a live bearer token).

import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { baseDir, restrictWindowsAcl } from "./secrets.js";

export const DIR = resolve(baseDir(), "instances");

function entryPath(instanceId) {
  const safe = String(instanceId).replace(/[^a-zA-Z0-9._-]/g, "_");
  return resolve(DIR, `${safe}.json`);
}

// pid liveness: process.kill(pid,0) throws ESRCH if gone, EPERM if alive-but-not-ours.
function alive(pid) {
  if (!pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function reapDead() {
  try {
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith(".json")) continue;
      try { const e = JSON.parse(readFileSync(resolve(DIR, f), "utf8")); if (e.pid && !alive(e.pid)) rmSync(resolve(DIR, f), { force: true }); } catch {}
    }
  } catch {}
}

export function writeEntry(e) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  restrictWindowsAcl(DIR); // 0o700 is a no-op on Windows → set an explicit ACL
  reapDead(); // clean up any predecessor that was killed without a chance to remove itself
  const p = entryPath(e.instanceId), tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(e, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, p); // atomic publish — readers never see a partial file
}

export function removeEntry(instanceId) {
  try { rmSync(entryPath(instanceId), { force: true }); } catch {}
}

export function readAll() {
  try {
    return readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => { try { return JSON.parse(readFileSync(resolve(DIR, f), "utf8")); } catch { return null; } })
      .filter(Boolean)
      .filter((e) => alive(e.pid)); // never emit a dead host's endpoint
  } catch { return []; }
}
