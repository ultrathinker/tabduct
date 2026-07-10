// Tabduct — shared secrets + base dir (used by discovery + hub).
//
// Two bearers, each in its OWN file, each created atomically (create-if-absent) so
// racing hub/host spawners converge on one value (no read-modify-write divergence):
//  - ~/.tabduct/token   → { tAgent }   — the STABLE bearer for the hub facade (disclosed to the agent).
//  - ~/.tabduct/control → { tControl } — a SEPARATE bearer for the hub's non-MCP /control
//    endpoint (popup-driven cross-instance status/unshare). NEVER disclosed to the agent,
//    so the agent (which only ever holds tAgent) cannot snapshot or unshare across
//    browsers — those stay a user-only action from the popup.
// (tControl lives in its own file rather than being added to `token` so a pre-tControl
// install needs no risky in-place migration.)
// TABDUCT_DIR overrides the base dir (test isolation — never touch a real setup).

import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export function baseDir() { return process.env.TABDUCT_DIR || resolve(homedir(), ".tabduct"); }
const tokenFile = () => resolve(baseDir(), "token");
const controlFile = () => resolve(baseDir(), "control");

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

const mintToken = () => randomUUID() + randomUUID().replace(/-/g, "");

// Atomic create-if-absent of a single-secret JSON file. First writer wins; racers hit
// EEXIST and read the winner's value, so everyone converges (no diverging mints).
function ensureSecretFile(file, key) {
  try {
    const fd = openSync(file, "wx", 0o600); // throws EEXIST if already there
    const obj = { [key]: mintToken() };
    writeFileSync(fd, JSON.stringify(obj));
    closeSync(fd);
    return obj[key];
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    return JSON.parse(readFileSync(file, "utf8"))[key];
  }
}

/** Atomic create-if-absent. Returns { tAgent, tControl }. Both hub and host may call it. */
export function ensureSecrets() {
  const dir = baseDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictWindowsAcl(dir);
  return { tAgent: ensureSecretFile(tokenFile(), "tAgent"), tControl: ensureSecretFile(controlFile(), "tControl") };
}

export function readSecrets() {
  try { return JSON.parse(readFileSync(tokenFile(), "utf8")); } catch { return null; }
}
