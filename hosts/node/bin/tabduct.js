#!/usr/bin/env node
// Tabduct Node host — CLI.
//   tabduct register [--browser chrome|edge|brave|chromium]
//   tabduct unregister [--browser ...]
//   tabduct doctor      diagnose the setup
//   tabduct run         run the native host directly (Chrome normally does this)

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const HOST_DIR = resolve(__dir, "..");
const REPO = resolve(__dir, "../../..");

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const cmd = process.argv[2];

switch (cmd) {
  case "register": {
    const { register } = await import("../src/register.js");
    register(arg("--browser", "chrome"));
    break;
  }
  case "unregister": {
    const { unregister } = await import("../src/register.js");
    unregister(arg("--browser", "chrome"));
    break;
  }
  case "doctor": {
    const { extensionId } = await import("../src/register.js");
    const manifest = resolve(REPO, "extension/manifest.json");
    console.log("node        :", process.execPath, process.version);
    console.log("manifest    :", existsSync(manifest) ? "found" : "MISSING");
    try {
      const m = JSON.parse(readFileSync(manifest, "utf8"));
      console.log("manifest.key:", m.key ? "present" : "MISSING (run scripts/gen-key.js)");
      if (m.key) console.log("extension id:", extensionId());
    } catch (e) { console.log("manifest    : unreadable —", e.message); }
    console.log("node_path   :", existsSync(resolve(HOST_DIR, "node_path.txt")) ? "pinned" : "not pinned (run `tabduct register`)");
    const launcher = resolve(HOST_DIR, process.platform === "win32" ? "run_host.bat" : "run_host.sh");
    console.log("launcher    :", existsSync(launcher) ? launcher : `MISSING ${launcher}`);
    break;
  }
  case "hub": {
    const { runHub } = await import("../src/hub.js");
    await runHub();
    break;
  }
  case "instances": {
    const { readAll } = await import("../src/discovery.js");
    const { readSecrets, baseDir } = await import("../src/secrets.js");
    const fs = await import("node:fs"); const path = await import("node:path");
    const list = readAll();
    let hub = null;
    try { const j = JSON.parse(fs.readFileSync(path.resolve(baseDir(), "hub.json"), "utf8")); process.kill(j.pid, 0); hub = j; } catch {}
    const servers = {};
    if (hub) {
      const s = readSecrets();
      servers["tabduct-hub"] = { type: "http", url: `http://127.0.0.1:${hub.mcpPort}/mcp`, headers: { Authorization: `Bearer ${s?.tAgent}` } };
      if (list.length) console.error(`[tabduct] hub is up → using the single hub endpoint (${list.length} direct instance(s) proxied behind it).`);
    } else {
      const used = new Set();
      const slug = (s) => (String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "instance");
      for (const e of list) { // name the server by its human label so the agent refers to it that way
        let key = `tabduct-${slug(e.label)}`;
        if (used.has(key)) key = `${key}-${e.instanceId.slice(0, 4)}`; // dedupe same-label instances
        used.add(key);
        servers[key] = { type: "http", url: `http://127.0.0.1:${e.port}/mcp`, headers: { Authorization: `Bearer ${e.token}` }, _label: e.label };
      }
    }
    console.log(JSON.stringify({ mcpServers: servers }, null, 2));
    break;
  }
  case "run":
    await import("../src/index.js");
    break;
  default:
    console.error("usage: tabduct <register|unregister|doctor|run|instances|hub> [--browser chrome|edge|brave|chromium]");
    process.exit(1);
}
