using System.Text.Json;

using Microsoft.Win32;

namespace Mrc.Agent;

/// <summary>
/// The settings of the agent, read and written from the outside.
///
/// The tray form already edits them, but only when somebody is sitting in
/// front of the machine. Reading and changing them over the wire is what
/// makes the agent manageable from another one: the name it registers with,
/// the hub it calls, the token it uses and whether it comes back on its own
/// at the next logon.
/// </summary>
public static class SettingsJob
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    public static Task<JobOutcome> Job(JsonElement p, JobContext ctx, CancellationToken ct)
    {
        var operation = Fs.ReadString(p, "operation") ?? "read";
        return Task.FromResult(operation switch
        {
            "read" => JobOutcome.Success(Read()),
            "write" => JobOutcome.Success(Write(p)),
            _ => throw new ToolError(ToolError.Codes.InvalidArgs,
                $"unknown operation '{operation}' (read or write)"),
        });
    }

    private static Dictionary<string, object?> Read()
    {
        var settings = Settings.Current;
        var config = Settings.ReadConfigFile();
        return new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["name"] = settings.Name,
            ["server"] = settings.ServerUrl,
            ["token"] = Mask(settings.Token),
            ["tags"] = settings.Tags,
            ["id"] = settings.AgentId ?? "",
            ["paused"] = settings.Paused,
            ["autostart"] = Autostart.IsEnabled(),
            ["autostart_command"] = RunCommand(),
            ["config_path"] = Settings.ConfigPath,
            ["version"] = Versions.Current,
            ["watchdog"] = Watchdog.IsRunning(),
            ["pid"] = Environment.ProcessId,
        };
    }

    private static Dictionary<string, object?> Write(JsonElement p)
    {
        var settings = Settings.Current;
        var name = Fs.ReadString(p, "name") ?? settings.Name;
        var server = Fs.ReadString(p, "server") ?? settings.ServerUrl;
        var token = Fs.ReadString(p, "token");
        var tags = Fs.ReadStringList(p, "tags");
        var autostart = Fs.ReadBool(p, "autostart");
        var changed = new List<string>();

        if (name != settings.Name) changed.Add("name");
        if (server != settings.ServerUrl) changed.Add("server");
        if (token is not null) changed.Add("token");
        if (tags is not null) changed.Add("tags");

        var config = Settings.ReadConfigFile();
        config.Name = name;
        config.Server = server;
        if (token is not null) config.TokenProtected = Dpapi.Protect(token);
        if (tags is not null) config.Tags = tags.ToArray();
        Settings.Save(config);

        // The Run key has to carry the new settings, or the agent would come
        // back with the old ones after the next logon.
        var exe = Environment.ProcessPath ?? "";
        if (!string.IsNullOrEmpty(exe) && !System.Text.RegularExpressions.Regex.IsMatch(exe, @"[/\\](dotnet|bun)(\.exe)?$"))
        {
            Autostart.SetCommand(exe, name, server, token ?? settings.Token);
        }

        if (autostart)
        {
            try { Autostart.SetEnabled(true); changed.Add("autostart"); }
            catch (Exception ex) { Log.Warn("the autostart could not be enabled", new { error = ex.Message }); }
        }
        else if (Autostart.IsEnabled())
        {
            Autostart.SetEnabled(false);
            changed.Add("autostart");
        }

        Log.Info("settings changed", new { changed = string.Join(",", changed), name, server });
        return new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["changed"] = changed,
            ["name"] = name,
            ["server"] = server,
            ["autostart"] = Autostart.IsEnabled(),
            ["restart_required"] = changed.Contains("name") || changed.Contains("server") || changed.Contains("token"),
        };
    }

    private static string RunCommand()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: false);
            return key?.GetValue(Autostart.AutostartName) as string ?? "";
        }
        catch (Exception)
        {
            return "";
        }
    }

    /// <summary>The token is never returned in full: only its shape.</summary>
    private static string Mask(string token)
    {
        if (string.IsNullOrEmpty(token)) return "";
        if (token.Length <= 8) return new string('*', token.Length);
        return token[..4] + new string('*', token.Length - 8) + token[^4..];
    }
}
