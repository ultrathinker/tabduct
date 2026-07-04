using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Tabduct.Host;

/// <summary>
/// Chrome Native Messaging transport (PROTOCOL.md §1): frames are
/// <c>[uint32 LE length][UTF-8 JSON]</c>. stdin is read on a dedicated blocking
/// thread; stdout writes are serialized under a lock. Mirrors
/// hosts/python/tabduct_host/native_messaging.py + hosts/node/src/native-messaging.js.
/// </summary>
/// <remarks>
/// stdout MUST stay pure native-messaging frames: Kestrel/ASP.NET logging is kept
/// off stdout (see Program/McpServer), and this class writes raw bytes to the
/// standard-output stream captured once at construction — never Console.WriteLine.
/// </remarks>
internal sealed class NativeMessaging : IDisposable
{
    // Chrome caps: host->ext 1 MB (hard, sever-on-overflow); ext->host 64 MiB.
    // Our inbound sanity cap (about half the real inbound limit): oversize is
    // SKIPPED (the invoke times out), not fatal.
    private const int MaxFrameBytes = 32 * 1024 * 1024;
    private const int OutFrameMaxBytes = 1024 * 1024;

    private readonly Stream _stdin;
    private readonly Stream _stdout;
    private readonly object _writeLock = new();
    private Thread? _reader;
    private volatile bool _stopped;

    public NativeMessaging()
    {
        // Capture the raw streams ONCE. Writing bytes directly to the stdout
        // stream keeps it binary-clean (no TextWriter/CRLF/encoding translation).
        _stdin = Console.OpenStandardInput();
        _stdout = Console.OpenStandardOutput();
    }

    /// <summary>Wire error raised when an outbound frame would overflow Chrome's 1 MB cap.</summary>
    public sealed class FrameTooLargeException(string message) : Exception(message)
    {
        public string Code => "FRAME_TOO_LARGE";
    }

    /// <summary>Encode <paramref name="msg"/> as a native-messaging frame and write it to stdout.</summary>
    public void Send(JsonObject msg)
    {
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(msg);
        if (body.Length > OutFrameMaxBytes)
        {
            throw new FrameTooLargeException($"outbound frame {body.Length}B exceeds 1 MB cap");
        }

        byte[] frame = new byte[4 + body.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(0, 4), (uint)body.Length);
        Buffer.BlockCopy(body, 0, frame, 4, body.Length);

        lock (_writeLock)
        {
            _stdout.Write(frame, 0, frame.Length);
            _stdout.Flush();
        }
    }

    /// <summary>Start the blocking stdin reader thread.</summary>
    /// <param name="onRequest">Invoked for inbound requests (have <c>type</c>).</param>
    /// <param name="onReply">Invoked for inbound replies (have <c>replyTo</c>); always called on the reader thread.</param>
    /// <param name="onEnd">Invoked once when stdin reaches EOF (authoritative shutdown).</param>
    public void Start(Action<JsonObject> onRequest, Action<JsonObject> onReply, Action onEnd)
    {
        _reader = new Thread(() => ReadLoop(onRequest, onReply, onEnd))
        {
            Name = "tabduct-nm-reader",
            IsBackground = true,
        };
        _reader.Start();
    }

    private void ReadLoop(Action<JsonObject> onRequest, Action<JsonObject> onReply, Action onEnd)
    {
        try
        {
            while (true)
            {
                byte[]? header = ReadExact(4);
                if (header is null) break; // stdin closed (extension gone / worker evicted)

                uint length = BinaryPrimitives.ReadUInt32LittleEndian(header);
                if (length == 0)
                {
                    Fatal($"bad length header: {length}");
                    return;
                }
                if (length > MaxFrameBytes)
                {
                    Log($"dropping oversize frame: {length}B (cap {MaxFrameBytes})");
                    Skip((int)length);
                    continue;
                }

                byte[]? body = ReadExact((int)length);
                if (body is null) break; // EOF mid-frame

                JsonObject? msg;
                try
                {
                    msg = JsonNode.Parse(Encoding.UTF8.GetString(body)) as JsonObject;
                }
                catch (Exception e)
                {
                    Fatal($"non-JSON frame: {e.Message}");
                    return;
                }
                if (msg is null)
                {
                    Fatal("non-object frame");
                    return;
                }

                if (msg.ContainsKey("replyTo"))
                {
                    onReply(msg);
                }
                else
                {
                    onRequest(msg);
                }
            }
        }
        catch (Exception e)
        {
            Log($"native-messaging reader error: {e.Message}");
        }
        finally
        {
            if (!_stopped)
            {
                _stopped = true;
                onEnd();
            }
        }
    }

    private byte[]? ReadExact(int n)
    {
        byte[] buf = new byte[n];
        int read = 0;
        while (read < n)
        {
            int r = _stdin.Read(buf, read, n - read);
            if (r <= 0) return null; // EOF (a partial frame at EOF is also treated as EOF)
            read += r;
        }
        return buf;
    }

    private void Skip(int n)
    {
        byte[] buf = new byte[Math.Min(n, 65536)];
        int remaining = n;
        while (remaining > 0)
        {
            int r = _stdin.Read(buf, 0, Math.Min(remaining, buf.Length));
            if (r <= 0) return; // EOF while skipping
            remaining -= r;
        }
    }

    private static void Fatal(string reason)
    {
        // Length-prefixed desync is unrecoverable: Chrome surfaces the disconnect.
        Log($"fatal framing error: {reason}");
        Environment.Exit(1);
    }

    private static void Log(string message)
    {
        // stderr only — never stdout (that is the frame stream).
        Console.Error.WriteLine($"[tabduct] {message}");
    }

    public void Dispose()
    {
        _stopped = true;
    }
}
