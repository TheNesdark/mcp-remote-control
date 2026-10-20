using System.Text.Json;

namespace Mrc.Agent;

/// <summary>
/// diagnose: a quick health report of the agent and of the machine it drives.
///
/// Everything that goes wrong with a remote desktop is answered by the same
/// three questions: is the agent alive, is the bridge to the Java application
/// usable, and is the application we are supposed to drive still there. This
/// job answers all three at once, so nobody has to read the log by hand.
/// </summary>
public static class Diagnose
{
    public static Task<JobOutcome> Job(JsonElement p, JobContext ctx, CancellationToken ct)
    {
        var report = new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["version"] = Versions.Current,
            ["uptimeSec"] = (long)(Environment.TickCount64 / 1000),
            ["pid"] = Environment.ProcessId,
            ["user"] = Environment.UserName,
            ["machine"] = Environment.MachineName,
            ["os"] = Environment.OSVersion.VersionString,
            ["dotnet"] = Environment.Version.ToString(),
            ["interactive"] = Environment.UserInteractive,
        };

        // The bridge: loaded? which library? is a Java window answering?
        report["bridge"] = Bridge();

        // The watchdog: without it a dead agent stays dead.
        report["watchdog"] = Watchdog.IsRunning();

        // The recording state (a clip half written is a common confusion).
        report["recording"] = Record.Status();

        // The windows of the desktop, so a caller can see what is open.
        var windows = new List<Dictionary<string, object?>>();
        foreach (var w in Win32.Enumerate())
        {
            if (!w.Visible || w.Width < 1 || w.Height < 1) continue;
            if (string.IsNullOrEmpty(w.Title) && !w.Class.StartsWith("SunAwt", StringComparison.OrdinalIgnoreCase)) continue;
            windows.Add(new Dictionary<string, object?>
            {
                ["hwnd"] = w.Hwnd,
                ["pid"] = w.Pid,
                ["process"] = w.Process,
                ["class"] = w.Class,
                ["title"] = w.Title,
                ["java"] = w.Class.StartsWith("SunAwt", StringComparison.OrdinalIgnoreCase),
            });
        }
        report["windows"] = windows;

        // The Java windows that are up: for each one, is the JVM answering?
        var java = new List<Dictionary<string, object?>>();
        foreach (var w in windows.Where(x => (bool)x["java"]!))
        {
            var hwnd = new IntPtr((long)w["hwnd"]!);
            var alive = JavaAccessBridge.TargetAlive(hwnd);
            var answering = alive && JavaAccessBridge.IsAvailable(hwnd);
            java.Add(new Dictionary<string, object?>
            {
                ["hwnd"] = w["hwnd"],
                ["title"] = w["title"],
                ["windowAlive"] = alive,
                ["bridgeAnswers"] = answering,
                ["note"] = answering ? "" : JavaAccessBridge.DescribeFailure(hwnd),
            });
        }
        report["java"] = java;

        // The last lines of the log: the last error is usually the answer.
        report["logTail"] = LogTail();

        return Task.FromResult(JobOutcome.Success(report));
    }

    private static Dictionary<string, object?> Bridge()
    {
        var state = new Dictionary<string, object?>
        {
            ["loaded"] = JavaAccessBridge.Loaded,
            ["library"] = JavaAccessBridge.BridgeLibraryPath ?? "",
        };
        return state;
    }

    private static List<string> LogTail()
    {
        var lines = new List<string>();
        try
        {
            var file = Settings.Current.LogFile ?? Settings.DefaultLogFile();
            if (!File.Exists(file)) return lines;
            var all = File.ReadAllLines(file);
            for (var i = Math.Max(0, all.Length - 15); i < all.Length; i++) lines.Add(all[i]);
        }
        catch (Exception)
        {
            // the log is a nicety, not the point of the job
        }
        return lines;
    }
}
