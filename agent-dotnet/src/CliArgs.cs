namespace Mrc.Agent;

/// <summary>
/// CLI parsing for the flags the TS agent accepted: --name/--server/--token/
/// --tags/--id/--paused/--config/--log-level/--max-jobs/--tray/--no-tray/
/// --no-auto-update/--tls-insecure. Bare flags are true; --flag=false|0|no
/// means false (same rule as shared/args.ts).
/// </summary>
public sealed class CliArgs
{
    private readonly Dictionary<string, string?> _values = new(StringComparer.Ordinal);

    public string? Name => Get("name");
    public string? Server => Get("server");
    public string? Token => Get("token");
    public string? Tags => Get("tags");
    public string? Id => Get("id");
    public string? Config => Get("config");
    public string? LogLevel => Get("log-level");
    public int? MaxJobs => int.TryParse(Get("max-jobs"), out var n) ? n : null;
    public bool? Paused => Flag("paused");
    public bool NoTray => Flag("no-tray") == true;
    public bool TrayRequested => Flag("tray") == true;
    public bool NoAutoUpdate => Flag("no-auto-update") == true;
    public bool TlsInsecure => Flag("tls-insecure") == true;
    /// <summary>Attach to the parent console (debugging); otherwise stay detached.</summary>
    public bool Console => Flag("console") == true;

    /// <summary>Runs as the watchdog instead of as the agent.</summary>
    public bool Watchdog => Flag("watchdog") == true;

    /// <summary>Do not start the watchdog.</summary>
    public bool NoWatchdog => Flag("no-watchdog") == true;

    public static CliArgs Parse(string[] argv)
    {
        var args = new CliArgs();
        for (var i = 0; i < argv.Length; i++)
        {
            var token = argv[i];
            if (!token.StartsWith("--", StringComparison.Ordinal)) continue;
            var key = token[2..];
            string? value = null;
            var eq = key.IndexOf('=');
            if (eq >= 0)
            {
                value = key[(eq + 1)..];
                key = key[..eq];
            }
            else if (i + 1 < argv.Length && !argv[i + 1].StartsWith("--", StringComparison.Ordinal))
            {
                value = argv[++i];
            }
            args._values[key] = value;
        }
        return args;
    }

    public string? Get(string key) =>
        _values.TryGetValue(key, out var value) && !string.IsNullOrEmpty(value) ? value : null;

    /// <summary>true / null when absent / false for explicit false-ish values.</summary>
    public bool? Flag(string key)
    {
        if (!_values.TryGetValue(key, out var value)) return null;
        if (value is null) return true;
        return value.ToLowerInvariant() switch
        {
            "false" or "0" or "no" => false,
            _ => true,
        };
    }
}
