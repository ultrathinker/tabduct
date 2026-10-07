// Tabduct Node host — expose the tool catalog over MCP.
//
// The catalog is NOT duplicated here: it is read once from the language-neutral
// protocol/tools.schema.json (single source of truth). Low-level `Server` +
// explicit tools/list + tools/call so the catalog's JSON Schema is served
// verbatim (McpServer.registerTool wants a Zod shape → would force duplication).

import { readFileSync } from "node:fs";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CATALOG_PATH } from "./constants.js";

// Loaded once at module init (not per session).
const CATALOG = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
const TOOLS = CATALOG.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

export function loadCatalog() { return CATALOG; }

// Minimal, dependency-free schema check against the catalog's inputSchema:
// required fields, declared types, enums and numeric/string bounds.
// (additionalProperties is left lenient on purpose — the hub adds/strips routing
// fields; what an older extension would silently ignore is caught by feature
// gating, see requiredFeatures.) Returns an error string or null.
function typeOk(type, v) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) =>
    t === "string" ? typeof v === "string" :
    t === "integer" ? Number.isInteger(v) :
    t === "number" ? typeof v === "number" :
    t === "boolean" ? typeof v === "boolean" :
    t === "array" ? Array.isArray(v) :
    t === "object" ? (v != null && typeof v === "object" && !Array.isArray(v)) :
    t === "null" ? v === null : true);
}
function validateArgs(schema, args) {
  if (!schema || schema.type !== "object") return null;
  for (const req of schema.required || []) if (args[req] === undefined) return `missing required argument "${req}"`;
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    const v = args[key];
    if (v === undefined) continue;
    if (spec.type && !typeOk(spec.type, v)) return `argument "${key}" must be of type ${Array.isArray(spec.type) ? spec.type.join("/") : spec.type}`;
    if (spec.enum && !spec.enum.includes(v)) return `argument "${key}" must be one of: ${spec.enum.join(", ")}`;
    if (typeof v === "number") {
      if (spec.minimum !== undefined && v < spec.minimum) return `argument "${key}" must be >= ${spec.minimum}`;
      if (spec.maximum !== undefined && v > spec.maximum) return `argument "${key}" must be <= ${spec.maximum}`;
    }
    if (typeof v === "string") {
      if (spec.minLength !== undefined && v.length < spec.minLength) return `argument "${key}" must be at least ${spec.minLength} characters`;
      if (spec.maxLength !== undefined && v.length > spec.maxLength) return `argument "${key}" must be at most ${spec.maxLength} characters`;
    }
  }
  return null;
}

// Extension features a call needs: the tool's own `x-requires`, plus any argument whose
// property declares `x-requires` and is actually used (a truthy value: frameId 0 / trusted
// false mean "the default behaviour" and work on any build). A build that predates a feature
// would not fail on the unknown argument — it would run the call somewhere else (a frameId
// ignored, the script executed in the top page) — so the host refuses instead.
export function requiredFeatures(toolName, args) {
  const out = new Set();
  const tool = CATALOG.tools.find((t) => t.name === toolName);
  if (!tool) return out;
  if (tool["x-requires"]) out.add(tool["x-requires"]);
  for (const [key, spec] of Object.entries(tool.inputSchema?.properties || {})) {
    if (spec["x-requires"] && args?.[key]) out.add(spec["x-requires"]);
  }
  return out;
}

// Dotted numeric version compare: -1 / 0 / 1 (missing parts count as 0; junk counts as 0).
export function cmpVersion(a, b) {
  const pa = String(a ?? "").split(".").map((x) => parseInt(x, 10) || 0), pb = String(b ?? "").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

// Convert an extension tool result into MCP content blocks.
// screenshot → image content ONLY (never dump multi-MB base64 as text).
function toContent(toolName, result) {
  if (toolName === "screenshot") {
    const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(result?.dataUrl || "");
    if (!m) throw Object.assign(new Error("screenshot result missing base64 dataUrl"), { code: "INTERNAL" });
    return [{ type: "image", mimeType: m[1], data: m[2].replace(/\s+/g, "") }];
  }
  return [{ type: "text", text: JSON.stringify(result) }];
}

/**
 * Register catalog tools on a low-level MCP Server.
 * @param {object} server  @modelcontextprotocol/sdk Server instance
 * @param {import("./bridge.js").Bridge} bridge
 * @param {() => ({ version: string|null, features: Set<string> })} [getExt]  what the connected
 *   extension build reported in `open` (undefined = don't gate, e.g. tests of the transport only)
 */
export function registerTools(server, bridge, getExt) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      // Internal `_td/*` control ops (sharing snapshot/unshare) are NOT catalog tools:
      // they're forwarded to the extension as-is and never advertised via tools/list,
      // so the agent never sees them. Only the hub's /control channel calls them.
      if (typeof name === "string" && name.startsWith("_td/")) {
        const result = await bridge.invoke(name, args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      const tool = CATALOG.tools.find((t) => t.name === name);
      if (!tool) return { isError: true, content: [{ type: "text", text: `UNKNOWN_TOOL: Unknown tool: ${name}` }] };
      const bad = validateArgs(tool.inputSchema, args ?? {});
      if (bad) return { isError: true, content: [{ type: "text", text: `INVALID_ARGS: ${bad}` }] };
      const ext = getExt?.();
      if (ext) {
        const missing = [...requiredFeatures(name, args ?? {})].filter((f) => !ext.features.has(f));
        if (missing.length) {
          return { isError: true, content: [{ type: "text", text: `EXTENSION_OUTDATED: the Tabduct extension loaded in this browser (${ext.version ? `v${ext.version}` : "a build that predates version reporting"}) doesn't support: ${missing.join(", ")}. Nothing was run. Ask the user to reload the extension at chrome://extensions (Tabduct -> reload).` }] };
        }
      }
      const result = await bridge.invoke(name, args ?? {});
      return { content: toContent(name, result) };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `${e.code || "INTERNAL"}: ${e.message}` }] };
    }
  });

  return { tools: TOOLS, catalog: CATALOG };
}
