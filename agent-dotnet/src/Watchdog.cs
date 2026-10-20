using System.Diagnostics;

namespace Mrc.Agent;

/// <summary>
/// Keeps the agent alive.
///
/// An agent that dies is an agent nobody can reach: the only way back is
/// someone physically at the machine running the installer. The watchdog is a
/// second, tiny process that watches the first one and starts it again when
/// it goes away, so a crash (or an update that goes wrong) heals by itself.
///
/// It is deliberately simple and needs nothing special:
///
///   - it is the same executable with --watchdog, so there is nothing to
///     install and nothing to keep in sync;
///   - it opens no window and leaves no console behind;
///   - it needs no scheduled task and no administrator rights (the user
///     asked for both to be avoided);
///   - it stops when the agent is stopped on purpose (the tray writes the
///     stop file) and it waits before restarting, so an update that replaces
///     the executable does not end with two agents fighting over the name.
///
/// The agent leaves its pid in a file, so a restart (the update swap) is
/// seen as "the agent is alive, but with another pid".
/// </summary>
public static class Watchdog
{
    private const string MutexName = "Local\\Mrc.Agent.Watchdog";

    /// <summary>The pid of the agent that is running.</summary>
    public static string PidFile => Path.Combine(Settings.LocalDir(), "agent.pid");

    /// <summary>The arguments the agent was started with (without the token).</summary>
    public static string ArgsFile => Path.Combine(Settings.LocalDir(), "agent.args");

    /// <summary>Created when the agent is stopped on purpose.</summary>
    public static string StopFile => Path.Combine(Settings.LocalDir(), "watchdog.stop");

    /// <summary>How long the agent may be missing before it is started again.</summary>
    private const int GraceMs = 8000;

    /// <summary>
    /// Starts the watchdog, unless one is already running or the agent was
    /// told not to.
    /// </summary>
    public static void Start(string[] argv, bool enabled)
    {
        if (!enabled) return;
        try
        {
            var exe = Environment.ProcessPath;
            if (string.IsNullOrEmpty(exe)) return;

            WritePid(Environment.ProcessId);
            WriteArgs(argv);

            // UseShellExecute starts the child in its own process group: it
            // does not inherit the handles of the agent and survives it.
            var child = Process.Start(new ProcessStartInfo(exe, "--watchdog")
            {
                UseShellExecute = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            });
            child?.Dispose();
            Log.Info("watchdog started", new { pid = Environment.ProcessId });
        }
        catch (Exception ex)
        {
            Log.Warn("the watchdog could not be started", new { error = ex.Message });
        }
    }

    /// <summary>The watchdog loop. It never returns normally.</summary>
    public static int Run()
    {
        // The mutex is taken without asking for ownership and then taken
        // with a zero timeout: if the watchdog that owned it died without
        // releasing it (the session ended, the machine was reset), the wait
        // throws AbandonedMutexException and the mutex is ours. Without this
        // the mutex stayed abandoned and no watchdog could ever run again:
        // the agent died and nobody brought it back.
        using var mutex = new Mutex(false, MutexName);
        var owned = false;
        try
        {
            owned = mutex.WaitOne(0);
        }
        catch (AbandonedMutexException)
        {
            owned = true;
            Log.Info("watchdog: the previous watchdog did not release the mutex, taking it over");
        }
        if (!owned)
        {
            Log.Info("watchdog: another one is already running");
            return 0;
        }

        try
        {
            return Loop();
        }
        finally
        {
            try { mutex.ReleaseMutex(); } catch (Exception) { /* already gone */ }
        }
    }

