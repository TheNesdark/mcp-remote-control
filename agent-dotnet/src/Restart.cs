using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
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
        // The relaunch script itself is started through a one-shot task (the
        // only kind a non-admin can register), so the agent always comes back.
        // A persistent MRC-Agent task is not needed: the HKCU Run key covers
        // the start at logon, and the agent restarts itself here.
        var useTask = false;
        // Always write the script on the local disk: a script next to a
        // network-launched exe would live on the share, where it is slower and
        // can be blocked (and the relaunch itself must be a local path).
        var script = Path.Combine(Settings.LocalDir(), $"mrc-restart-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.bat");
        try
        {
            File.WriteAllText(script, BuildScript(execPath, updatePath, args, useTask));
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
            ["relaunch"] = useTask ? "scheduled-task" : "direct",
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

    private static string BuildScript(string execPath, string? updatePath, string[] args, bool useTask)
    {
        // End up running from the local install dir: an exe launched from a UNC
        // share raises a Windows security prompt and fails when the share is
        // unreachable.
        var localExe = Path.Combine(Settings.LocalDir(), Path.GetFileName(execPath));
        var isLocal = string.Equals(localExe, execPath, StringComparison.OrdinalIgnoreCase);
        var target = File.Exists(localExe) || isLocal ? localExe : execPath;
        var old = target + ".old";
        var quoted = string.Join(" ", args.Select(a => $"\"{a}\""));
        var task = ScheduledTask.GetTaskName() ?? "";

        var lines = new List<string> { "@echo off" };

        if (!string.IsNullOrEmpty(updatePath))
        {
            // Windows lets a RUNNING exe be renamed, so waiting for the file to
            // unlock does not wait for anything: the rename succeeds at once and
            // the new agent would start while the old one is still connected,
            // and the two would fight over the agent name. Wait for the old
            // PROCESS to be gone instead, then swap.
            lines.Add($"set OLD_PID={Environment.ProcessId}");
            lines.Add("set RETRIES=0");
            lines.Add(":waitpid");
            lines.Add("tasklist /fi \"PID eq %OLD_PID%\" 2>nul | find /i \"%OLD_PID%\" >nul");
            lines.Add("if errorlevel 1 goto unlocked");
            lines.Add("set /a RETRIES+=1");
            lines.Add("if %RETRIES% GEQ 40 goto busy");
            lines.Add("ping -n 2 127.0.0.1 >nul");
            lines.Add("goto waitpid");
            lines.Add(":unlocked");
            // Move the running image aside. (Windows allows renaming a running
            // exe, so this succeeds even while the old agent is still alive.)
            lines.Add($"move /y \"{target}\" \"{old}\" >nul 2>&1");
            // If we could not move it aside, do NOT start a second agent that
            // would fight over the name: keep the staged build and let the next
            // restart pick it up.
            lines.Add("if errorlevel 1 goto busy");

            // Put the staged build in place. If this fails (unexpected: nothing
            // should have the file open now), restore the old image and do NOT
            // relaunch, so we never start a half-swapped agent.
            lines.Add($"move /y \"{updatePath}\" \"{target}\" >nul 2>&1");
            lines.Add($"if not exist \"{target}\" (");
            lines.Add($"    move /y \"{old}\" \"{target}\" >nul 2>&1");
            lines.Add($"    echo swap failed: could not put {Path.GetFileName(updatePath)} in place >> %TEMP%\\mrc-restart.log");
            lines.Add("    goto end");
            lines.Add(")");
            lines.Add("goto relaunch");

            // The old process did not exit within the budget: do NOT start a
            // second agent with the same name. Keep the staged build and let
            // the next restart pick it up.
            lines.Add(":busy");
            lines.Add($"move /y \"{updatePath}\" \"{target}.new\" >nul 2>&1");
            lines.Add("echo el agente anterior sigue vivo; no se arranca otro >> %TEMP%\\mrc-restart.log");
            lines.Add("goto end");

            lines.Add(":relaunch");
        }

        // Relaunch: prefer the scheduled task (Windows supervises the process
        // and relaunches it fully detached), else start the exe directly. Only
        // one of the two must run, or two agents would race for the name.
        if (useTask)
        {
            // The task runs run-agent.cmd, which detaches the agent, so the
            // task does not track it: make sure the old instance is gone
            // before starting the new one (it usually already exited, which is
            // what released the file lock we waited for above).
            lines.Add($"taskkill /f /im {Path.GetFileName(target)} >nul 2>&1");
            lines.Add("ping -n 2 127.0.0.1 >nul");
            lines.Add($"schtasks /end /tn \"{task}\" >nul 2>&1");
            lines.Add("ping -n 2 127.0.0.1 >nul");
            lines.Add($"schtasks /run /tn \"{task}\" >nul 2>&1");
            // If the task did not start it (removed, policy), fall back to a
            // direct start so the machine is never left without an agent.
            lines.Add("ping -n 3 127.0.0.1 >nul");
            lines.Add($"tasklist /fi \"imagename eq {Path.GetFileName(target)}\" 2>nul | find /i \"{Path.GetFileName(target)}\" >nul");
            lines.Add($"if not errorlevel 1 goto checked");
            lines.Add($"start \"\" \"{target}\" {quoted}".TrimEnd());
            lines.Add(":checked");
        }
        else
        {
            lines.Add($"start \"\" \"{target}\" {quoted}".TrimEnd());
        }

        if (!string.IsNullOrEmpty(updatePath))
        {
            lines.Add("timeout /t 3 /nobreak >nul");
            lines.Add($"del /f /q \"{old}\" >nul 2>&1");
        }

        lines.Add(":end");
        return string.Join("\r\n", lines) + "\r\n";
    }

    /// <summary>
    /// Launches the relaunch script in a way that survives this process exiting.
    /// A scheduled task is the most reliable (Windows detaches it completely and
    /// it is what kept the process alive during earlier manual tests); `wmic` is
    /// deprecated and `cmd start` can die with its parent, so both are fallbacks.
    /// </summary>
    private static bool SpawnDetached(string script)
    {
        var name = "mrc-restart-" + Guid.NewGuid().ToString("N")[..8];
        try
        {
            using var create = Process.Start(new ProcessStartInfo("schtasks",
                $"/create /tn {name} /tr \"cmd.exe /c \\\"{script}\\\"\" /sc once /st 00:00 /f")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            });
            if (create is not null)
            {
                create.StandardOutput.ReadToEnd();
                create.StandardError.ReadToEnd();
                create.WaitForExit(5000);
                if (create.ExitCode == 0)
                {
                    using var run = Process.Start(new ProcessStartInfo("schtasks", $"/run /tn {name}")
                    {
                        UseShellExecute = false,
                        CreateNoWindow = true,
                    });
                    if (run is not null && run.WaitForExit(5000) && run.ExitCode == 0)
                    {
                        Log.Info("restart: relaunch task started", new { task = name });
                        return true;
                    }
                }
            }
            Log.Warn("restart: schtasks relaunch failed", new { task = name });
        }
        catch (Exception ex)
        {
            Log.Warn("restart: schtasks unavailable", new { error = ex.Message });
        }

        try
        {
            // /b runs the script in the same (hidden) console instead of spawning
            // a minimized window, so the user never sees a cmd during the swap.
            Process.Start(new ProcessStartInfo("cmd.exe", $"/c start /b \"\" \"{script}\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            Log.Info("restart: relaunch via cmd start");
            return true;
        }
        catch (Exception ex)
        {
            Log.Error("detached relaunch failed", new { error = ex.Message });
            return false;
        }
    }
}

/// <summary>
/// The Windows scheduled task that keeps the agent alive: INSTALAR-AGENTE.bat
/// creates it ONLOGON pointing at the local exe. When it exists, auto-update
/// swaps the file and asks the task to relaunch, instead of starting the exe
/// from a batch that would die with the agent process.
/// </summary>
public static class ScheduledTask
{
    /// <summary>The task name, or null when no known task is registered.</summary>
    public static string? GetTaskName()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return null;
        foreach (var candidate in new[] { "MRC-Agent" })
        {
            try
            {
                using var probe = Process.Start(new ProcessStartInfo("schtasks", $"/query /tn {candidate}")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                });
                if (probe is not null)
                {
                    probe.StandardOutput.ReadToEnd();
                    probe.StandardError.ReadToEnd();
                    probe.WaitForExit(4000);
                    if (probe.ExitCode == 0) return candidate;
                }
            }
            catch (Exception ex)
            {
                Log.Debug("scheduled task probe failed", new { task = candidate, error = ex.Message });
            }
        }
        return null;
    }

    /// <summary>
    /// The .cmd the scheduled task runs. It holds the start command with the
    /// settings, so a change has to be written here (the task itself only
    /// points at this file, which keeps the task definition quote-free).
    /// </summary>
    public static string RunScriptPath(string exe) =>
        Path.Combine(Settings.LocalDir(), "run-agent.cmd");

    /// <summary>
    /// Rewrites the start command the task runs. The task keeps the agent
    /// alive, and the command carries the settings: leaving the old ones there
    /// would silently undo a settings change.
    /// </summary>
    public static bool UpdateCommand(string task, string exe, string name, string server, string token)
    {
        try
        {
            var script = RunScriptPath(exe);
            var body = "@echo off\r\n" +
                        $"start \"\" \"{exe}\" --name {name} --server {server} --token {token}\r\n";
            File.WriteAllText(script, body, Encoding.UTF8);
            Log.Info("the start command was rewritten", new { script, name, server });
            return true;
        }
        catch (Exception ex)
        {
            Log.Debug("could not update the start command", new { task, error = ex.Message });
            return false;
        }
    }
}
