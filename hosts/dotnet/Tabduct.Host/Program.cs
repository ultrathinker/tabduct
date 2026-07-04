using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading.Channels;

namespace Tabduct.Host;

/// <summary>
/// Tabduct host entry point. Boots native messaging, wires the bridge + MCP server,
/// and handles the request/reply lifecycle (open/close/ping). Requests are
/// SERIALIZED so an open/close race can't tear down a still-starting server.
/// Mirrors hosts/python/tabduct_host/__main__.py + hosts/node/src/index.js.
/// </summary>
internal static class Program
{
    // Wire error codes (PROTOCOL.md §6).
    private const string ErrVersionMismatch = "VERSION_MISMATCH";
    private const string ErrInvalidArgs = "INVALID_ARGS";
    private const string ErrInternal = "INTERNAL";

    private static readonly Channel<JsonObject> RequestChannel =
        Channel.CreateUnbounded<JsonObject>(new UnboundedChannelOptions { SingleReader = true });
    private static readonly SemaphoreSlim LifecycleLock = new(1, 1);

    private static NativeMessaging _nm = null!;
    private static Bridge _bridge = null!;
    private static McpServer _server = null!;
    private static string? _currentInstance;

    private static async Task Main(string[] args)
    {
        // CLI: `Tabduct.Host register|unregister [--browser chrome|edge|brave|chromium]`.
        if (args.Length > 0 && (args[0] == "register" || args[0] == "unregister"))
        {
            var browser = "chrome";
            var bi = Array.IndexOf(args, "--browser");
            if (bi >= 0 && bi + 1 < args.Length) browser = args[bi + 1];
            Register.Run(args[0], browser);
            return;
        }

        // Keep stdout binary-clean for native-messaging frames: we never write to
        // Console.Out (the raw stream is used by NativeMessaging). Pin UTF-8 so any
        // incidental text writer can't inject a BOM/CRLF into the frame stream.
        try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch { }

        _nm = new NativeMessaging();
        _bridge = new Bridge(_nm);
        _server = new McpServer(_bridge);

        _nm.Start(
            onRequest: msg => RequestChannel.Writer.TryWrite(msg),
            onReply: msg => _bridge.HandleReply(msg),
            onEnd: () => RequestChannel.Writer.TryComplete());

        try
        {
            // Drain lifecycle requests serially. The channel completes on stdin EOF
            // → ReadAllAsync ends → we shut the server down and exit.
            await foreach (var msg in RequestChannel.Reader.ReadAllAsync())
            {
                await LifecycleLock.WaitAsync();
                try
                {
                    await Handle(msg);
                }
                catch (Exception e)
                {
                    Console.Error.WriteLine($"[tabduct] handler error: {e.Message}");
                }
                finally
                {
                    LifecycleLock.Release();
                }
            }
        }
        finally
        {
            try { await _server.Stop(); }
            catch (Exception e) { Console.Error.WriteLine($"[tabduct] stop error: {e.Message}"); }
            _bridge.RejectAll("extension disconnected");
        }
    }

    // --- request handlers -----------------------------------------------------

    private static async Task Handle(JsonObject msg)
    {
        string? type = msg["type"]?.GetValue<string>();
        string? id = msg["id"]?.GetValue<string>();
        JsonObject? payload = msg["payload"] as JsonObject;

        switch (type)
        {
            case "open":
                await HandleOpen(id, payload);
                break;
            case "close":
                await HandleClose(id);
                break;
            case "ping":
                Reply(id, true, new JsonObject { ["pong"] = true });
                break;
            default:
                Reply(id, false, ErrInvalidArgs, $"unknown request type: {type}");
                break;
        }
    }

