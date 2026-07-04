// Tabduct Node host — shared constants.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const NATIVE_HOST_NAME = "com.tabduct.host";
export const DEFAULT_PORT = 12310;   // direct-mode host default/fallback
const _hubEnv = Number(process.env.TABDUCT_HUB_PORT);
export const HUB_PORT = Number.isInteger(_hubEnv) && _hubEnv > 0 ? _hubEnv : 12311; // hub facade (env override for tests)
export const MCP_PATH = "/mcp";
export const BIND_HOST = "127.0.0.1";

// Single source of truth for the protocol version: the catalog. Avoids drift
// between constants and protocol/tools.schema.json.
const __dir = dirname(fileURLToPath(import.meta.url));
export const CATALOG_PATH = resolve(__dir, "../../../protocol/tools.schema.json");
export const PROTOCOL_VERSION = JSON.parse(readFileSync(CATALOG_PATH, "utf8")).protocolVersion;

export const MAX_FRAME_BYTES = 32 * 1024 * 1024;   // inbound frame cap (screenshots); oversize is skipped, not fatal
export const OUT_FRAME_MAX_BYTES = 1024 * 1024;    // Chrome hard cap host->extension (1 MB)
export const MCP_REQUEST_MAX_BYTES = 8 * 1024 * 1024; // max HTTP request body we buffer
export const INVOKE_TIMEOUT_MS = 20_000;           // per tool_call round-trip
export const STOP_GRACE_MS = 2_000;                // force-close hung connections after this

// Loopback hosts accepted by the DNS-rebinding Host check (all pin to loopback).
export function allowedHosts(port) {
  return new Set([`${BIND_HOST}:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

// Wire error codes (PROTOCOL.md §6).
export const ERR = {
  UNKNOWN_TOOL: "UNKNOWN_TOOL",
  TAB_NOT_FOUND: "TAB_NOT_FOUND",
  TIMEOUT: "TIMEOUT",
  CSP_BLOCKED: "CSP_BLOCKED",
  SCRIPT_ERROR: "SCRIPT_ERROR",
  FRAME_TOO_LARGE: "FRAME_TOO_LARGE",
  VERSION_MISMATCH: "VERSION_MISMATCH",
  INVALID_ARGS: "INVALID_ARGS",
  INTERNAL: "INTERNAL",
  // Consent (Feature B) — enforced in the extension, passed through by the host.
  NOT_SHARED: "NOT_SHARED",
  ORIGIN_DRIFT: "ORIGIN_DRIFT",
  ORIGIN_DENIED: "ORIGIN_DENIED",
  CAP_NOT_GRANTED: "CAP_NOT_GRANTED",
  // Hub (Feature A, Phase 3)
  AMBIGUOUS_INSTANCE: "AMBIGUOUS_INSTANCE",
  INSTANCE_GONE: "INSTANCE_GONE",
};
