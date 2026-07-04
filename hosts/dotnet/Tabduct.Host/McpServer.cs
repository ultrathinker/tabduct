using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.AspNetCore.Server.Kestrel.Transport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Tabduct.Host;

/// <summary>
/// MCP streamable-HTTP server (the "north" edge). HTTP server on
/// <c>127.0.0.1:&lt;port&gt;/mcp</c> using the official C# MCP SDK's low-level
/// request handlers + the ASP.NET Core streamable-HTTP transport. Auth + origin/host
/// checks (PROTOCOL.md §6) gate EVERY request in middleware that runs BEFORE the
/// MCP endpoint. Mirrors hosts/python/tabduct_host/mcp_server.py +
/// hosts/node/src/mcp-server.js + tools.js.
///
/// The catalog is served VERBATIM from protocol/tools.schema.json (single source
/// of truth) — tools are built from the JSON, never hand-written.
/// </summary>
internal sealed class McpServer
{
    public const string BindHost = "127.0.0.1";
    public const string McpPath = "/mcp";
    public const int DefaultPort = 12310;

    // Loaded once at process start; the JsonDocument is kept alive so the cloned
    // inputSchema JsonElements remain valid for the process lifetime.
    private static readonly JsonDocument CatalogDoc = LoadCatalog();
    public static readonly int ProtocolVersion = CatalogDoc.RootElement.GetProperty("protocolVersion").GetInt32();

    private static readonly CatalogEntry[] Catalog = BuildCatalog(CatalogDoc);
    private static readonly Tool[] McpTools = BuildMcpTools(Catalog);

    private static readonly Regex BearerRe = new("^Bearer\\s+(.+)$", RegexOptions.Compiled);
    private static readonly Regex DataUrlRe = new("^data:([^;,]+);base64,([\\s\\S]+)$", RegexOptions.Compiled);
    private static readonly Regex WhitespaceRe = new("\\s+", RegexOptions.Compiled);

    private readonly Bridge _bridge;
    private WebApplication? _app;
    private ListenOptions? _listen;
    private string? _token;
    private int _port;
    public bool IsRunning { get; private set; }
    private bool _starting;

    public McpServer(Bridge bridge) => _bridge = bridge;

    /// <summary>Bind on <paramref name="port"/> (0 = ephemeral); returns the actually-bound port.</summary>
    public async Task<int> Start(int port, string token)
    {
        if (IsRunning || _starting) throw new InvalidOperationException("Server already running");
        _starting = true;
        try
        {
            _token = token;
            _listen = null;

            var builder = WebApplication.CreateSlimBuilder();
            // CRITICAL: keep stdout pure native-messaging frames. No console/kestrel
            // logging to stdout. (We log nothing by default; nothing reaches stdout.)
            builder.Logging.ClearProviders();

            builder.WebHost.ConfigureKestrel(opts =>
            {
                // Cap the request body at the protocol limit (parity with Node's
                // MCP_REQUEST_MAX_BYTES) rather than leaning on Kestrel's ~30 MB default.
                opts.Limits.MaxRequestBodySize = 8 * 1024 * 1024;
                opts.Listen(IPAddress.Loopback, port, lo => _listen = lo);
            });

            builder.Services.AddMcpServer(o =>
                {
                    o.ServerInfo = new Implementation { Name = "tabduct", Version = "0.0.1" };
                })
                .WithListToolsHandler((_, _) => new ValueTask<ListToolsResult>(new ListToolsResult { Tools = McpTools }))
                .WithCallToolHandler((ctx, ct) => new ValueTask<CallToolResult>(CallTool(ctx.Params!, ct)))
                .WithHttpTransport();

            var app = builder.Build();

            // PROTOCOL.md §6 gatekeeper — runs BEFORE the MCP endpoint consumes the body.
            app.Use(async (http, next) =>
            {
                // 1. Any Origin header → 403 (no non-browser MCP client sends Origin).
                if (!string.IsNullOrEmpty(http.Request.Headers.Origin.ToString()))
                {
                    http.Response.StatusCode = StatusCodes.Status403Forbidden;
                    return;
                }
                // 2. Host header must be a loopback alias on our port (DNS-rebinding defense).
                var allowed = AllowedHosts(_port);
                if (!allowed.Contains(http.Request.Headers.Host.ToString()))
                {
                    http.Response.StatusCode = StatusCodes.Status403Forbidden;
                    return;
                }
                // 3. Authorization: Bearer <token> (constant-time compare).
                string? bearer = ParseBearer(http.Request.Headers.Authorization.ToString());
                if (bearer is null || !TokenEquals(bearer, _token ?? ""))
                {
                    http.Response.StatusCode = StatusCodes.Status401Unauthorized;
                    return;
                }
                await next();
            });

            app.MapMcp(McpPath);

            _app = app;
            await app.StartAsync();

            _port = _listen!.IPEndPoint!.Port;
            IsRunning = true;
            return _port;
        }
        finally
        {
            _starting = false;
        }
    }