    private static async Task HandleOpen(string? id, JsonObject? payload)
    {
        if (payload is null) payload = new JsonObject();

        // Version check first (PROTOCOL.md §10).
        int? pv = payload["protocolVersion"]?.GetValue<int>();
        if (pv != McpServer.ProtocolVersion)
        {
            Reply(id, false, ErrVersionMismatch,
                $"host v{McpServer.ProtocolVersion}, extension v{pv?.ToString() ?? "null"}");
            return;
        }

        // Token: required string, length >= 16.
        string? token = payload["token"]?.GetValue<string>();
        if (token is null || token.Length < 16)
        {
            Reply(id, false, ErrInvalidArgs, "missing or too-short token");
            return;
        }

        // Port: optional, default 12310; must be int 0..65535.
        int port = McpServer.DefaultPort;
        if (payload.TryGetPropertyValue("port", out var portNode) && portNode is not null)
        {
            if (portNode is JsonValue pv2 && pv2.TryGetValue<int>(out int p2) && p2 >= 0 && p2 <= 65535)
            {
                port = p2;
            }
            else
            {
                Reply(id, false, ErrInvalidArgs, "invalid port");
                return;
            }
        }

        // One host per process: a second open while running is rejected.
        if (_server.IsRunning)
        {
            Reply(id, false, ErrInternal, "already running");
            return;
        }

        int bound;
        try
        {
            bound = await _server.Start(port, token);
        }
        catch (Exception e)
        {
            Reply(id, false, ErrInternal, $"open failed: {e.Message}");
            return;
        }

        string? iid = payload["instanceId"]?.GetValue<string>();
        _currentInstance = !string.IsNullOrEmpty(iid) ? iid : "default";

        try
        {
            WriteDiscoveryEntry(new JsonObject
            {
                ["instanceId"] = _currentInstance,
                ["label"] = payload["label"]?.GetValue<string>() ?? "Chrome",
                ["port"] = bound,
                ["token"] = token,
                ["pid"] = Environment.ProcessId,
                ["updatedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            });
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"[tabduct] discovery write failed: {e.Message}");
        }

        Reply(id, true, new JsonObject
        {
            ["port"] = bound,
            ["protocolVersion"] = McpServer.ProtocolVersion,
        });
    }

    private static async Task HandleClose(string? id)
    {
        try
        {
            await _server.Stop();
        }
        catch (Exception e)
        {
            Reply(id, false, ErrInternal, $"close failed: {e.Message}");
            return;
        }

        if (_currentInstance is not null)
        {
            RemoveDiscoveryEntry(_currentInstance);
            _currentInstance = null;
        }

        Reply(id, true, new JsonObject());
    }

    // --- replies --------------------------------------------------------------

    private static void Reply(string? id, bool ok, JsonObject result)
    {
        if (id is null) return;
        try
        {
            _nm.Send(new JsonObject
            {
                ["replyTo"] = id,
                ["ok"] = ok,
                ["result"] = result,
            });
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"[tabduct] failed to send reply: {e.Message}");
        }
    }

    private static void Reply(string? id, bool ok, string code, string message)
    {
        if (id is null) return;
        try
        {
            _nm.Send(new JsonObject
            {
                ["replyTo"] = id,
                ["ok"] = ok,
                ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
            });
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"[tabduct] failed to send reply: {e.Message}");
        }
    }

    // --- instance discovery (PROTOCOL.md §9a) ---------------------------------

    private static string InstancesDir()
    {
        string baseDir = Environment.GetEnvironmentVariable("TABDUCT_DIR")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".tabduct");
        return Path.Combine(baseDir, "instances");
    }

    private static string EntryPath(string instanceId)
    {
        string safe = Regex.Replace(instanceId, "[^a-zA-Z0-9._-]", "_");
        return Path.Combine(InstancesDir(), safe + ".json");
    }

    private static void WriteDiscoveryEntry(JsonObject entry)
    {
        string dir = InstancesDir();
        Directory.CreateDirectory(dir);
        string path = EntryPath(entry["instanceId"]!.GetValue<string>());
        string tmp = path + "." + Environment.ProcessId + ".tmp";

        string json = JsonSerializer.Serialize(entry, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(tmp, json);

        try { File.Move(tmp, path, overwrite: true); } // atomic publish
        catch
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
        }
    }

    private static void RemoveDiscoveryEntry(string instanceId)
    {
        try { if (File.Exists(EntryPath(instanceId))) File.Delete(EntryPath(instanceId)); }
        catch { }
    }
}
