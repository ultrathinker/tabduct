// Tabduct Node host — native-messaging registration (PROTOCOL.md §9).
//
// Installs/removes the Chrome Native Messaging manifest (+ Windows registry key)
// and templates an ABSOLUTE node path into the launcher so Chrome's minimal-env
// spawn resolves the runtime. The extension id is computed from the manifest's
// `key` (no separate id file to drift).

import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { NATIVE_HOST_NAME } from "./constants.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const HOST_DIR = resolve(__dir, "..");
const REPO = resolve(__dir, "../../..");
const MANIFEST = resolve(REPO, "extension/manifest.json");

// Chrome id = sha256(SPKI DER) first 16 bytes, each nibble 0..f -> a..p.
export function extensionId() {
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (!m.key) throw new Error("extension/manifest.json has no `key` — run `node scripts/gen-key.js` first");
  const der = Buffer.from(m.key, "base64");
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

function launcherPath() {
  return resolve(HOST_DIR, process.platform === "win32" ? "run_host.bat" : "run_host.sh");
}

// Pin the current node so the Chrome-spawned launcher uses the same runtime.
function writeNodePath() {
  writeFileSync(resolve(HOST_DIR, "node_path.txt"), process.execPath, "utf8");
}

// Per-OS/browser manifest directory (Chrome family). Returns null on Windows (registry-based).
function manifestDir(browser) {
  const home = homedir();
  const chromeDirs = {
    darwin: { chrome: "Google/Chrome", chromium: "Chromium", edge: "Microsoft Edge", brave: "BraveSoftware/Brave-Browser" },
  };
  if (process.platform === "darwin") {
    const sub = chromeDirs.darwin[browser] ?? chromeDirs.darwin.chrome;
    return resolve(home, "Library/Application Support", sub, "NativeMessagingHosts");
  }
  if (process.platform === "linux") {
    const sub = { chrome: "google-chrome", chromium: "chromium", brave: "BraveSoftware/Brave-Browser", edge: "microsoft-edge" }[browser] ?? "google-chrome";
    return resolve(home, ".config", sub, "NativeMessagingHosts");
  }
  return null; // win32
}

function windowsRegKey(browser) {
  const vendor = { chrome: "Google\\Chrome", edge: "Microsoft\\Edge", brave: "BraveSoftware\\Brave-Browser", chromium: "Chromium" }[browser] ?? "Google\\Chrome";
  return `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
}

function manifestBody() {
  return JSON.stringify({
    name: NATIVE_HOST_NAME,
    description: "Tabduct native host",
    path: launcherPath(),
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId()}/`],
  }, null, 2);
}

export function register(browser = "chrome") {
  writeNodePath();
  const body = manifestBody();

  if (process.platform === "win32") {
    const manifestPath = resolve(HOST_DIR, `${NATIVE_HOST_NAME}.json`);
    writeFileSync(manifestPath, body, "utf8");
    try {
      execFileSync("reg", ["add", windowsRegKey(browser), "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);
    } catch (e) {
      throw new Error(`failed to write registry key ${windowsRegKey(browser)} (is reg.exe available?): ${e.message}`);
    }
    console.error(`[tabduct] registered (${browser}, Windows). manifest: ${manifestPath}`);
  } else {
    const dir = manifestDir(browser);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${NATIVE_HOST_NAME}.json`), body, "utf8");
    try { chmodSync(launcherPath(), 0o755); } catch {}
    console.error(`[tabduct] registered (${browser}). manifest: ${resolve(dir, `${NATIVE_HOST_NAME}.json`)}`);
  }
}

export function unregister(browser = "chrome") {
  if (process.platform === "win32") {
    try { execFileSync("reg", ["delete", windowsRegKey(browser), "/f"]); } catch {}
    try { rmSync(resolve(HOST_DIR, `${NATIVE_HOST_NAME}.json`), { force: true }); } catch {}
  } else {
    const dir = manifestDir(browser);
    try { rmSync(resolve(dir, `${NATIVE_HOST_NAME}.json`), { force: true }); } catch {}
  }
  console.error(`[tabduct] unregistered (${browser}).`);
}
