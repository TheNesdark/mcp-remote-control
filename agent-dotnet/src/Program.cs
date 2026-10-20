using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Mrc.Agent;

/// <summary>
/// rc-agent entry point: parse flags, resolve settings, connect, keep the
/// process alive (tray when interactive) and shut down cleanly on exit.
/// </summary>
public static class Program
{
    [DllImport("kernel32.dll")]
    private static extern bool AttachConsole(int processId);

    [DllImport("kernel32.dll")]
    private static extern bool AllocConsole();

    [STAThread]
    public static int Main(string[] argv)
    {
        var args = CliArgs.Parse(argv);
        Log.SetLevel(args.LogLevel ?? Environment.GetEnvironmentVariable("MRC_LOG_LEVEL") ?? "info");

        // WinExe has no console of its own. Attaching to the parent's console
        // kept the launching .bat's CMD window open for as long as the agent
        // ran, so the agent stays detached and the logs live in the log file
        // (the tray's "Abrir logs" shows them). --console re-attaches for
        // anyone debugging from a terminal.
        if (args.Console)
        {
            if (!AttachConsole(-1)) AllocConsole();
        }

        // The watchdog is the same executable with --watchdog: it watches
        // the agent and starts it again when it dies.
        if (args.Watchdog)
        {
            Log.SetFile(Settings.DefaultLogFile());
            return Watchdog.Run();
        }

        var settings = Settings.Load(args);
        Log.SetFile(settings.LogFile);

        // First run with nothing configured: ask for name / server / token
        // before connecting, the same three things the tray's form asks for.
        if (Settings.NeedsFirstRun(args) && RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            try
            {
                using var firstRun = new SettingsForm();
                firstRun.Text = "rc-agent · Primer arranque";
                if (firstRun.ShowDialog() == DialogResult.OK)
                {
                    settings = Settings.Load(args);
                    Log.SetFile(settings.LogFile);
                }
            }
            catch (Exception ex)
            {
                Log.Error("the first-run form could not be shown", new { error = ex.Message });
            }
        }
        Log.Info("rc-agent starting", new { version = Versions.Current, name = settings.Name, server = settings.ServerUrl });

        // Somebody has to bring the agent back when it dies: the watchdog is
        // that somebody. It is started here and stops when the agent is
        // closed on purpose.
        Watchdog.Start(argv, !args.NoWatchdog);
        if (settings.UsingDefaultToken) Log.Warn("using the default dev token; pass --token or set MRC_TOKEN");

        AutoUpdate.Enabled = !args.NoAutoUpdate;

        var jobs = new JobManager(args.MaxJobs ?? 4, (msg, fields) => Log.Info(msg, fields));
        var connection = new AgentConnection(new AgentConnectionOptions
        {
            ServerUrl = settings.ServerUrl,
            Token = settings.Token,
            Name = settings.Name,
            Tags = settings.Tags,
            AgentId = settings.AgentId,
            Paused = settings.Paused,
        }, jobs);

        connection.OnWelcome += agentId =>
        {
            if (string.IsNullOrEmpty(settings.AgentId)) Settings.SetAgentId(agentId);
        };
        connection.OnFatal += reason =>
        {
            Log.Error("fatal connection error", new { reason });
            Environment.Exit(1);
        };

        Tray? tray = null;
        var trayWanted = args.TrayRequested || (!args.NoTray && RuntimeInformation.IsOSPlatform(OSPlatform.Windows));
        if (trayWanted)
        {
            tray = new Tray(connection);
            tray.OnExitRequested += () =>
            {
                Watchdog.AskStop();
                Environment.Exit(0);
            };
            // New settings only take effect on a fresh process: restart in place.
            SettingsForm.RestartRequested += () =>
            {
                try
                {
                    Restart.JobRestart(
                        System.Text.Json.JsonSerializer.SerializeToElement(new { }),
                        new JobContext("settings", _ => { }),
                        CancellationToken.None).GetAwaiter().GetResult();
                }
                catch (Exception ex)
                {
                    Log.Error("could not restart after the settings changed", new { error = ex.Message });
                }
            };
        }

        using var shutdown = new ManualResetEventSlim(false);
        void Shutdown(string reason, int code)
        {
            Log.Info("shutting down", new { reason });
            jobs.CancelAll();
            connection.StopAsync().Wait(TimeSpan.FromSeconds(3));
            tray?.Dispose();
            shutdown.Set();
            Environment.Exit(code);
        }

        AppDomain.CurrentDomain.ProcessExit += (_, _) => jobs.CancelAll();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            Shutdown("sigint", 0);
        };

        var runTask = connection.RunAsync();
        tray?.Start();

        if (tray is null)
        {
            // No tray: this is a console-ish run, so block on the connection
            // loop and dev commands from stdin (pause/resume/quit).
            _ = Task.Run(() => ReadStdin(connection, Shutdown));
        }
        else
        {
            Application.Run();
        }

        try
        {
            runTask.Wait();
        }
        catch (AggregateException ex) when (ex.InnerException is OperationCanceledException)
        {
            // normal shutdown
        }
        shutdown.Wait(TimeSpan.FromSeconds(2));
        return 0;
    }

    private static void ReadStdin(AgentConnection connection, Action<string, int> shutdown)
    {
        while (true)
        {
            var line = Console.ReadLine();
            if (line is null) return;
            switch (line.Trim().ToLowerInvariant())
            {
                case "pause":
                    connection.SetPaused(true);
                    break;
                case "resume":
                    connection.SetPaused(false);
                    break;
                case "quit":
                case "exit":
                    shutdown("stdin", 0);
                    return;
            }
        }
    }
}
