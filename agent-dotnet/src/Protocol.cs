using System.Text.Json;
using System.Text.Json.Serialization;

namespace Mrc.Agent;

/// <summary>
/// Wire constants shared with the hub (mirror of shared/protocol.ts).
/// </summary>
public static class Protocol
{
    public const int Version = 1;
    public const int DefaultWsPort = 8787;
    public const string AgentPath = "/agent";
    public const int HeartbeatIntervalMs = 10_000;
    public const int HeartbeatTimeoutMs = 30_000;
    public const int MaxFrameBytes = 1_048_576;
    public const long MaxJobOutputBytes = 1_048_576;
    public const int FsMaxChunkBytes = 512 * 1024;
    public const int FsDefaultChunkBytes = 256 * 1024;
    public const int MaxScreenshotBytes = 20 * 1024 * 1024;
    public const int MaxExecTimeoutMs = 3_600_000;
    public const int ScreenshotChunkChars = 256 * 1024;

    /// <summary>Job types the hub may ask for (mirror of JOB_TYPES).</summary>
    public static readonly string[] JobTypes =
    {
        "exec", "fs.list", "fs.read", "fs.write", "fs.hash", "info",
        "ps.list", "ps.kill", "screenshot", "restart", "cua", "browser",
        "record", "record.status",
    };

    /// <summary>Advertised capabilities (mirror of the TS CAPS list).</summary>
    public static readonly string[] Caps = { "exec", "fs", "info", "ps", "screenshot", "restart" };

    /// <summary>ws://host:8787 -> ws://host:8787/agent; explicit paths are kept.</summary>
    public static string NormalizeAgentUrl(string raw)
    {
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri))
            return raw;
        var builder = new UriBuilder(uri);
        if (string.IsNullOrEmpty(uri.AbsolutePath) || uri.AbsolutePath == "/")
            builder.Path = AgentPath;
        return builder.Uri.ToString();
    }
}

// ---------------------------------------------------------------------------
// Server -> agent
// ---------------------------------------------------------------------------

public sealed class WelcomeMsg
{
    public string AgentId { get; set; } = "";
    public long ServerTime { get; set; }
    public int HeartbeatIntervalMs { get; set; }
    public string? LatestAgentVersion { get; set; }
    public string? AgentBinaryUrl { get; set; }
    public string? AgentBinarySha256 { get; set; }
}

public sealed class JobRequestMsg
{
    public string JobId { get; set; } = "";
    public string JobType { get; set; } = "";
    public JsonElement Params { get; set; }
    public int TimeoutMs { get; set; }
}

public sealed class JobCancelMsg
{
    public string JobId { get; set; } = "";
}

// ---------------------------------------------------------------------------
// Agent -> server
// ---------------------------------------------------------------------------

public sealed class HelloMsg
{
    public string Type => "hello";
    public int Proto => Protocol.Version;
    public string Token { get; set; } = "";
    public string? AgentId { get; set; }
    public string Name { get; set; } = "";
    public string Host { get; set; } = "";
    public string Os { get; set; } = "";
    public string Version { get; set; } = "";
    public string[] Tags { get; set; } = Array.Empty<string>();
    public string[] Caps { get; set; } = Protocol.Caps;
    public bool Paused { get; set; }
}

public sealed class HeartbeatMsg
{
    public string Type => "heartbeat";
    public long Ts { get; set; }
}

public sealed class PresenceMsg
{
    public string Type => "presence";
    public bool Paused { get; set; }
}

public sealed class JobOutputMsg
{
    public string Type => "job.output";
    public string JobId { get; set; } = "";
    public string Stream { get; set; } = "stdout";
    public int Seq { get; set; }
    public string Data { get; set; } = "";
    public string Encoding { get; set; } = "utf8";
}

public sealed class JobResultMsg
{
    public string Type => "job.result";
    public string JobId { get; set; } = "";
    public bool Ok { get; set; }
    public int? ExitCode { get; set; }
    public long DurationMs { get; set; }
    public string? Error { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, object?>? Meta { get; set; }
}

// ---------------------------------------------------------------------------
// JSON settings
// ---------------------------------------------------------------------------

public static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        // The hub compares no bytes, but stable output keeps logs readable.
        WriteIndented = false,
    };

    /// <summary>Parses the "type" discriminator of a server frame (null when malformed).</summary>
    public static string? TypeOf(string raw)
    {
        try
        {
            using var doc = JsonDocument.Parse(raw);
            return doc.RootElement.TryGetProperty("type", out var t) ? t.GetString() : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static T? Deserialize<T>(string raw) where T : class
    {
        try
        {
            return JsonSerializer.Deserialize<T>(raw, Options);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);
}
