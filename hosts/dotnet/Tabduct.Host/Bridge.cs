using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using System.Threading;

namespace Tabduct.Host;

/// <summary>
/// Turns "call a tool" (MCP side) into an <c>invoke</c> message on the wire and
/// resolves when the extension replies (correlated by <c>id</c>). Heart of the
/// host. Mirrors hosts/python/tabduct_host/bridge.py + hosts/node/src/bridge.js.
/// </summary>
internal sealed class Bridge
{
    private const int InvokeTimeoutMs = 20_000; // per tool_call round-trip

    private readonly NativeMessaging _nm;
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonNode?>> _pending = new();

    public Bridge(NativeMessaging nm)
    {
        _nm = nm;
    }

    /// <summary>A tool invocation that the extension reported as failed (or timed out).</summary>
    public sealed class ToolError(string code, string message) : Exception(message)
    {
        public string Code { get; } = code;
    }

    /// <summary>Feed replies from the extension. Always safe to call from the reader thread.</summary>
    public void HandleReply(JsonObject msg)
    {
        if (msg["replyTo"] is not JsonValue rv || rv.TryGetValue<string>(out string? rid) is false || rid is null)
        {
            return;
        }
        if (!_pending.TryRemove(rid, out var tcs)) return; // unknown/already-resolved — drop quietly

        // Read defensively: a present-but-wrong-typed field must NOT throw on the
        // reader thread (that would kill the whole host). Mirrors Node/Python.
        bool ok = msg["ok"] is JsonValue okv && okv.TryGetValue<bool>(out bool okb) && okb;
        if (ok)
        {
            tcs.TrySetResult(msg["result"]);
        }
        else
        {
            string code = msg["error"]?["code"] is JsonValue cv && cv.TryGetValue<string>(out string? cs) && cs is { Length: > 0 } ? cs : "INTERNAL";
            string message = msg["error"]?["message"] is JsonValue mv && mv.TryGetValue<string>(out string? ms) && ms is { Length: > 0 } ? ms : "tool failed";
            tcs.TrySetException(new ToolError(code, message));
        }
    }

    /// <summary>Ask the extension to run a tool; resolves with its result object.</summary>
    public async Task<JsonNode?> Invoke(string tool, JsonObject args)
    {
        string rid = Guid.NewGuid().ToString("N");
        var tcs = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[rid] = tcs;

        var message = new JsonObject
        {
            ["type"] = "invoke",
            ["id"] = rid,
            ["payload"] = new JsonObject
            {
                ["tool"] = tool,
                ["args"] = args,
            },
        };

        try
        {
            _nm.Send(message);
        }
        catch (Exception e)
        {
            _pending.TryRemove(rid, out _);
            string code = e is NativeMessaging.FrameTooLargeException ? "FRAME_TOO_LARGE" : "INTERNAL";
            throw new ToolError(code, e.Message);
        }

        using var cts = new CancellationTokenSource(InvokeTimeoutMs);
        using (cts.Token.Register(() =>
        {
            if (_pending.TryRemove(rid, out var pending))
            {
                pending.TrySetException(new ToolError("TIMEOUT", $"Tool \"{tool}\" timed out after {InvokeTimeoutMs}ms"));
            }
        }))
        {
            return await tcs.Task.ConfigureAwait(false);
        }
    }

    /// <summary>Reject everything in flight (extension/Chrome went away).</summary>
    public void RejectAll(string reason)
    {
        foreach (var kv in _pending)
        {
            if (_pending.TryRemove(kv.Key, out var tcs))
            {
                tcs.TrySetException(new ToolError("INTERNAL", reason));
            }
        }
    }
}
