namespace Mrc.Agent;

/// <summary>
/// An error the caller can act on.
///
/// The hub forwards the code, the message and the hint as they are, so the
/// MCP client never has to guess what an empty message meant. The codes are
/// stable, so a script can branch on them.
/// </summary>
public sealed class ToolError : Exception
{
    /// <summary>Stable error code (see <see cref="Codes"/>).</summary>
    public string Code { get; }

    /// <summary>What the caller can do about it.</summary>
    public string? Hint { get; }

    public ToolError(string code, string message, string? hint = null) : base(message)
    {
        Code = code;
        Hint = hint;
    }

    /// <summary>The error as the meta of a failed job.</summary>
    public Dictionary<string, object?> ToMeta() => new()
    {
        ["ok"] = false,
        ["error"] = new Dictionary<string, object?>
        {
            ["code"] = Code,
            ["message"] = Message,
            ["hint"] = Hint ?? "",
        },
    };

    /// <summary>The catalog of codes, so the caller knows what to expect.</summary>
    public static class Codes
    {
        /// <summary>The Java application is not running any more.</summary>
        public const string JvmDied = "jvm_died";

        /// <summary>The Java Access Bridge is not loaded or did not answer.</summary>
        public const string BridgeUnavailable = "bridge_unavailable";

        /// <summary>The bridge took the application down before; not used with it.</summary>
        public const string BridgeHostile = "bridge_hostile";

        /// <summary>No element matched the given criteria.</summary>
        public const string ElementNotFound = "element_not_found";

        /// <summary>The window (hwnd or pid) does not resolve to a window.</summary>
        public const string WindowNotFound = "window_not_found";

        /// <summary>A wait ran out of time.</summary>
        public const string Timeout = "timeout";

        /// <summary>The parameters do not make sense.</summary>
        public const string InvalidArgs = "invalid_args";

        /// <summary>The feature does not exist for this application.</summary>
        public const string NotSupported = "not_supported";

        /// <summary>Anything else.</summary>
        public const string Internal = "internal";
    }

    /// <summary>Wraps an exception that is not already a <see cref="ToolError"/>.</summary>
    public static ToolError Wrap(Exception ex, string code = Codes.Internal) =>
        ex is ToolError te ? te : new ToolError(code, ex.Message);
}
