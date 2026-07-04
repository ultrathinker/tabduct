// Tabduct — shared secrets + base dir (used by discovery + hub).
//
// ~/.tabduct/token holds { tAgent } — the STABLE bearer for the hub facade,
// created atomically (create-if-absent) so racing hub/host spawners agree.
// TABDUCT_DIR overrides the base dir (test isolation — never touch a real setup).

import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
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
const aclDone = new Set();
export function restrictWindowsAcl(dir) {
  if (process.platform !== "win32" || aclDone.has(dir)) return;
  aclDone.add(dir);
  try {
    const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : (process.env.USERNAME || "");
    if (user) execFileSync("icacls", [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`], { stdio: "ignore" });
  } catch {}
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
