// Tabduct — shared secrets + base dir (used by discovery + hub).
//
// ~/.tabduct/token holds { tAgent } — the STABLE bearer for the hub facade,
// created atomically (create-if-absent) so racing hub/host spawners agree.
// TABDUCT_DIR overrides the base dir (test isolation — never touch a real setup).

import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export function baseDir() { return process.env.TABDUCT_DIR || resolve(homedir(), ".tabduct"); }
const tokenFile = () => resolve(baseDir(), "token");

// POSIX mode is a no-op on Windows → set an explicit ACL (current user only).
// Idempotent PER PATH: icacls itself is idempotent, so we don't short-circuit
// globally — that previously let a second dir (e.g. the instances dir) keep
// default perms because the module-global flag tripped after the first call.
//
// Defensive: `/inheritance:r` strips all inherited ACEs. If the resulting ACL
// would lock our own process out (e.g. DOMAIN\user string didn't match the
// actual owner identity used by the kernel), we wouldn't even notice — the
// failure would surface only much later as a write/read failure inside
// ensureSecrets/writeEntry. So after restricting we PROBE create+read+delete
// in the dir; on failure we restore inherited (user-private, profile-scoped)
// ACLs and warn loudly rather than brick the running host's state dir.
const aclDone = new Set();
function probeWritable(dir) {
  const p = resolve(dir, `.tabduct-acl-probe-${randomUUID()}.tmp`);
  try {
    writeFileSync(p, "ok", { mode: 0o600 });
    if (readFileSync(p, "utf8") !== "ok") throw new Error("readback mismatch");
    rmSync(p, { force: true });
    return true;
  } catch {
    try { rmSync(p, { force: true }); } catch {}
    return false;
  }
}
export function restrictWindowsAcl(dir) {
  if (process.platform !== "win32" || aclDone.has(dir)) return;
  aclDone.add(dir);
  try {
    const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : (process.env.USERNAME || "");
    if (!user) return;
    execFileSync("icacls", [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`], { stdio: "ignore" });
    // Confirm we didn't just lock ourselves out.
    if (!probeWritable(dir)) {
      process.stderr.write(`[tabduct] ACL restriction on ${dir} made the dir unwritable for the current process; restoring inherited (user-private) ACLs\n`);
      // Restore inherited ACEs from the parent. This is still user-private: the
      // profile root (~) is ACL'd to the current user only on a normal Windows
      // install, so inheritance is the safe fallback, not a regression.
      try { execFileSync("icacls", [dir, "/reset"], { stdio: "ignore" }); } catch {}
    }
  } catch (e) {
    process.stderr.write(`[tabduct] icacls restriction failed on ${dir} (leaving inherited ACLs in place): ${e.message}\n`);
  }
}

/** Atomic create-if-absent. Returns { tAgent }. Both hub and host may call it. */
export function ensureSecrets() {
  const dir = baseDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictWindowsAcl(dir);
  const file = tokenFile();
  try {
    const fd = openSync(file, "wx", 0o600); // throws EEXIST if already there
    const secrets = { tAgent: randomUUID() + randomUUID().replace(/-/g, "") };
    writeFileSync(fd, JSON.stringify(secrets));
    closeSync(fd);
    return secrets;
  } catch (e) {
    if (e.code === "EEXIST") return JSON.parse(readFileSync(file, "utf8"));
    throw e;
  }
}

export function readSecrets() {
  try { return JSON.parse(readFileSync(tokenFile(), "utf8")); } catch { return null; }
}
