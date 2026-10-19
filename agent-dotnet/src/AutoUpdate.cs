using System.Security.Cryptography;

namespace Mrc.Agent;

/// <summary>
/// Auto-update: after the welcome advertises a newer build, download it next
/// to the exe, verify its sha256 and hand it to restart as updatePath. One
/// attempt per process, mirroring agent/src/auto-update.ts.
/// </summary>
public static class AutoUpdate
{
    private static int _scheduled;

    public static bool Enabled { get; set; } = true;

    public static void Schedule(AgentConnection connection, WelcomeMsg welcome)
    {
        if (!Enabled || !connection.Connected) return;
        if (string.IsNullOrEmpty(welcome.LatestAgentVersion)) return;
        if (Versions.Compare(welcome.LatestAgentVersion, Versions.Current) <= 0)
        {
            Log.Debug("auto-update: up to date", new { current = Versions.Current, latest = welcome.LatestAgentVersion });
            return;
        }
        if (string.IsNullOrEmpty(welcome.AgentBinaryUrl))
        {
            Log.Warn("auto-update: server advertises a newer version without a binary url", new { latest = welcome.LatestAgentVersion });
            return;
        }
        if (Interlocked.Exchange(ref _scheduled, 1) == 1) return;
        _ = Task.Run(() => RunAsync(welcome));
    }

    private static async Task RunAsync(WelcomeMsg welcome)
    {
        var execPath = Environment.ProcessPath ?? "";
        if (string.IsNullOrEmpty(execPath)) return;
        var staged = Path.Combine(
            Path.GetDirectoryName(execPath) ?? ".",
            Path.GetFileNameWithoutExtension(execPath) + ".new.exe");

        try
        {
            var url = ResolveBinaryUrl(welcome.AgentBinaryUrl!, Settings.Current.ServerUrl);
            Log.Info("auto-update: downloading", new { url, latest = welcome.LatestAgentVersion });
            var bytes = await DownloadAsync(url).ConfigureAwait(false);
            var sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

            if (!string.IsNullOrEmpty(welcome.AgentBinarySha256) &&
                !string.Equals(sha256, welcome.AgentBinarySha256, StringComparison.OrdinalIgnoreCase))
            {
                var bad = staged + ".bad";
                await File.WriteAllBytesAsync(bad, bytes).ConfigureAwait(false);
                throw new InvalidOperationException(
                    $"auto-update rejected: sha256 mismatch (expected {welcome.AgentBinarySha256[..16]}…, got {sha256[..16]}…)");
            }

            await File.WriteAllBytesAsync(staged, bytes).ConfigureAwait(false);
            Log.Info("auto-update: staged", new { staged, bytes = bytes.Length });

            var outcome = await Restart.JobRestart(
                System.Text.Json.JsonSerializer.SerializeToElement(new { updatePath = staged }),
                new JobContext("auto-update", _ => { }),
                CancellationToken.None).ConfigureAwait(false);
            if (!outcome.Ok) Log.Error("auto-update: restart failed", new { error = outcome.Error });
        }
        catch (Exception ex)
        {
            Log.Error("auto-update failed", new { error = ex.Message });
        }
    }

    /// <summary>Relative urls resolve against the hub origin derived from the ws url.</summary>
    public static string ResolveBinaryUrl(string binaryUrl, string serverUrl)
    {
        if (Uri.TryCreate(binaryUrl, UriKind.Absolute, out var absolute)) return absolute.ToString();
        Uri.TryCreate(serverUrl, UriKind.Absolute, out var server);
        var scheme = server?.Scheme == "wss" ? "https" : "http";
        var host = server?.Host ?? "127.0.0.1";
        var port = server?.Port ?? Protocol.DefaultWsPort;
        var clean = binaryUrl.TrimStart('/');
        return $"{scheme}://{host}:{port}/{clean}";
    }

    private static async Task<byte[]> DownloadAsync(string url)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(2) };
        using var response = await http.GetAsync(url).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"download failed: HTTP {(int)response.StatusCode} from {url}");
        return await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
    }
}
