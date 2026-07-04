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
// required fields, declared types, and enums. (additionalProperties is left
// lenient on purpose — the hub adds/strips routing fields.) Returns an error
// string or null.
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
  }
  return null;
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
 */
export function registerTools(server, bridge) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const tool = CATALOG.tools.find((t) => t.name === name);
      if (!tool) return { isError: true, content: [{ type: "text", text: `UNKNOWN_TOOL: Unknown tool: ${name}` }] };
      const bad = validateArgs(tool.inputSchema, args ?? {});
      if (bad) return { isError: true, content: [{ type: "text", text: `INVALID_ARGS: ${bad}` }] };
      const result = await bridge.invoke(name, args ?? {});
      return { content: toContent(name, result) };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `${e.code || "INTERNAL"}: ${e.message}` }] };
    }
  });

  return { tools: TOOLS, catalog: CATALOG };
}
