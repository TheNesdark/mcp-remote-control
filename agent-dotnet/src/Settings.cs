using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Mrc.Agent;

/// <summary>
/// Agent settings: CLI flags > MRC_* env > baked-in defaults > agent.json.
/// Mirrors agent/src/settings.ts, including the DPAPI-protected token (native
/// here instead of shelling out to PowerShell like the TS agent did).
/// </summary>
public sealed class AgentSettings
{
    public string Name { get; init; } = "";
    public string ServerUrl { get; init; } = "";
    public string Token { get; init; } = "";
    public string[] Tags { get; init; } = Array.Empty<string>();
    public string? AgentId { get; init; }
    public bool Paused { get; init; }
    public string? LogFile { get; init; }
    public bool UsingDefaultToken { get; init; }
}

public sealed class ConfigFile
{
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("server")] public string? Server { get; set; }
    [JsonPropertyName("tokenProtected")] public string? TokenProtected { get; set; }
    [JsonPropertyName("token")] public string? Token { get; set; }
    [JsonPropertyName("tags")] public string[]? Tags { get; set; }
    [JsonPropertyName("id")] public string? Id { get; set; }
    [JsonPropertyName("paused")] public bool? Paused { get; set; }
    [JsonPropertyName("logFile")] public string? LogFile { get; set; }
}

public static class Settings
{
    public const string DefaultServer = "ws://127.0.0.1:8787";
    public const string DevToken = "dev-token";

    private static AgentSettings _current = new();
    private static string _configPath = "";

    public static AgentSettings Current => _current;
    public static string ConfigPath => _configPath;

    public static string DataDir()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        if (string.IsNullOrEmpty(appData)) appData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AppData", "Roaming");
        return Path.Combine(appData, "mcp-remote-control");
    }

    public static string DefaultLogFile() => Path.Combine(DataDir(), "logs", "agent.log");

    /// <summary>Resolves the layered settings and returns them (also cached).</summary>
    public static AgentSettings Load(CliArgs args)
    {
        _configPath = args.Config ?? Path.Combine(DataDir(), "agent.json");
        ConfigFile? file = null;
        try
        {
            if (File.Exists(_configPath))
                file = JsonSerializer.Deserialize<ConfigFile>(File.ReadAllText(_configPath));
        }
        catch (Exception ex)
        {
            Log.Warn("config file unreadable, ignoring", new { path = _configPath, error = ex.Message });
        }

        var name = FirstNonEmpty(args.Name, Environment.GetEnvironmentVariable("MRC_NAME"), BuiltIn.Name, file?.Name)
                   ?? Environment.MachineName;
        var server = FirstNonEmpty(args.Server, Environment.GetEnvironmentVariable("MRC_SERVER"), BuiltIn.Server, file?.Server)
                     ?? DefaultServer;
        var token = FirstNonEmpty(args.Token, Environment.GetEnvironmentVariable("MRC_TOKEN"), BuiltIn.Token, Unprotect(file))
                    ?? DevToken;

        var tags = ParseTags(args.Tags ?? Environment.GetEnvironmentVariable("MRC_TAGS") ?? JoinTags(file?.Tags));
        var logFile = ResolveLogFile(args, file);

        _current = new AgentSettings
        {
            Name = name,
            ServerUrl = server,
            Token = token,
            Tags = tags,
            AgentId = args.Id ?? file?.Id,
            Paused = args.Paused ?? file?.Paused ?? false,
            LogFile = logFile,
            UsingDefaultToken = token == DevToken,
        };
        return _current;
    }

    private static string? ResolveLogFile(CliArgs args, ConfigFile? file)
    {
        if (args.Config is not null) return null;
        var explicitPath = Environment.GetEnvironmentVariable("MRC_LOG_FILE");
        if (!string.IsNullOrEmpty(explicitPath)) return explicitPath;
        if (!string.IsNullOrEmpty(file?.LogFile)) return file!.LogFile;
        return DefaultLogFile();
    }

    private static string? Unprotect(ConfigFile? file)
    {
        if (file is null) return null;
        if (!string.IsNullOrEmpty(file.TokenProtected))
        {
            try
            {
                return Dpapi.Unprotect(file.TokenProtected);
            }
            catch (Exception ex)
            {
                Log.Warn("protected token could not be read", new { error = ex.Message });
            }
        }
        return file.Token;
    }

    /// <summary>Rewrites agent.json (id assignment from welcome, settings dialog).</summary>
    public static void Save(ConfigFile next)
    {
        try
        {
            var dir = Path.GetDirectoryName(_configPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            var json = JsonSerializer.Serialize(next, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(_configPath, json + Environment.NewLine, Encoding.UTF8);
            Log.Info("settings written", new { path = _configPath });
        }
        catch (Exception ex)
        {
            Log.Error("could not write settings", new { path = _configPath, error = ex.Message });
        }
    }

    public static void SetAgentId(string agentId)
    {
        ConfigFile next;
        try
        {
            next = File.Exists(_configPath)
                ? JsonSerializer.Deserialize<ConfigFile>(File.ReadAllText(_configPath)) ?? new ConfigFile()
                : new ConfigFile();
        }
        catch (Exception)
        {
            next = new ConfigFile();
        }
        next.Name = _current.Name;
        next.Server = _current.ServerUrl;
        next.Tags = _current.Tags;
        next.Id = agentId;
        if (next.TokenProtected is null && !_current.UsingDefaultToken)
        {
            next.TokenProtected = Dpapi.Protect(_current.Token);
            next.Token = null;
        }
        Save(next);
    }

    private static string? FirstNonEmpty(params string?[] values) =>
        values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));

    private static string JoinTags(string[]? tags) => tags is null ? "" : string.Join(",", tags);

    private static string[] ParseTags(string? raw) =>
        (raw ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Take(16)
            .ToArray();
}

/// <summary>Values baked in at build time (analogue of the MRC_BUILT_IN_* envs).</summary>
public static class BuiltIn
{
    public static readonly string? Name = Environment.GetEnvironmentVariable("MRC_BUILT_IN_NAME");
    public static readonly string? Server = Environment.GetEnvironmentVariable("MRC_BUILT_IN_SERVER");
    public static readonly string? Token = Environment.GetEnvironmentVariable("MRC_BUILT_IN_TOKEN");
}

/// <summary>DPAPI (CurrentUser scope): the token at rest, no PowerShell involved.</summary>
public static class Dpapi
{
    public static string Protect(string plain)
    {
        var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(plain), null, DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(bytes);
    }

    public static string Unprotect(string protectedBase64)
    {
        var bytes = ProtectedData.Unprotect(Convert.FromBase64String(protectedBase64), null, DataProtectionScope.CurrentUser);
        return Encoding.UTF8.GetString(bytes).Trim();
    }
}