    public async Task Stop()
    {
        var app = _app;
        _app = null;
        if (app is not null)
        {
            // StopAsync closes the listening socket → connections REFUSED afterwards,
            // and reaps the MCP sessions via the streamable-HTTP transport shutdown.
            await app.StopAsync(TimeSpan.FromSeconds(2));
            await app.DisposeAsync();
        }
        _listen = null;
        _token = null;
        _port = 0;
        IsRunning = false;
    }

    // --- catalog → MCP tools --------------------------------------------------

    private sealed record CatalogEntry(string Name, string? Description, JsonElement InputSchema);

    private static JsonDocument LoadCatalog()
    {
        string path = ResolveCatalogPath();
        return JsonDocument.Parse(File.ReadAllText(path));
    }

    private static string ResolveCatalogPath()
    {
        // 1. CWD-relative (conformance runs from the repo root).
        string cwdRel = Path.Combine(Environment.CurrentDirectory, "protocol", "tools.schema.json");
        if (File.Exists(cwdRel)) return cwdRel;

        // 2. Walk up from the assembly base dir (built dll lives several levels under the repo).
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            string p = Path.Combine(dir.FullName, "protocol", "tools.schema.json");
            if (File.Exists(p)) return p;
        }
        // 3. Walk up from CWD as a last resort.
        for (var dir = new DirectoryInfo(Environment.CurrentDirectory); dir is not null; dir = dir.Parent)
        {
            string p = Path.Combine(dir.FullName, "protocol", "tools.schema.json");
            if (File.Exists(p)) return p;
        }
        throw new FileNotFoundException("protocol/tools.schema.json not found");
    }

    private static CatalogEntry[] BuildCatalog(JsonDocument doc)
    {
        var tools = doc.RootElement.GetProperty("tools");
        var list = new List<CatalogEntry>();
        foreach (var t in tools.EnumerateArray())
        {
            string name = t.GetProperty("name").GetString()!;
            string? description = t.TryGetProperty("description", out var d) ? d.GetString() : null;
            JsonElement schema = t.TryGetProperty("inputSchema", out var s) ? s : default;
            // Clone so the element is independent of the document's pooled buffers.
            list.Add(new CatalogEntry(name, description, schema.Clone()));
        }
        return list.ToArray();
    }

    private static Tool[] BuildMcpTools(CatalogEntry[] catalog)
        => catalog.Select(t => new Tool
        {
            Name = t.Name,
            Description = t.Description ?? "",
            InputSchema = t.InputSchema,
        }).ToArray();

    // --- tools/call -----------------------------------------------------------

    private async Task<CallToolResult> CallTool(CallToolRequestParams p, CancellationToken ct)
    {
        string name = p.Name ?? "";
        var entry = Array.Find(Catalog, t => t.Name == name);
        if (entry is null)
        {
            return Error($"UNKNOWN_TOOL: Unknown tool: {name}");
        }

        JsonObject args = ToArgsObject(p.Arguments);
        string? bad = ValidateArgs(entry.InputSchema, args);
        if (bad is not null)
        {
            return Error($"INVALID_ARGS: {bad}");
        }

        try
        {
            JsonNode? result = await _bridge.Invoke(name, args).ConfigureAwait(false);
            return ToContent(name, result);
        }
        catch (Bridge.ToolError e)
        {
            return Error($"{e.Code}: {e.Message}");
        }
    }

    private static CallToolResult Error(string text) => new()
    {
        Content = new List<ContentBlock> { new TextContentBlock { Text = text } },
        IsError = true,
    };

    private static JsonObject ToArgsObject(IDictionary<string, JsonElement>? args)
    {
        var obj = new JsonObject();
        if (args is null) return obj;
        foreach (var kv in args)
        {
            obj[kv.Key] = JsonNode.Parse(kv.Value.GetRawText());
        }
        return obj;
    }

    /// <summary>Convert an extension tool result into MCP content blocks (screenshot → image ONLY).</summary>
    private static CallToolResult ToContent(string toolName, JsonNode? result)
    {
        if (toolName == "screenshot")
        {
            string dataUrl = result?["dataUrl"]?.GetValue<string>() ?? "";
            var m = DataUrlRe.Match(dataUrl);
            if (!m.Success)
            {
                return Error("INTERNAL: screenshot result missing base64 dataUrl");
            }
            string mime = m.Groups[1].Value;
            string data = WhitespaceRe.Replace(m.Groups[2].Value, "");
            return new CallToolResult
            {
                Content = new List<ContentBlock>
                {
                    new ImageContentBlock { MimeType = mime, Data = Convert.FromBase64String(data) },
                },
            };
        }

        return new CallToolResult
        {
            Content = new List<ContentBlock>
            {
                new TextContentBlock { Text = JsonSerializer.Serialize(result) },
            },
        };
    }

    // --- minimal, dependency-free inputSchema validation (required/type/enum) --

    private static string? ValidateArgs(JsonElement schema, JsonObject args)
    {
        if (schema.ValueKind != JsonValueKind.Object) return null;
        if (!schema.TryGetProperty("type", out var typeEl) || typeEl.GetString() != "object") return null;

        if (schema.TryGetProperty("required", out var reqEl) && reqEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var r in reqEl.EnumerateArray())
            {
                string? req = r.GetString();
                if (req is not null && args[req] is null)
                {
                    return $"missing required argument \"{req}\"";
                }
            }
        }

        if (schema.TryGetProperty("properties", out var propsEl) && propsEl.ValueKind == JsonValueKind.Object)
        {
            foreach (var prop in propsEl.EnumerateObject())
            {
                string key = prop.Name;
                if (!args.TryGetPropertyValue(key, out var v) || v is null) continue;
                var spec = prop.Value;

                if (spec.TryGetProperty("type", out var typeDecl) && !TypeOk(typeDecl, v))
                {
                    string td = typeDecl.ValueKind == JsonValueKind.Array
                        ? string.Join("/", typeDecl.EnumerateArray().Select(x => x.GetString()))
                        : typeDecl.GetString() ?? "";
                    return $"argument \"{key}\" must be of type {td}";
                }

                if (spec.TryGetProperty("enum", out var enumEl) && enumEl.ValueKind == JsonValueKind.Array)
                {
                    bool found = false;
                    foreach (var e in enumEl.EnumerateArray())
                    {
                        if (JsonNodeEqual(e, v)) { found = true; break; }
                    }
                    if (!found)
                    {
                        string opts = string.Join(", ", enumEl.EnumerateArray().Select(x => x.ToString()));
                        return $"argument \"{key}\" must be one of: {opts}";
                    }
                }
            }
        }

        return null;
    }

    private static bool TypeOk(JsonElement typeDecl, JsonNode v)
    {
        IEnumerable<string> types = typeDecl.ValueKind == JsonValueKind.Array
            ? typeDecl.EnumerateArray().Select(x => x.GetString() ?? "")
            : new[] { typeDecl.GetString() ?? "" };

        foreach (var t in types)
        {
            switch (t)
            {
                case "string": if (v is JsonValue jv && jv.TryGetValue<string>(out _)) return true; break;
                case "integer": if (IsInteger(v)) return true; break;
                case "number": if (IsNumber(v)) return true; break;
                case "boolean": if (v is JsonValue bv && bv.TryGetValue<bool>(out _)) return true; break;
                case "array": if (v is JsonArray) return true; break;
                case "object": if (v is JsonObject) return true; break;
                case "null": if (v is null) return true; break;
                default: return true; // unknown/missing → lenient
            }
        }
        return false;
    }

    private static bool IsInteger(JsonNode v)
    {
        if (v is not JsonValue jv) return false;
        return jv.TryGetValue(out decimal d) ? d == Math.Truncate(d) : jv.TryGetValue(out long _);
    }

    private static bool IsNumber(JsonNode v)
        => v is JsonValue jv && (jv.TryGetValue(out decimal _) || jv.TryGetValue(out double _));

    private static bool JsonNodeEqual(JsonElement el, JsonNode? node)
    {
        if (node is null) return el.ValueKind == JsonValueKind.Null;
        return JsonNode.Parse(el.GetRawText())?.ToJsonString() == node.ToJsonString();
    }

    // --- auth helpers ---------------------------------------------------------

    private static HashSet<string> AllowedHosts(int port)
        => new() { $"{BindHost}:{port}", $"localhost:{port}", $"[::1]:{port}" };

    private static string? ParseBearer(string authorization)
    {
        if (string.IsNullOrEmpty(authorization)) return null;
        var m = BearerRe.Match(authorization);
        return m.Success ? m.Groups[1].Value : null;
    }

    /// <summary>Constant-time bearer-token compare on UTF-8 bytes.</summary>
    private static bool TokenEquals(string a, string b)
    {
        byte[] ba = Encoding.UTF8.GetBytes(a);
        byte[] bb = Encoding.UTF8.GetBytes(b);
        return ba.Length == bb.Length && CryptographicOperations.FixedTimeEquals(ba, bb);
    }
}
