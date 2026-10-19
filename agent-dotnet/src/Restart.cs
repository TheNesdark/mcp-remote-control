using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Mrc.Agent;

/// <summary>
/// restart: relaunch the agent, optionally swapping in a freshly downloaded
/// binary (auto-update). A detached .bat waits a few seconds, moves the old
/// exe aside, copies the new one over it and starts it again — the process
/// cannot replace its own image while it is running.
/// </summary>
public static class Restart
{
    private const int RestartExitDelayMs = 1500;

    public static Task<JobOutcome> JobRestart(JsonElement p, JobContext ctx, CancellationToken ct)
    {
        var updatePath = Fs.ReadString(p, "updatePath");
        var execPath = Environment.ProcessPath ?? "";

        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            if (!string.IsNullOrEmpty(updatePath))
                return Task.FromResult(JobOutcome.Failure("restart with updatePath is only supported on Windows agents"));
            return Task.FromResult(JobOutcome.Success(new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["platform"] = "posix",
                ["execPath"] = execPath,
                ["note"] = "posix agent: restart requested; relaunch is managed by the supervisor",
            }));
        }

        var args = ReadArgs(p) ?? (Environment.GetCommandLineArgs().Skip(1).ToArray());
        // Always write the script on the local disk: a script next to a
        // network-launched exe would live on the share, where it is slower and
        // can be blocked (and the relaunch itself must be a local path).
        var script = Path.Combine(Settings.LocalDir(), $"mrc-restart-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.bat");
        try
        {
            File.WriteAllText(script, BuildScript(execPath, updatePath, args));
        }
        catch (Exception ex)
        {
            return Task.FromResult(JobOutcome.Failure($"could not write the relaunch script: {ex.Message}"));
        }

        if (!SpawnDetached(script))
        {
            return Task.FromResult(JobOutcome.Success(new Dictionary<string, object?>
            {
                ["ok"] = false,
                ["platform"] = "windows",
                ["execPath"] = execPath,
                ["error"] = "could not launch the detached relaunch script; restart the agent manually to apply changes",
                ["script"] = script,
            }));
        }

        // Give the batch time to be scheduled before this process disappears.
        _ = Task.Run(async () =>
        {
            await Task.Delay(RestartExitDelayMs).ConfigureAwait(false);
            Environment.Exit(0);
        });

        return Task.FromResult(JobOutcome.Success(new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["platform"] = "windows",
            ["execPath"] = execPath,
            ["updating"] = !string.IsNullOrEmpty(updatePath),
            ["script"] = script,
            ["exiting"] = true,
        }));
    }

    private static string[]? ReadArgs(JsonElement p)
    {
        if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty("args", out var args) || args.ValueKind != JsonValueKind.Array)
            return null;
        return args.EnumerateArray()
            .Where(a => a.ValueKind == JsonValueKind.String)
            .Select(a => a.GetString() ?? "")
            .ToArray();
    }

    private static string BuildScript(string execPath, string? updatePath, string[] args)
    {
        // Prefer to end up running from the local install dir, even when this
        // process was launched from a UNC share: an exe run from a share raises
        // a Windows security prompt and fails when the share is unreachable.
        var localExe = Path.Combine(Settings.LocalDir(), Path.GetFileName(execPath));

        var lines = new List<string>
        {
            "@echo off",
            "ping -n 6 127.0.0.1 >nul",
        };
        if (!string.IsNullOrEmpty(updatePath))
        {
            // Move the current image aside, drop the staged build in as the new
            // local exe, then start from local.
            if (!string.Equals(localExe, execPath, StringComparison.OrdinalIgnoreCase))
            {
                // Running from the share: stop touching the share image, just
                // land the new build locally.
                lines.Add($"move /y \"{localExe}\" \"{localExe}.old\" >nul 2>&1");
                lines.Add($"copy /y \"{updatePath}\" \"{localExe}\" >nul 2>&1");
            }
            else
            {
                lines.Add($"move /y \"{execPath}\" \"{execPath}.old\" >nul 2>&1");
                lines.Add($"copy /y \"{updatePath}\" \"{execPath}\" >nul 2>&1");
            }
            lines.Add($"del /f /q \"{updatePath}\" >nul 2>&1");
        }
        // Relaunch from local whenever a local copy exists (so a process that
        // started on the share lands on local after its first restart).
        var target = File.Exists(localExe) ? localExe : execPath;
        var quoted = string.Join(" ", args.Select(a => $"\"{a}\""));
        lines.Add($"start \"\" \"{target}\" {quoted}".TrimEnd());
        lines.Add($"del /f /q \"{target}.old\" >nul 2>&1");
        return string.Join("\r\n", lines) + "\r\n";
    }

    private static bool SpawnDetached(string script)
    {
        try
        {
            using var wmic = Process.Start(new ProcessStartInfo("wmic", $"process call create \"cmd.exe /c \\\"{script}\\\"\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            });
            if (wmic is not null)
            {
                var stdout = wmic.StandardOutput.ReadToEnd();
                wmic.WaitForExit(5000);
                if (wmic.ExitCode == 0 && stdout.Contains("ReturnValue = 0;")) return true;
            }
        }
        catch (Exception ex)
        {
            Log.Debug("wmic relaunch failed, trying cmd start", new { error = ex.Message });
        }
        try
        {
            Process.Start(new ProcessStartInfo("cmd.exe", $"/c start \"\" /min \"{script}\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            return true;
        }
        catch (Exception ex)
        {
            Log.Error("detached relaunch failed", new { error = ex.Message });
            return false;
        }
    }
}