    private static int Loop()
    {
        var exe = Environment.ProcessPath ?? "";
        Log.Info("watchdog: watching", new { pid = Environment.ProcessId });

        var quickRestarts = 0;
        while (true)
        {
            Thread.Sleep(2000);

            if (ConsumeStop())
            {
                Log.Info("watchdog: the agent was stopped on purpose, going away");
                return 0;
            }

            var pid = ReadPid();
            if (pid > 0 && IsAlive(pid)) { quickRestarts = 0; continue; }

            // The agent is missing. It may be an update in progress, which
            // replaces the executable and starts the new one: give it room
            // before starting another one.
            Thread.Sleep(GraceMs);
            if (ConsumeStop()) return 0;
            pid = ReadPid();
            if (pid > 0 && IsAlive(pid)) { quickRestarts = 0; continue; }

            // An agent that dies right after being started is not going to
            // do better on the next attempt (a token the hub rejects, for
            // example): after a few of those, stop and say why, instead of
            // looping forever.
            quickRestarts++;
            if (quickRestarts >= MaxQuickRestarts)
            {
                Log.Error("watchdog: the agent keeps dying right after starting, not starting it again",
                    new { attempts = quickRestarts, hint = "look at the last lines of the agent log" });
                return 0;
            }

            Log.Warn("watchdog: the agent is not running, starting it again", new { exe, attempt = quickRestarts });
            try
            {
                var args = ReadArgs();
                var child = Process.Start(new ProcessStartInfo(exe, args)
                {
                    UseShellExecute = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                });
                child?.Dispose();
                Log.Info("watchdog: the agent was started again");
            }
            catch (Exception ex)
            {
                Log.Error("watchdog: the agent could not be started", new { error = ex.Message });
            }
        }
    }

    /// <summary>How many times in a row the agent may die right after starting.</summary>
    private const int MaxQuickRestarts = 3;

    /// <summary>Asks the watchdog to stop (the agent is being closed on purpose).</summary>
    public static void AskStop()
    {
        try
        {
            Directory.CreateDirectory(Settings.LocalDir());
            File.WriteAllText(StopFile, DateTime.Now.ToString("o"));
        }
        catch (Exception ex)
        {
            Log.Debug("watchdog: the stop file could not be written", new { error = ex.Message });
        }
    }

    private static bool ConsumeStop()
    {
        try
        {
            if (!File.Exists(StopFile)) return false;
            File.Delete(StopFile);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static void WritePid(int pid)
    {
        try
        {
            Directory.CreateDirectory(Settings.LocalDir());
            File.WriteAllText(PidFile, pid.ToString());
        }
        catch (Exception ex)
        {
            Log.Debug("watchdog: the pid file could not be written", new { error = ex.Message });
        }
    }

    private static int ReadPid()
    {
        try
        {
            if (!File.Exists(PidFile)) return 0;
            return int.TryParse(File.ReadAllText(PidFile).Trim(), out var pid) ? pid : 0;
        }
        catch (Exception)
        {
            return 0;
        }
    }

    /// <summary>
    /// The arguments to start the agent again with. The token is left out on
    /// purpose: it is in the configuration file, protected with DPAPI.
    /// </summary>
    private static void WriteArgs(string[] argv)
    {
        try
        {
            var keep = new List<string>();
            for (var i = 0; i < argv.Length; i++)
            {
                var arg = argv[i];
                if (arg.StartsWith("--token", StringComparison.OrdinalIgnoreCase)) continue;
                if (arg.StartsWith("--watchdog", StringComparison.OrdinalIgnoreCase)) continue;
                if (arg.StartsWith("--name", StringComparison.OrdinalIgnoreCase) && i + 1 < argv.Length) { keep.Add(arg); keep.Add(argv[++i]); continue; }
                if (arg.StartsWith("--server", StringComparison.OrdinalIgnoreCase) && i + 1 < argv.Length) { keep.Add(arg); keep.Add(argv[++i]); continue; }
                if (arg.StartsWith("--config", StringComparison.OrdinalIgnoreCase) && i + 1 < argv.Length) { keep.Add(arg); keep.Add(argv[++i]); continue; }
                if (arg.StartsWith("--log-level", StringComparison.OrdinalIgnoreCase) && i + 1 < argv.Length) { keep.Add(arg); keep.Add(argv[++i]); continue; }
            }
            Directory.CreateDirectory(Settings.LocalDir());
            File.WriteAllText(ArgsFile, string.Join(" ", keep));
        }
        catch (Exception ex)
        {
            Log.Debug("watchdog: the args file could not be written", new { error = ex.Message });
        }
    }

    private static string ReadArgs()
    {
        try
        {
            if (!File.Exists(ArgsFile)) return "";
            return File.ReadAllText(ArgsFile).Trim();
        }
        catch (Exception)
        {
            return "";
        }
    }

    /// <summary>
    /// True when the pid belongs to a live agent. The name is checked too:
    /// Windows reuses pids quickly, and a reused pid would keep the watchdog
    /// from ever starting the agent again.
    /// </summary>
    private static bool IsAlive(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            if (process.HasExited) return false;
            var name = process.ProcessName;
            return name.StartsWith("rc-agent", StringComparison.OrdinalIgnoreCase);
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (Exception)
        {
            return false;
        }
    }
}
