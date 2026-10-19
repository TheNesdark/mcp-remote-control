using System.Security.Cryptography;

namespace Mrc.Agent;

/// <summary>
/// Auto-update: after the welcome advertises a newer build, stage it next to
/// the exe, verify its sha256 and hand it to restart as updatePath. One attempt
/// per process.
///
/// Two sources, in order of preference:
///  - AgentBinaryUnc: a Windows share the agent can read directly (typical on a
///    LAN: the hub runs in a Linux container and cannot reach the share, but
///    the agent can). Copied with retries since SMB can be slow to wake.
///  - AgentBinaryUrl: HTTP from the hub (relative URLs resolve against it).
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
        var hasUnc = !string.IsNullOrWhiteSpace(welcome.AgentBinaryUnc);
        var hasUrl = !string.IsNullOrWhiteSpace(welcome.AgentBinaryUrl);
        if (!hasUnc && !hasUrl)
        {
            Log.Warn("auto-update: server advertises a newer version without a source",
                new { latest = welcome.LatestAgentVersion });
            return;
        }
        if (Interlocked.Exchange(ref _scheduled, 1) == 1) return;
        _ = Task.Run(() => RunAsync(welcome));
    }

    /// <summary>
    /// Crash-loop guard: count attempts to reach one target version in a small
    /// state file, so a build that cannot be applied (locked file, bad share)
    /// does not restart the machine in a loop. Bounded, and an operator can
    /// delete the file to retry.
    /// </summary>
    private static bool TooManyAttempts(string targetVersion)
    {
        try
        {
            var file = Path.Combine(Settings.LocalDir(), "auto-update-attempts.json");
            var state = File.Exists(file)
                ? System.Text.Json.JsonSerializer.Deserialize<AttemptState>(File.ReadAllText(file)) ?? new AttemptState()
                : new AttemptState();
            if (state.Version != targetVersion) state = new AttemptState { Version = targetVersion };
            if (state.Count >= 3)
            {
                Log.Warn("auto-update: giving up on this version after repeated failures",
                    new { version = targetVersion, attempts = state.Count, hint = "delete auto-update-attempts.json to retry" });
                return true;
            }
            state.Count += 1;
            File.WriteAllText(file, System.Text.Json.JsonSerializer.Serialize(state));
            return false;
        }
        catch (Exception ex)
        {
            Log.Debug("auto-update: attempt file unreadable", new { error = ex.Message });
            return false;
        }
    }

    private sealed class AttemptState
    {
        public string Version { get; set; } = "";
        public int Count { get; set; }
    }

    private static async Task RunAsync(WelcomeMsg welcome)
    {
        if (TooManyAttempts(welcome.LatestAgentVersion ?? "")) return;
        var execPath = Environment.ProcessPath ?? "";
        if (string.IsNullOrEmpty(execPath)) return;
        // Stage on the LOCAL disk, never next to a network-launched exe: running
        // an .exe from a UNC share raises a Windows security prompt and staging
        // there would too. The restart also relaunches from this local copy.
        var exeName = Path.GetFileNameWithoutExtension(execPath);
        var staged = Path.Combine(Settings.LocalDir(), exeName + ".new.exe");

        try
        {
            byte[] bytes;
            if (!string.IsNullOrWhiteSpace(welcome.AgentBinaryUnc))
            {
                Log.Info("auto-update: copying from share", new { unc = welcome.AgentBinaryUnc, latest = welcome.LatestAgentVersion });
                bytes = await CopyFromShareAsync(welcome.AgentBinaryUnc!, staged + ".src").ConfigureAwait(false);
            }
            else
            {
                var url = ResolveBinaryUrl(welcome.AgentBinaryUrl!, Settings.Current.ServerUrl);
                Log.Info("auto-update: downloading", new { url, latest = welcome.LatestAgentVersion });
                bytes = await DownloadAsync(url).ConfigureAwait(false);
            }

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
            ClearZoneIdentifier(staged);
            Log.Info("auto-update: staged", new { staged, bytes = bytes.Length, sha256 });

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

    /// <summary>
    /// Drops the "downloaded from the network" mark (Zone.Identifier), so
    /// Windows does not prompt or raise SmartScreen when the staged build is
    /// relaunched. Harmless when the stream is absent.
    /// </summary>
    private static void ClearZoneIdentifier(string path)
    {
        try
        {
            var zone = path + ":Zone.Identifier";
            if (File.Exists(zone)) File.Delete(zone);
        }
        catch (Exception ex)
        {
            Log.Debug("auto-update: could not clear Zone.Identifier", new { error = ex.Message });
        }
    }

    /// <summary>
    /// Copies the build off a Windows share. Retries a few times: the first
    /// touch of an idle SMB share can fail while the share wakes up, and a
    /// partial/absent file must never be treated as the real build.
    /// </summary>
    private static async Task<byte[]> CopyFromShareAsync(string unc, string scratch)
    {
        Exception? last = null;
        for (var attempt = 1; attempt <= 4; attempt++)
        {
            try
            {
                await using (var source = File.OpenRead(unc))
                await using (var target = File.Create(scratch))
                {
                    await source.CopyToAsync(target).ConfigureAwait(false);
                }
                var bytes = await File.ReadAllBytesAsync(scratch).ConfigureAwait(false);
                try { File.Delete(scratch); } catch { /* best effort */ }
                if (bytes.Length == 0) throw new InvalidOperationException("the share returned an empty file");
                return bytes;
            }
            catch (Exception ex)
            {
                last = ex;
                Log.Warn("auto-update: share copy attempt failed", new { attempt, error = ex.Message });
                await Task.Delay(TimeSpan.FromSeconds(attempt * 2)).ConfigureAwait(false);
            }
        }
        throw new InvalidOperationException($"could not copy the build from '{unc}': {last?.Message}");
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
