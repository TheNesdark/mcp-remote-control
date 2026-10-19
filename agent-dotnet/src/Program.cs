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

        // WinExe has no console by default: attach to the parent's when one
        // exists (bat launch, interactive run) so logs land in agent-stderr.txt.
        if (!AttachConsole(-1)) AllocConsole();

        var settings = Settings.Load(args);
        Log.SetFile(settings.LogFile);
        Log.Info("rc-agent starting", new { version = Versions.Current, name = settings.Name, server = settings.ServerUrl });
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
            tray.OnExitRequested += () => Environment.Exit(0);
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
