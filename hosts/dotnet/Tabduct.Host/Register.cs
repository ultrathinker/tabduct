using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Tabduct.Host;

/// <summary>
/// Native-messaging registration (PROTOCOL.md §9). Points the manifest at the built
/// apphost, and computes the extension id from the shared extension/manifest.json
/// `key` (must match every other host). Mirrors hosts/node/src/register.js.
/// </summary>
internal static class Register
{
    private const string HostName = "com.tabduct.host";

    private static string RepoRoot()
    {
        // AppContext.BaseDirectory = .../hosts/dotnet/bin/Debug/net10.0/ → walk up to the repo.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 8 && dir is not null; i++)
        {
            if (File.Exists(Path.Combine(dir.FullName, "extension", "manifest.json"))) return dir.FullName;
            dir = dir.Parent;
        }
        throw new Exception("could not locate repo root (extension/manifest.json)");
    }

    // Chrome id = sha256(SPKI DER) first 16 bytes, each nibble 0..f -> a..p.
    private static string ExtensionId()
    {
        var node = JsonNode.Parse(File.ReadAllText(Path.Combine(RepoRoot(), "extension", "manifest.json")))!;
        var key = node["key"]?.GetValue<string>() ?? throw new Exception("extension/manifest.json has no `key`");
        var hash = SHA256.HashData(Convert.FromBase64String(key));
        var sb = new StringBuilder(32);
        for (int i = 0; i < 16; i++) { sb.Append((char)('a' + (hash[i] >> 4))); sb.Append((char)('a' + (hash[i] & 0xf))); }
        return sb.ToString();
    }

    private static string HostBinaryPath() =>
        Path.Combine(AppContext.BaseDirectory, OperatingSystem.IsWindows() ? "Tabduct.Host.exe" : "Tabduct.Host");

    private static string ManifestBody() => JsonSerializer.Serialize(new
    {
        name = HostName,
        description = "Tabduct native host (.NET)",
        path = HostBinaryPath(),
        type = "stdio",
        allowed_origins = new[] { $"chrome-extension://{ExtensionId()}/" },
    }, new JsonSerializerOptions { WriteIndented = true });

    private static string? ManifestDir(string browser)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (OperatingSystem.IsMacOS())
        {
            var sub = browser switch { "chromium" => "Chromium", "edge" => "Microsoft Edge", "brave" => "BraveSoftware/Brave-Browser", _ => "Google/Chrome" };
            return Path.Combine(home, "Library", "Application Support", sub, "NativeMessagingHosts");
        }
        if (OperatingSystem.IsLinux())
        {
            var sub = browser switch { "chromium" => "chromium", "edge" => "microsoft-edge", "brave" => "BraveSoftware/Brave-Browser", _ => "google-chrome" };
            return Path.Combine(home, ".config", sub, "NativeMessagingHosts");
        }
        return null; // Windows → registry
    }

    private static string WinRegKey(string browser)
    {
        var vendor = browser switch { "edge" => @"Microsoft\Edge", "brave" => @"BraveSoftware\Brave-Browser", "chromium" => "Chromium", _ => @"Google\Chrome" };
        return $@"HKCU\Software\{vendor}\NativeMessagingHosts\{HostName}";
    }

    private static string WinManifestPath() => Path.Combine(AppContext.BaseDirectory, $"{HostName}.json");

    private static void Reg(params string[] args)
    {
        var psi = new ProcessStartInfo("reg") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var a in args) psi.ArgumentList.Add(a);
        var p = Process.Start(psi)!;
        p.WaitForExit();
        if (p.ExitCode != 0) throw new Exception($"reg {string.Join(' ', args)} failed (exit {p.ExitCode})");
    }

    public static void Run(string action, string browser)
    {
        if (action == "register")
        {
            var body = ManifestBody();
            if (OperatingSystem.IsWindows())
            {
                var mpath = WinManifestPath();
                File.WriteAllText(mpath, body);
                Reg("add", WinRegKey(browser), "/ve", "/t", "REG_SZ", "/d", mpath, "/f");
                Console.Error.WriteLine($"[tabduct] registered (.net, {browser}, Windows). manifest: {mpath}");
            }
            else
            {
                var dir = ManifestDir(browser)!;
                Directory.CreateDirectory(dir);
                var mpath = Path.Combine(dir, $"{HostName}.json");
                File.WriteAllText(mpath, body);
                Console.Error.WriteLine($"[tabduct] registered (.net, {browser}). manifest: {mpath}");
            }
        }
        else // unregister
        {
            if (OperatingSystem.IsWindows())
            {
                try { Reg("delete", WinRegKey(browser), "/f"); } catch { }
                try { File.Delete(WinManifestPath()); } catch { }
            }
            else
            {
                var mpath = Path.Combine(ManifestDir(browser)!, $"{HostName}.json");
                try { File.Delete(mpath); } catch { }
            }
            Console.Error.WriteLine($"[tabduct] unregistered (.net, {browser}).");
        }
    }
}
